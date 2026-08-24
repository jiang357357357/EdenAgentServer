use mon_agent_connector_package::{LoadedPackage, PackageCatalog};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, RwLock},
};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorManifest {
    pub schema_version: u32,
    pub key: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub version: String,
    pub runtime: String,
    #[serde(default = "object_schema")]
    pub settings_schema: Value,
    #[serde(default)]
    pub events: BTreeMap<String, Value>,
    #[serde(default)]
    pub queries: BTreeMap<String, Value>,
    #[serde(default)]
    pub actions: BTreeMap<String, Value>,
}

#[derive(Clone)]
pub struct ManifestCatalog {
    root: Arc<PathBuf>,
    packages: Option<PackageCatalog>,
    plugin_packages: Arc<RwLock<BTreeMap<String, Vec<LoadedPackage>>>>,
    state: Arc<RwLock<CatalogState>>,
}

#[derive(Clone, Debug, PartialEq)]
struct CatalogState {
    manifests: BTreeMap<String, ConnectorManifest>,
    revision: String,
}

impl ManifestCatalog {
    pub fn load(root: PathBuf) -> Result<Self, String> {
        let plugin_packages = BTreeMap::new();
        let state = read_catalog(&root, None, &plugin_packages)?;
        Ok(Self {
            root: Arc::new(root),
            packages: None,
            plugin_packages: Arc::new(RwLock::new(plugin_packages)),
            state: Arc::new(RwLock::new(state)),
        })
    }

    pub fn load_with_packages(root: PathBuf, packages: PackageCatalog) -> Result<Self, String> {
        let plugin_packages = BTreeMap::new();
        let state = read_catalog(&root, Some(&packages), &plugin_packages)?;
        Ok(Self {
            root: Arc::new(root),
            packages: Some(packages),
            plugin_packages: Arc::new(RwLock::new(plugin_packages)),
            state: Arc::new(RwLock::new(state)),
        })
    }

    pub fn refresh(&self) -> Result<bool, String> {
        if let Some(packages) = &self.packages {
            packages.refresh().map_err(|error| error.to_string())?;
        }
        let plugin_packages = self
            .plugin_packages
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .clone();
        let refreshed = read_catalog(&self.root, self.packages.as_ref(), &plugin_packages)?;
        let mut current = self
            .state
            .write()
            .unwrap_or_else(|value| value.into_inner());
        if *current == refreshed {
            return Ok(false);
        }
        *current = refreshed;
        Ok(true)
    }

    pub fn set_plugin_packages(
        &self,
        plugin_id: &str,
        packages: Vec<LoadedPackage>,
    ) -> Result<bool, String> {
        if plugin_id.trim().is_empty() {
            return Err("plugin ID cannot be empty".to_owned());
        }
        let mut plugin_packages = self
            .plugin_packages
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .clone();
        plugin_packages.insert(plugin_id.to_owned(), packages);
        self.publish_plugin_packages(plugin_packages)
    }

    pub fn remove_plugin_packages(&self, plugin_id: &str) -> Result<bool, String> {
        let mut plugin_packages = self
            .plugin_packages
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .clone();
        if plugin_packages.remove(plugin_id).is_none() {
            return Ok(false);
        }
        self.publish_plugin_packages(plugin_packages)
    }

    fn publish_plugin_packages(
        &self,
        plugin_packages: BTreeMap<String, Vec<LoadedPackage>>,
    ) -> Result<bool, String> {
        let refreshed = read_catalog(&self.root, self.packages.as_ref(), &plugin_packages)?;
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|value| value.into_inner());
        let changed = *state != refreshed;
        *state = refreshed;
        *self
            .plugin_packages
            .write()
            .unwrap_or_else(|value| value.into_inner()) = plugin_packages;
        Ok(changed)
    }

    pub fn package(&self, key: &str) -> Option<LoadedPackage> {
        self.plugin_packages
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .values()
            .flatten()
            .find(|package| package.manifest.id == key)
            .cloned()
            .or_else(|| {
                self.packages
                    .as_ref()
                    .and_then(|packages| packages.get(key))
            })
    }

    pub fn plugin_owner(&self, key: &str) -> Option<String> {
        self.plugin_packages
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .iter()
            .find_map(|(plugin_id, packages)| {
                packages
                    .iter()
                    .any(|package| package.manifest.id == key)
                    .then(|| plugin_id.clone())
            })
    }

    pub fn contains(&self, key: &str) -> bool {
        self.state
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .manifests
            .contains_key(key)
    }

    pub fn validate_settings(&self, key: &str, settings: &Value) -> Result<(), String> {
        let state = self.state.read().unwrap_or_else(|value| value.into_inner());
        let manifest = state
            .manifests
            .get(key)
            .ok_or_else(|| format!("unknown connector type: {key}"))?;
        validate_schema(&manifest.settings_schema, settings, "settings")
    }

    pub fn validate_action(&self, key: &str, action: &str, payload: &Value) -> Result<(), String> {
        let state = self.state.read().unwrap_or_else(|value| value.into_inner());
        let manifest = state
            .manifests
            .get(key)
            .ok_or_else(|| format!("unknown connector type: {key}"))?;
        let schema = manifest
            .actions
            .get(action)
            .ok_or_else(|| format!("connector {key} does not declare action {action}"))?;
        validate_schema(schema, payload, "payload")
    }

    pub fn validate_query(&self, key: &str, query: &str, payload: &Value) -> Result<(), String> {
        let state = self.state.read().unwrap_or_else(|value| value.into_inner());
        let manifest = state
            .manifests
            .get(key)
            .ok_or_else(|| format!("unknown connector type: {key}"))?;
        let schema = manifest
            .queries
            .get(query)
            .ok_or_else(|| format!("connector {key} does not declare query {query}"))?;
        validate_schema(schema, payload, "query")
    }

    pub fn registration_tool_schema(&self) -> Value {
        let state = self.state.read().unwrap_or_else(|value| value.into_inner());
        let connector_keys = state.manifests.keys().cloned().collect::<Vec<_>>();
        let settings_properties = merged_properties(
            state
                .manifests
                .values()
                .map(|manifest| &manifest.settings_schema),
        );
        json!({
            "type":"object",
            "properties":{
                "connectorKey":{"type":"string","enum":connector_keys},
                "identityKey":{"type":"string","minLength":1,"maxLength":128},
                "displayName":{"type":"string","maxLength":256},
                "desiredState":{"type":"string","enum":["connected","disconnected"]},
                "settings":{"type":"object","properties":settings_properties,"additionalProperties":true}
            },
            "required":["connectorKey","identityKey"],
            "additionalProperties":false
        })
    }

    pub fn action_tool_schema(&self) -> Value {
        let state = self.state.read().unwrap_or_else(|value| value.into_inner());
        let mut action_names = state
            .manifests
            .values()
            .flat_map(|manifest| manifest.actions.keys().cloned())
            .collect::<Vec<_>>();
        action_names.sort();
        action_names.dedup();
        let payload_properties = merged_properties(
            state
                .manifests
                .values()
                .flat_map(|manifest| manifest.actions.values()),
        );
        json!({
            "type":"object",
            "properties":{
                "connectorId":{"type":"string","format":"uuid"},
                "action":{"type":"string","enum":action_names},
                "payload":{"type":"object","properties":payload_properties,"additionalProperties":true}
            },
            "required":["connectorId","action","payload"],
            "additionalProperties":false
        })
    }

    pub fn query_tool_schema(&self) -> Value {
        let state = self.state.read().unwrap_or_else(|value| value.into_inner());
        let mut query_names = state
            .manifests
            .values()
            .flat_map(|manifest| manifest.queries.keys().cloned())
            .collect::<Vec<_>>();
        query_names.sort();
        query_names.dedup();
        let payload_properties = merged_properties(
            state
                .manifests
                .values()
                .flat_map(|manifest| manifest.queries.values()),
        );
        json!({
            "type":"object",
            "properties":{
                "connectorId":{"type":"string","format":"uuid"},
                "query":{"type":"string","enum":query_names},
                "payload":{"type":"object","properties":payload_properties,"additionalProperties":true}
            },
            "required":["connectorId","query","payload"],
            "additionalProperties":false
        })
    }

    pub fn model_contract(&self, key: &str) -> Option<Value> {
        let state = self.state.read().unwrap_or_else(|value| value.into_inner());
        let manifest = state.manifests.get(key)?;
        Some(json!({
            "manifestVersion":manifest.version.clone(),
            "revision":state.revision,
            "hotReload":true,
            "workerIsolated":true,
            "eventSchemas":manifest.events.clone(),
            "querySchemas":manifest.queries.clone(),
            "actionSchemas":manifest.actions.clone(),
        }))
    }

    pub fn catalog_json(&self) -> Value {
        let state = self.state.read().unwrap_or_else(|value| value.into_inner());
        let connectors = state
            .manifests
            .values()
            .map(|manifest| {
                let mut capabilities = Vec::new();
                capabilities.extend(
                    manifest
                        .events
                        .iter()
                        .map(|(id, value)| capability(id, "event", "input", value)),
                );
                capabilities.extend(
                    manifest
                        .queries
                        .iter()
                        .map(|(id, value)| capability(id, "query", "output", value)),
                );
                capabilities.extend(
                    manifest
                        .actions
                        .iter()
                        .map(|(id, value)| capability(id, "action", "output", value)),
                );
                json!({
                    "key":manifest.key,
                    "name":manifest.name,
                    "description":manifest.description,
                    "icon":manifest.icon,
                    "version":manifest.version,
                    "revision":state.revision,
                    "hot_reload":true,
                    "worker_isolated":true,
                    "settings_schema":manifest.settings_schema,
                    "capabilities":capabilities,
                })
            })
            .collect::<Vec<_>>();
        let errors = self
            .packages
            .as_ref()
            .map(|packages| {
                packages
                    .errors()
                    .into_iter()
                    .map(|error| json!({"key":error.key,"error":error.error}))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        json!({"connectors":connectors,"errors":errors})
    }

    pub fn describe_json(&self, key: &str) -> Option<Value> {
        self.catalog_json()
            .get("connectors")?
            .as_array()?
            .iter()
            .find(|entry| entry.get("key").and_then(Value::as_str) == Some(key))
            .cloned()
    }
}

fn merged_properties<'a>(schemas: impl IntoIterator<Item = &'a Value>) -> BTreeMap<String, Value> {
    let mut properties = BTreeMap::new();
    for schema in schemas {
        let Some(children) = schema.get("properties").and_then(Value::as_object) else {
            continue;
        };
        for (key, child) in children {
            properties
                .entry(key.clone())
                .or_insert_with(|| child.clone());
        }
    }
    properties
}

fn capability(id: &str, kind: &str, direction: &str, value: &Value) -> Value {
    let invocation = value
        .get("x-monagent-invocation")
        .cloned()
        .unwrap_or_else(|| {
            if kind == "action" {
                json!({"tool":"execute_connector_action","action":id})
            } else if kind == "query" {
                json!({"tool":"query_connector","query":id})
            } else {
                Value::Null
            }
        });
    json!({
        "id":id,
        "kind":kind,
        "direction":direction,
        "label":value.get("title").and_then(Value::as_str).unwrap_or(id),
        "description":value.get("description").and_then(Value::as_str).unwrap_or(""),
        "schema":if kind == "event" { json!({}) } else { value.clone() },
        "invocation":invocation,
    })
}

fn read_catalog(
    root: &Path,
    packages: Option<&PackageCatalog>,
    plugin_packages: &BTreeMap<String, Vec<LoadedPackage>>,
) -> Result<CatalogState, String> {
    let mut paths = fs::read_dir(root)
        .map_err(|error| {
            format!(
                "cannot read connector manifest directory {}: {error}",
                root.display()
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    paths.sort();
    let mut manifests = BTreeMap::new();
    let mut standalone_package_revisions = BTreeMap::new();
    let mut digest = Sha256::new();
    for path in paths {
        let bytes = fs::read(&path).map_err(|error| error.to_string())?;
        digest.update(
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .as_bytes(),
        );
        digest.update(&bytes);
        let manifest: ConnectorManifest = serde_json::from_slice(&bytes)
            .map_err(|error| format!("invalid connector manifest {}: {error}", path.display()))?;
        if manifest.schema_version != 1 || manifest.key.trim().is_empty() {
            return Err(format!("unsupported connector manifest {}", path.display()));
        }
        if path.file_stem().and_then(|value| value.to_str()) != Some(manifest.key.as_str()) {
            return Err(format!(
                "connector key does not match filename: {}",
                path.display()
            ));
        }
        if manifests.insert(manifest.key.clone(), manifest).is_some() {
            return Err(format!("duplicate connector manifest: {}", path.display()));
        }
    }
    if let Some(packages) = packages {
        digest.update(b"connector-packages");
        digest.update(packages.revision().as_bytes());
        for package in packages.packages() {
            let manifest = ConnectorManifest {
                schema_version: package.manifest.schema_version,
                key: package.manifest.id.clone(),
                name: package.manifest.name.clone(),
                description: package.manifest.description.clone(),
                icon: package.manifest.icon.clone(),
                version: package.manifest.version.clone(),
                runtime: "external-worker".to_owned(),
                settings_schema: package.manifest.settings_schema.clone(),
                events: package.manifest.events.clone(),
                queries: package.manifest.queries.clone(),
                actions: package.manifest.actions.clone(),
            };
            if manifests.insert(manifest.key.clone(), manifest).is_some() {
                return Err(format!(
                    "duplicate connector package ID: {}",
                    package.manifest.id
                ));
            }
            standalone_package_revisions
                .insert(package.manifest.id.clone(), package.revision.clone());
        }
    }
    digest.update(b"plugin-connector-packages");
    for (plugin_id, packages) in plugin_packages {
        digest.update(plugin_id.as_bytes());
        for package in packages {
            digest.update(package.manifest.id.as_bytes());
            digest.update(package.revision.as_bytes());
            let manifest = ConnectorManifest {
                schema_version: package.manifest.schema_version,
                key: package.manifest.id.clone(),
                name: package.manifest.name.clone(),
                description: package.manifest.description.clone(),
                icon: package.manifest.icon.clone(),
                version: package.manifest.version.clone(),
                runtime: "external-worker".to_owned(),
                settings_schema: package.manifest.settings_schema.clone(),
                events: package.manifest.events.clone(),
                queries: package.manifest.queries.clone(),
                actions: package.manifest.actions.clone(),
            };
            if manifests.insert(manifest.key.clone(), manifest).is_some() {
                let same_compatibility_package = standalone_package_revisions
                    .remove(&package.manifest.id)
                    .is_some_and(|revision| revision == package.revision);
                if !same_compatibility_package {
                    return Err(format!(
                        "plugin {plugin_id} declares duplicate connector package ID: {}",
                        package.manifest.id
                    ));
                }
            }
        }
    }
    let revision = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(CatalogState {
        manifests,
        revision,
    })
}

fn object_schema() -> Value {
    json!({"type":"object","additionalProperties":true})
}

fn validate_schema(schema: &Value, value: &Value, path: &str) -> Result<(), String> {
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
        if !allowed.contains(value) {
            return Err(format!("{path} is not an allowed value"));
        }
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("object") => {
            let object = value
                .as_object()
                .ok_or_else(|| format!("{path} must be an object"))?;
            let properties = schema
                .get("properties")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for required in schema
                .get("required")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if !object.contains_key(required) {
                    return Err(format!("{path}.{required} is required"));
                }
            }
            if schema.get("additionalProperties").and_then(Value::as_bool) == Some(false) {
                if let Some(unknown) = object.keys().find(|key| !properties.contains_key(*key)) {
                    return Err(format!("{path}.{unknown} is not allowed"));
                }
            }
            for (key, child) in object {
                if let Some(child_schema) = properties.get(key) {
                    validate_schema(child_schema, child, &format!("{path}.{key}"))?;
                }
            }
        }
        Some("array") => {
            let values = value
                .as_array()
                .ok_or_else(|| format!("{path} must be an array"))?;
            if let Some(minimum) = schema.get("minItems").and_then(Value::as_u64) {
                if values.len() < minimum as usize {
                    return Err(format!("{path} has too few items"));
                }
            }
            if let Some(maximum) = schema.get("maxItems").and_then(Value::as_u64) {
                if values.len() > maximum as usize {
                    return Err(format!("{path} has too many items"));
                }
            }
            if let Some(item_schema) = schema.get("items") {
                for (index, item) in values.iter().enumerate() {
                    validate_schema(item_schema, item, &format!("{path}[{index}]"))?;
                }
            }
        }
        Some("string") if !value.is_string() => return Err(format!("{path} must be a string")),
        Some("boolean") if !value.is_boolean() => return Err(format!("{path} must be a boolean")),
        Some("integer") if !value.is_i64() && !value.is_u64() => {
            return Err(format!("{path} must be an integer"));
        }
        Some("number") if !value.is_number() => return Err(format!("{path} must be a number")),
        _ => {}
    }
    if let Some(minimum) = schema.get("minLength").and_then(Value::as_u64) {
        if value
            .as_str()
            .is_some_and(|text| text.chars().count() < minimum as usize)
        {
            return Err(format!("{path} is too short"));
        }
    }
    if let Some(maximum) = schema.get("maxLength").and_then(Value::as_u64) {
        if value
            .as_str()
            .is_some_and(|text| text.chars().count() > maximum as usize)
        {
            return Err(format!("{path} is too long"));
        }
    }
    if let Some(minimum) = schema.get("minimum").and_then(Value::as_f64)
        && value.as_f64().is_some_and(|number| number < minimum)
    {
        return Err(format!("{path} is below the minimum"));
    }
    if let Some(maximum) = schema.get("maximum").and_then(Value::as_f64)
        && value.as_f64().is_some_and(|number| number > maximum)
    {
        return Err(format!("{path} is above the maximum"));
    }
    if let Some(pattern) = schema.get("pattern").and_then(Value::as_str)
        && let Some(text) = value.as_str()
    {
        let pattern = Regex::new(pattern)
            .map_err(|error| format!("{path} schema has an invalid pattern: {error}"))?;
        if !pattern.is_match(text) {
            return Err(format!("{path} does not match the required pattern"));
        }
    }
    if schema.get("format").and_then(Value::as_str) == Some("uuid")
        && value
            .as_str()
            .is_some_and(|text| uuid::Uuid::parse_str(text).is_err())
    {
        return Err(format!("{path} must be a UUID"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_fields_and_missing_required_values() {
        let schema = json!({"type":"object","required":["name"],"properties":{"name":{"type":"string","minLength":1}},"additionalProperties":false});
        assert!(validate_schema(&schema, &json!({}), "payload").is_err());
        assert!(validate_schema(&schema, &json!({"name":"","extra":1}), "payload").is_err());
        assert!(validate_schema(&schema, &json!({"name":"ok"}), "payload").is_ok());
    }

    #[test]
    fn enforces_declared_string_numeric_pattern_and_uuid_constraints() {
        let schema = json!({
            "type":"object",
            "properties":{
                "port":{"type":"integer","minimum":1,"maximum":65535},
                "name":{"type":"string","minLength":2,"maxLength":4,"pattern":"^[A-Z]+$"},
                "session":{"type":"string","format":"uuid"}
            },
            "required":["port","name","session"],
            "additionalProperties":false
        });
        assert!(
            validate_schema(
                &schema,
                &json!({
                    "port":40092,
                    "name":"MON",
                    "session":"018f3f43-7b8a-7fd2-9123-123456789abc"
                }),
                "settings",
            )
            .is_ok()
        );
        for invalid in [
            json!({"port":0,"name":"MON","session":"018f3f43-7b8a-7fd2-9123-123456789abc"}),
            json!({"port":70000,"name":"MON","session":"018f3f43-7b8a-7fd2-9123-123456789abc"}),
            json!({"port":40092,"name":"mon","session":"018f3f43-7b8a-7fd2-9123-123456789abc"}),
            json!({"port":40092,"name":"MONAGENT","session":"018f3f43-7b8a-7fd2-9123-123456789abc"}),
            json!({"port":40092,"name":"MON","session":"not-a-uuid"}),
        ] {
            assert!(validate_schema(&schema, &invalid, "settings").is_err());
        }
    }

    #[test]
    fn empty_catalog_starts_closed_and_accepts_later_plugin_packages() {
        let root = tempfile::tempdir().expect("manifest root");
        let catalog = ManifestCatalog::load(root.path().to_owned()).expect("empty catalog");
        assert!(!catalog.contains("unknown"));
        assert!(catalog.validate_settings("unknown", &json!({})).is_err());
        assert!(!catalog.refresh().expect("stable empty refresh"));
    }

    #[test]
    fn catalog_reloads_valid_manifests_and_keeps_unknown_types_closed() {
        let root = tempfile::tempdir().expect("manifest root");
        let path = root.path().join("demo.json");
        let manifest = |version: &str| {
            json!({
                "schemaVersion":1,
                "key":"demo",
                "name":"Demo",
                "description":"Demo connector",
                "icon":"cable",
                "version":version,
                "runtime":"test",
                "settingsSchema":{"type":"object","additionalProperties":false},
                "events":{},
                "queries":{},
                "actions":{"run":{"type":"object","properties":{},"additionalProperties":false}}
            })
        };
        fs::write(&path, serde_json::to_vec(&manifest("1")).expect("json")).expect("manifest");
        let catalog = ManifestCatalog::load(root.path().to_owned()).expect("catalog");
        assert!(catalog.contains("demo"));
        assert!(!catalog.contains("unknown"));
        assert!(catalog.validate_settings("unknown", &json!({})).is_err());
        assert!(
            catalog
                .validate_action("demo", "missing", &json!({}))
                .is_err()
        );
        fs::write(&path, serde_json::to_vec(&manifest("2")).expect("json")).expect("update");
        assert!(catalog.refresh().expect("refresh"));
        assert!(!catalog.refresh().expect("stable refresh"));
    }

    #[test]
    fn plugin_connector_packages_are_atomic_and_collision_checked() {
        let root = tempfile::tempdir().expect("manifest root");
        fs::write(
            root.path().join("demo.json"),
            serde_json::to_vec(&json!({
                "schemaVersion":1,
                "key":"demo",
                "name":"Demo",
                "description":"Demo connector",
                "icon":"cable",
                "version":"1",
                "runtime":"test",
                "settingsSchema":{"type":"object","additionalProperties":false},
                "events":{},"queries":{},"actions":{}
            }))
            .expect("base manifest"),
        )
        .expect("base manifest");
        let catalog = ManifestCatalog::load(root.path().to_owned()).expect("catalog");
        let package_root = tempfile::tempdir().expect("package");
        fs::write(package_root.path().join("worker"), b"worker").expect("worker");
        let write_package = |id: &str| {
            fs::write(
                package_root.path().join("connector.json"),
                serde_json::to_vec(&json!({
                    "schemaVersion":1,
                    "id":id,
                    "name":"Plugin Worker",
                    "description":"plugin worker",
                    "version":"1.0.0",
                    "protocolVersion":1,
                    "icon":"cable",
                    "entrypoints":{
                        mon_agent_connector_package::current_platform():{
                            "path":"worker","args":[]
                        }
                    },
                    "settingsSchema":{"type":"object","properties":{},"additionalProperties":false},
                    "events":{},"queries":{},"actions":{}
                }))
                .expect("package manifest"),
            )
            .expect("package manifest");
            LoadedPackage::load(
                package_root.path(),
                mon_agent_connector_package::LoadPolicy::Development,
            )
            .expect("loaded package")
        };

        let package = write_package("plugin-worker");
        assert!(
            catalog
                .set_plugin_packages("mon.plugin", vec![package])
                .expect("plugin package")
        );
        assert!(catalog.contains("plugin-worker"));
        assert!(catalog.package("plugin-worker").is_some());

        let collision = write_package("demo");
        assert!(
            catalog
                .set_plugin_packages("mon.collision", vec![collision])
                .is_err()
        );
        assert!(catalog.contains("plugin-worker"));
        assert!(
            catalog
                .remove_plugin_packages("mon.plugin")
                .expect("remove")
        );
        assert!(!catalog.contains("plugin-worker"));
    }

    #[test]
    fn identical_plugin_bundle_can_shadow_its_standalone_compatibility_package() {
        let manifests = tempfile::tempdir().expect("manifest root");
        let packages_root = tempfile::tempdir().expect("packages root");
        let package_root = packages_root.path().join("dual");
        fs::create_dir(&package_root).expect("package root");
        fs::write(package_root.join("worker"), b"worker").expect("worker");
        fs::write(
            package_root.join("connector.json"),
            serde_json::to_vec(&json!({
                "schemaVersion":1,"id":"dual","name":"Dual","description":"dual bundle",
                "version":"1.0.0","protocolVersion":1,"icon":"cable",
                "entrypoints":{mon_agent_connector_package::current_platform():{"path":"worker","args":[]}},
                "settingsSchema":{"type":"object","additionalProperties":false},
                "events":{},"queries":{},"actions":{}
            }))
            .expect("manifest"),
        )
        .expect("manifest");
        let packages = PackageCatalog::load(
            packages_root.path().to_path_buf(),
            mon_agent_connector_package::LoadPolicy::Development,
        )
        .expect("package catalog");
        let catalog = ManifestCatalog::load_with_packages(manifests.path().to_path_buf(), packages)
            .expect("manifest catalog");
        let same = LoadedPackage::load(
            &package_root,
            mon_agent_connector_package::LoadPolicy::Development,
        )
        .expect("same package");
        assert!(
            catalog
                .set_plugin_packages("official.dual", vec![same])
                .expect("identical plugin overlay")
        );
        assert_eq!(
            catalog.plugin_owner("dual").as_deref(),
            Some("official.dual")
        );
    }
}
