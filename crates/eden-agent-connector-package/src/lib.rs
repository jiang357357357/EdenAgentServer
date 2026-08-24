//! Connector package discovery, validation, and path confinement.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, RwLock},
};
use thiserror::Error;

pub const PACKAGE_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoadPolicy {
    Development,
    Production,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectorPackageManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub protocol_version: u32,
    pub icon: String,
    pub entrypoints: BTreeMap<String, WorkerEntrypoint>,
    #[serde(default = "object_schema")]
    pub settings_schema: Value,
    #[serde(default)]
    pub permissions: Vec<PermissionDeclaration>,
    #[serde(default)]
    pub events: BTreeMap<String, Value>,
    #[serde(default)]
    pub queries: BTreeMap<String, Value>,
    #[serde(default)]
    pub actions: BTreeMap<String, Value>,
    #[serde(default)]
    pub assets: Vec<PackageAsset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerEntrypoint {
    pub path: String,
    #[serde(default)]
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionDeclaration {
    pub capability: String,
    pub resource: String,
    pub access: String,
    #[serde(default)]
    pub required: bool,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackageAsset {
    pub source: String,
    pub target_kind: String,
    pub target: String,
}

#[derive(Clone, Debug)]
pub struct LoadedPackage {
    pub root: PathBuf,
    pub manifest: ConnectorPackageManifest,
    pub revision: String,
    pub integrity: IntegrityState,
}

#[derive(Clone)]
pub struct PackageCatalog {
    root: Arc<PathBuf>,
    policy: LoadPolicy,
    state: Arc<RwLock<PackageCatalogState>>,
}

#[derive(Clone, Debug)]
struct PackageCatalogState {
    packages: BTreeMap<String, LoadedPackage>,
    errors: Vec<PackageCatalogError>,
    revision: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageCatalogError {
    pub key: String,
    pub error: String,
}

impl PackageCatalog {
    pub fn load(root: PathBuf, policy: LoadPolicy) -> Result<Self, PackageError> {
        fs::create_dir_all(&root)?;
        let root = fs::canonicalize(root)?;
        let state = read_package_catalog(&root, policy)?;
        Ok(Self {
            root: Arc::new(root),
            policy,
            state: Arc::new(RwLock::new(state)),
        })
    }

    pub fn refresh(&self) -> Result<bool, PackageError> {
        let refreshed = read_package_catalog(&self.root, self.policy)?;
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.revision == refreshed.revision {
            return Ok(false);
        }
        *state = refreshed;
        Ok(true)
    }

    #[must_use]
    pub fn get(&self, id: &str) -> Option<LoadedPackage> {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .packages
            .get(id)
            .cloned()
    }

    #[must_use]
    pub fn packages(&self) -> Vec<LoadedPackage> {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .packages
            .values()
            .cloned()
            .collect()
    }

    #[must_use]
    pub fn revision(&self) -> String {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .revision
            .clone()
    }

    #[must_use]
    pub fn errors(&self) -> Vec<PackageCatalogError> {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .errors
            .clone()
    }
}

impl LoadedPackage {
    pub fn load(root: impl AsRef<Path>, policy: LoadPolicy) -> Result<Self, PackageError> {
        let root = fs::canonicalize(root.as_ref()).map_err(PackageError::Io)?;
        if !root.is_dir() {
            return Err(PackageError::Invalid(
                "package root must be a directory".to_owned(),
            ));
        }
        let manifest_path = root.join("connector.json");
        let manifest_bytes = fs::read(&manifest_path).map_err(PackageError::Io)?;
        let manifest: ConnectorPackageManifest = serde_json::from_slice(&manifest_bytes)?;
        validate_manifest(&manifest)?;
        let integrity = verify_integrity(&root, policy)?;
        let mut digest = Sha256::new();
        digest.update(&manifest_bytes);
        digest.update(integrity.revision_material());
        Ok(Self {
            root,
            manifest,
            revision: hex::encode(digest.finalize()),
            integrity,
        })
    }

    pub fn entrypoint(&self, platform: &str) -> Result<ResolvedEntrypoint, PackageError> {
        let entrypoint = self
            .manifest
            .entrypoints
            .get(platform)
            .ok_or_else(|| PackageError::UnsupportedPlatform(platform.to_owned()))?;
        let executable = resolve_package_file(&self.root, &entrypoint.path)?;
        Ok(ResolvedEntrypoint {
            executable,
            args: entrypoint.args.clone(),
        })
    }

    pub fn current_entrypoint(&self) -> Result<ResolvedEntrypoint, PackageError> {
        self.entrypoint(&current_platform())
    }
}

#[derive(Clone, Debug)]
pub struct ResolvedEntrypoint {
    pub executable: PathBuf,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IntegrityState {
    Verified { files: usize, digest: String },
    UnverifiedDevelopment,
}

impl IntegrityState {
    fn revision_material(&self) -> &[u8] {
        match self {
            Self::Verified { digest, .. } => digest.as_bytes(),
            Self::UnverifiedDevelopment => b"development-unverified",
        }
    }
}

#[derive(Debug, Error)]
pub enum PackageError {
    #[error("connector package I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("connector package manifest is invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("connector package is invalid: {0}")]
    Invalid(String),
    #[error("connector package path escapes its root: {0}")]
    PathEscape(String),
    #[error("connector package does not support platform {0}")]
    UnsupportedPlatform(String),
    #[error("connector package integrity metadata is required in production")]
    IntegrityRequired,
    #[error("connector package checksum mismatch: {0}")]
    ChecksumMismatch(String),
    #[error("connector package contains an undeclared or unsafe file: {0}")]
    UndeclaredFile(String),
}

#[must_use]
pub fn current_platform() -> String {
    let os = std::env::consts::OS;
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        value => value,
    };
    format!("{os}-{arch}")
}

fn validate_manifest(manifest: &ConnectorPackageManifest) -> Result<(), PackageError> {
    if manifest.schema_version != PACKAGE_SCHEMA_VERSION {
        return Err(PackageError::Invalid(format!(
            "unsupported schema version {}",
            manifest.schema_version
        )));
    }
    if manifest.protocol_version == 0 {
        return Err(PackageError::Invalid(
            "protocolVersion must be positive".to_owned(),
        ));
    }
    let id_pattern =
        Regex::new(r"^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$").expect("static connector ID pattern");
    if !id_pattern.is_match(&manifest.id) {
        return Err(PackageError::Invalid(format!(
            "invalid connector ID {}",
            manifest.id
        )));
    }
    let version_pattern = Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
        .expect("static version pattern");
    if !version_pattern.is_match(&manifest.version) {
        return Err(PackageError::Invalid(format!(
            "invalid package version {}",
            manifest.version
        )));
    }
    if manifest.name.trim().is_empty() || manifest.description.trim().is_empty() {
        return Err(PackageError::Invalid(
            "name and description are required".to_owned(),
        ));
    }
    if manifest.entrypoints.is_empty() {
        return Err(PackageError::Invalid(
            "at least one worker entrypoint is required".to_owned(),
        ));
    }
    for (platform, entrypoint) in &manifest.entrypoints {
        if platform.trim().is_empty() {
            return Err(PackageError::Invalid(
                "entrypoint platform cannot be empty".to_owned(),
            ));
        }
        validate_relative_path(&entrypoint.path)?;
        if entrypoint
            .args
            .iter()
            .any(|argument| argument.contains('\0'))
        {
            return Err(PackageError::Invalid(
                "entrypoint argument contains a null byte".to_owned(),
            ));
        }
    }
    validate_object_schema(&manifest.settings_schema, "settingsSchema")?;
    for (name, schema) in manifest.queries.iter().chain(&manifest.actions) {
        validate_capability_name(name)?;
        validate_object_schema(schema, name)?;
    }
    for name in manifest.events.keys() {
        validate_capability_name(name)?;
    }
    for asset in &manifest.assets {
        validate_relative_path(&asset.source)?;
        if asset.target_kind.trim().is_empty() || asset.target.trim().is_empty() {
            return Err(PackageError::Invalid(
                "asset targetKind and target are required".to_owned(),
            ));
        }
    }
    if let Some(skill) = &manifest.skill {
        validate_relative_path(skill)?;
    }
    Ok(())
}

fn validate_capability_name(name: &str) -> Result<(), PackageError> {
    let pattern = Regex::new(r"^[a-z][a-z0-9_]{0,63}$").expect("static capability pattern");
    if pattern.is_match(name) {
        Ok(())
    } else {
        Err(PackageError::Invalid(format!(
            "invalid capability name {name}"
        )))
    }
}

fn validate_object_schema(schema: &Value, name: &str) -> Result<(), PackageError> {
    if schema.get("type").and_then(Value::as_str) != Some("object") {
        return Err(PackageError::Invalid(format!(
            "{name} must declare a JSON object schema"
        )));
    }
    if schema.get("additionalProperties").and_then(Value::as_bool) != Some(false) {
        return Err(PackageError::Invalid(format!(
            "{name} must set additionalProperties=false"
        )));
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> Result<(), PackageError> {
    if value.trim().is_empty() {
        return Err(PackageError::Invalid(
            "package path cannot be empty".to_owned(),
        ));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(PackageError::PathEscape(value.to_owned()));
    }
    Ok(())
}

fn resolve_package_file(root: &Path, relative: &str) -> Result<PathBuf, PackageError> {
    validate_relative_path(relative)?;
    let target = fs::canonicalize(root.join(relative)).map_err(PackageError::Io)?;
    if !target.starts_with(root) || !target.is_file() {
        return Err(PackageError::PathEscape(relative.to_owned()));
    }
    Ok(target)
}

fn verify_integrity(root: &Path, policy: LoadPolicy) -> Result<IntegrityState, PackageError> {
    let checksum_path = root.join("checksums.json");
    if !checksum_path.is_file() {
        return if policy == LoadPolicy::Development {
            Ok(IntegrityState::UnverifiedDevelopment)
        } else {
            Err(PackageError::IntegrityRequired)
        };
    }
    let checksums: BTreeMap<String, String> = serde_json::from_slice(&fs::read(checksum_path)?)?;
    if checksums.is_empty() {
        return Err(PackageError::Invalid(
            "checksums.json cannot be empty".to_owned(),
        ));
    }
    let actual_files = package_files(root)?;
    for relative in &actual_files {
        if !checksums.contains_key(relative) {
            return Err(PackageError::UndeclaredFile(relative.clone()));
        }
    }
    if let Some(missing) = checksums
        .keys()
        .find(|relative| !actual_files.contains(*relative))
    {
        return Err(PackageError::ChecksumMismatch(missing.clone()));
    }
    let mut aggregate = Sha256::new();
    for (relative, expected) in &checksums {
        let file = resolve_package_file(root, relative)?;
        let actual = hex::encode(Sha256::digest(fs::read(file)?));
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(PackageError::ChecksumMismatch(relative.clone()));
        }
        aggregate.update(relative.as_bytes());
        aggregate.update(actual.as_bytes());
    }
    Ok(IntegrityState::Verified {
        files: checksums.len(),
        digest: hex::encode(aggregate.finalize()),
    })
}

fn package_files(root: &Path) -> Result<Vec<String>, PackageError> {
    fn visit(root: &Path, directory: &Path, files: &mut Vec<String>) -> Result<(), PackageError> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| PackageError::PathEscape(path.display().to_string()))?
                .to_string_lossy()
                .replace('\\', "/");
            if metadata.file_type().is_symlink() {
                return Err(PackageError::UndeclaredFile(relative));
            }
            if metadata.is_dir() {
                visit(root, &path, files)?;
            } else if metadata.is_file()
                && relative != "checksums.json"
                && relative != "signature.json"
            {
                files.push(relative);
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    visit(root, root, &mut files)?;
    files.sort();
    Ok(files)
}

fn read_package_catalog(
    root: &Path,
    policy: LoadPolicy,
) -> Result<PackageCatalogState, PackageError> {
    let mut package_roots = fs::read_dir(root)?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && path.join("connector.json").is_file())
        .collect::<Vec<_>>();
    package_roots.sort();
    let mut packages = BTreeMap::new();
    let mut errors = Vec::new();
    let mut revision = Sha256::new();
    for package_root in package_roots {
        let package = match LoadedPackage::load(&package_root, policy) {
            Ok(package) => package,
            Err(error) => {
                let key = package_root
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                revision.update(key.as_bytes());
                revision.update(error.to_string().as_bytes());
                errors.push(PackageCatalogError {
                    key,
                    error: error.to_string(),
                });
                continue;
            }
        };
        revision.update(package.manifest.id.as_bytes());
        revision.update(package.revision.as_bytes());
        if packages.contains_key(&package.manifest.id) {
            let error = format!("duplicate connector package ID in {}", root.display());
            revision.update(error.as_bytes());
            errors.push(PackageCatalogError {
                key: package_root
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                error,
            });
            continue;
        }
        packages.insert(package.manifest.id.clone(), package);
    }
    Ok(PackageCatalogState {
        packages,
        errors,
        revision: hex::encode(revision.finalize()),
    })
}

fn object_schema() -> Value {
    serde_json::json!({"type":"object","properties":{},"additionalProperties":false})
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest(entrypoint: &str) -> Value {
        json!({
            "schemaVersion":1,
            "id":"test.connector",
            "name":"Test Connector",
            "description":"test package",
            "version":"1.0.0",
            "protocolVersion":1,
            "icon":"test",
            "entrypoints":{
                current_platform():{"path":entrypoint,"args":[]}
            },
            "settingsSchema":{"type":"object","properties":{},"additionalProperties":false},
            "events":{},
            "queries":{"get_state":{"type":"object","properties":{},"additionalProperties":false}},
            "actions":{}
        })
    }

    #[test]
    fn development_package_resolves_a_confined_entrypoint() {
        let directory = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(directory.path().join("workers")).expect("worker directory");
        fs::write(directory.path().join("workers/connector.exe"), b"binary").expect("worker file");
        fs::write(
            directory.path().join("connector.json"),
            serde_json::to_vec(&manifest("workers/connector.exe")).expect("manifest"),
        )
        .expect("write manifest");
        let package =
            LoadedPackage::load(directory.path(), LoadPolicy::Development).expect("load package");
        assert_eq!(package.manifest.id, "test.connector");
        assert_eq!(
            package.current_entrypoint().expect("entrypoint").executable,
            fs::canonicalize(directory.path().join("workers/connector.exe")).expect("canonical")
        );
        assert_eq!(package.integrity, IntegrityState::UnverifiedDevelopment);
    }

    #[test]
    fn rejects_path_traversal_before_touching_the_target() {
        let directory = tempfile::tempdir().expect("tempdir");
        fs::write(
            directory.path().join("connector.json"),
            serde_json::to_vec(&manifest("../outside.exe")).expect("manifest"),
        )
        .expect("write manifest");
        assert!(matches!(
            LoadedPackage::load(directory.path(), LoadPolicy::Development),
            Err(PackageError::PathEscape(_))
        ));
    }

    #[test]
    fn production_rejects_missing_or_mismatched_integrity_metadata() {
        let directory = tempfile::tempdir().expect("tempdir");
        fs::write(
            directory.path().join("connector.json"),
            serde_json::to_vec(&manifest("worker.exe")).expect("manifest"),
        )
        .expect("write manifest");
        fs::write(directory.path().join("worker.exe"), b"binary").expect("worker");
        assert!(matches!(
            LoadedPackage::load(directory.path(), LoadPolicy::Production),
            Err(PackageError::IntegrityRequired)
        ));
        fs::write(
            directory.path().join("checksums.json"),
            br#"{"worker.exe":"0000"}"#,
        )
        .expect("checksums");
        assert!(matches!(
            LoadedPackage::load(directory.path(), LoadPolicy::Production),
            Err(PackageError::ChecksumMismatch(_) | PackageError::UndeclaredFile(_))
        ));
    }

    #[test]
    fn catalog_discovers_packages_and_refreshes_revisions() {
        let directory = tempfile::tempdir().expect("tempdir");
        let package_root = directory.path().join("test.connector");
        fs::create_dir_all(package_root.join("workers")).expect("package directories");
        fs::write(package_root.join("workers/connector.exe"), b"binary").expect("worker");
        fs::write(
            package_root.join("connector.json"),
            serde_json::to_vec(&manifest("workers/connector.exe")).expect("manifest"),
        )
        .expect("write manifest");
        let catalog = PackageCatalog::load(directory.path().to_path_buf(), LoadPolicy::Development)
            .expect("catalog");
        assert!(catalog.get("test.connector").is_some());
        let revision = catalog.revision();
        let mut changed = manifest("workers/connector.exe");
        changed["description"] = json!("changed package");
        fs::write(
            package_root.join("connector.json"),
            serde_json::to_vec(&changed).expect("manifest"),
        )
        .expect("update manifest");
        assert!(catalog.refresh().expect("refresh"));
        assert_ne!(catalog.revision(), revision);
    }

    #[test]
    fn catalog_isolates_an_invalid_package() {
        let directory = tempfile::tempdir().expect("tempdir");
        let broken = directory.path().join("broken");
        fs::create_dir_all(&broken).expect("broken package");
        fs::write(broken.join("connector.json"), b"not json").expect("broken manifest");
        let catalog = PackageCatalog::load(directory.path().to_path_buf(), LoadPolicy::Development)
            .expect("catalog");
        assert!(catalog.packages().is_empty());
        assert_eq!(catalog.errors().len(), 1);
        assert_eq!(catalog.errors()[0].key, "broken");
    }
}
