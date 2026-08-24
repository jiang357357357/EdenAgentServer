//! Unified Eden Agent plugin package model, validation, integrity, and discovery.
//!
//! A plugin is an installation and lifecycle unit. Its components remain owned by
//! their specialized runtimes: skills, native connector workers, MCP servers,
//! optional UI resources, and declarative hooks. This crate never executes
//! third-party code.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, RwLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use uuid::Uuid;

pub const PLUGIN_SCHEMA_VERSION: u32 = 1;
pub const MAX_PACKAGE_FILES: usize = 512;
pub const MAX_PACKAGE_BYTES: u64 = 64 * 1024 * 1024;
pub const INSTALL_PREVIEW_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LoadPolicy {
    Development,
    Production,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_host_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_host_version: Option<String>,
    #[serde(default)]
    pub components: PluginComponents,
    #[serde(default)]
    pub permissions: Vec<PermissionDeclaration>,
    #[serde(default)]
    pub assets: Vec<PluginAsset>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginComponents {
    #[serde(default)]
    pub skills: Vec<SkillComponent>,
    #[serde(default)]
    pub runtimes: Vec<RuntimeComponent>,
    #[serde(default)]
    pub ui: Vec<UiComponent>,
    #[serde(default)]
    pub hooks: Vec<HookComponent>,
}

impl PluginComponents {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
            && self.runtimes.is_empty()
            && self.ui.is_empty()
            && self.hooks.is_empty()
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillComponent {
    pub id: String,
    pub path: String,
    #[serde(default = "default_true")]
    pub enabled_by_default: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeComponent {
    pub id: String,
    pub kind: RuntimeKind,
    /// Component-specific manifest. Native workers normally point at
    /// `connector.json`; MCP runtimes point at a local transport descriptor.
    pub manifest: String,
    #[serde(default = "default_true")]
    pub enabled_by_default: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeKind {
    NativeWorker,
    McpStdio,
    McpHttp,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiComponent {
    pub id: String,
    pub entry: String,
    #[serde(default)]
    pub enabled_by_default: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiContributionDocument {
    pub schema_version: u32,
    #[serde(default)]
    pub cards: Vec<UiContributionCard>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiContributionCard {
    pub id: String,
    pub location: String,
    pub title: String,
    pub body: String,
    #[serde(default = "default_ui_tone")]
    pub tone: String,
}

fn default_ui_tone() -> String {
    "info".to_owned()
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookComponent {
    pub id: String,
    pub event: String,
    /// Hooks are declarative and dispatch an installed skill. They are not an
    /// in-process native-code extension point.
    pub skill: String,
    #[serde(default)]
    pub enabled_by_default: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionDeclaration {
    pub capability: String,
    pub resource: String,
    pub access: String,
    #[serde(default)]
    pub required: bool,
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginAsset {
    pub source: String,
    pub target_kind: String,
    pub target: String,
}

#[derive(Clone, Debug)]
pub struct LoadedPlugin {
    pub root: PathBuf,
    pub manifest: PluginManifest,
    pub revision: String,
    pub integrity: IntegrityState,
    pub trust: PluginTrustState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginTrustState {
    Unsigned,
    UnknownKey { key_id: String },
    Verified { key_id: String },
}

impl PluginTrustState {
    #[must_use]
    pub fn verified(&self) -> bool {
        matches!(self, Self::Verified { .. })
    }

    #[must_use]
    pub fn label(&self) -> String {
        match self {
            Self::Unsigned => "unsigned".to_owned(),
            Self::UnknownKey { key_id } => format!("unknown_key:{key_id}"),
            Self::Verified { key_id } => format!("verified:{key_id}"),
        }
    }
}

impl PluginTrustStore {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, PluginError> {
        fs::create_dir_all(root.as_ref())?;
        Ok(Self {
            root: Arc::new(fs::canonicalize(root.as_ref())?),
        })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn key(&self, key_id: &str) -> Result<Option<VerifyingKey>, PluginError> {
        validate_identifier(key_id, "signature key ID")?;
        let path = self.root.join(format!("{key_id}.pub"));
        if !path.is_file() {
            return Ok(None);
        }
        let encoded = fs::read_to_string(path)?;
        let bytes = BASE64
            .decode(encoded.trim())
            .map_err(|error| PluginError::InvalidSignature(error.to_string()))?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| PluginError::InvalidSignature("public key must be 32 bytes".to_owned()))?;
        VerifyingKey::from_bytes(&bytes)
            .map(Some)
            .map_err(|error| PluginError::InvalidSignature(error.to_string()))
    }

    pub fn verify(
        &self,
        key_id: &str,
        message: &[u8],
        signature: &str,
    ) -> Result<bool, PluginError> {
        let Some(key) = self.key(key_id)? else {
            return Ok(false);
        };
        let bytes = BASE64
            .decode(signature)
            .map_err(|error| PluginError::InvalidSignature(error.to_string()))?;
        let signature = Signature::from_slice(&bytes)
            .map_err(|error| PluginError::InvalidSignature(error.to_string()))?;
        key.verify(message, &signature)
            .map_err(|error| PluginError::InvalidSignature(error.to_string()))?;
        Ok(true)
    }
}

#[derive(Clone, Debug)]
pub struct PluginTrustStore {
    root: Arc<PathBuf>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginSignature {
    key_id: String,
    algorithm: String,
    signature: String,
}

impl LoadedPlugin {
    pub fn load(root: impl AsRef<Path>, policy: LoadPolicy) -> Result<Self, PluginError> {
        Self::load_with_trust(root, policy, None)
    }

    pub fn load_with_trust(
        root: impl AsRef<Path>,
        policy: LoadPolicy,
        trust_store: Option<&PluginTrustStore>,
    ) -> Result<Self, PluginError> {
        let root = fs::canonicalize(root.as_ref()).map_err(PluginError::Io)?;
        if !root.is_dir() {
            return Err(PluginError::Invalid(
                "plugin root must be a directory".to_owned(),
            ));
        }
        let manifest_path = root.join("plugin.json");
        let manifest_bytes = fs::read(&manifest_path).map_err(PluginError::Io)?;
        let manifest: PluginManifest = serde_json::from_slice(&manifest_bytes)?;
        validate_manifest(&manifest)?;
        validate_component_targets(&root, &manifest)?;
        let integrity = verify_integrity(&root, policy)?;
        let trust = verify_signature(&root, &integrity, trust_store)?;
        let mut digest = Sha256::new();
        digest.update(&manifest_bytes);
        digest.update(integrity.revision_material());
        Ok(Self {
            root,
            manifest,
            revision: hex::encode(digest.finalize()),
            integrity,
            trust,
        })
    }

    pub fn resolve_file(&self, relative: &str) -> Result<PathBuf, PluginError> {
        resolve_package_file(&self.root, relative)
    }

    pub fn ui_contributions(&self) -> Result<Vec<(String, UiContributionCard)>, PluginError> {
        let mut result = Vec::new();
        for component in self
            .manifest
            .components
            .ui
            .iter()
            .filter(|component| component.enabled_by_default)
        {
            let document: UiContributionDocument =
                serde_json::from_slice(&fs::read(self.resolve_file(&component.entry)?)?)?;
            if document.schema_version != 1 || document.cards.len() > 32 {
                return Err(PluginError::Invalid(format!(
                    "invalid UI contribution document: {}",
                    component.id
                )));
            }
            let mut ids = BTreeSet::new();
            for card in document.cards {
                validate_identifier(&card.id, "UI card ID")?;
                if !ids.insert(card.id.clone())
                    || !matches!(card.location.as_str(), "plugin_detail" | "settings")
                    || !matches!(card.tone.as_str(), "info" | "success" | "warning")
                    || card.title.trim().is_empty()
                    || card.title.chars().count() > 120
                    || card.body.chars().count() > 4_000
                {
                    return Err(PluginError::Invalid(format!(
                        "unsafe UI contribution card: {}:{}",
                        component.id, card.id
                    )));
                }
                result.push((component.id.clone(), card));
            }
        }
        Ok(result)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IntegrityState {
    Verified {
        files: usize,
        bytes: u64,
        digest: String,
    },
    UnverifiedDevelopment {
        files: usize,
        bytes: u64,
        digest: String,
    },
}

impl IntegrityState {
    fn revision_material(&self) -> Vec<u8> {
        match self {
            Self::Verified { digest, .. } => digest.as_bytes().to_vec(),
            Self::UnverifiedDevelopment { digest, .. } => digest.as_bytes().to_vec(),
        }
    }

    #[must_use]
    pub fn verified(&self) -> bool {
        matches!(self, Self::Verified { .. })
    }
}

#[derive(Clone)]
pub struct PluginCatalog {
    root: Arc<PathBuf>,
    policy: LoadPolicy,
    state: Arc<RwLock<PluginCatalogState>>,
}

#[derive(Clone, Debug)]
struct PluginCatalogState {
    plugins: BTreeMap<String, LoadedPlugin>,
    errors: Vec<PluginCatalogError>,
    revision: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCatalogError {
    pub key: String,
    pub error: String,
}

impl PluginCatalog {
    pub fn load(root: PathBuf, policy: LoadPolicy) -> Result<Self, PluginError> {
        fs::create_dir_all(&root)?;
        let root = fs::canonicalize(root)?;
        let state = read_catalog(&root, policy)?;
        Ok(Self {
            root: Arc::new(root),
            policy,
            state: Arc::new(RwLock::new(state)),
        })
    }

    pub fn refresh(&self) -> Result<bool, PluginError> {
        let refreshed = read_catalog(&self.root, self.policy)?;
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
    pub fn get(&self, id: &str) -> Option<LoadedPlugin> {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .plugins
            .get(id)
            .cloned()
    }

    #[must_use]
    pub fn plugins(&self) -> Vec<LoadedPlugin> {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .plugins
            .values()
            .cloned()
            .collect()
    }

    #[must_use]
    pub fn errors(&self) -> Vec<PluginCatalogError> {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .errors
            .clone()
    }

    #[must_use]
    pub fn revision(&self) -> String {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .revision
            .clone()
    }
}

#[derive(Debug, Error)]
pub enum PluginError {
    #[error("plugin package I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("plugin manifest is invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("plugin package is invalid: {0}")]
    Invalid(String),
    #[error("plugin package path escapes its root: {0}")]
    PathEscape(String),
    #[error("plugin package integrity metadata is required in production")]
    IntegrityRequired,
    #[error("a signature from a trusted key is required")]
    SignatureRequired,
    #[error("plugin signature is invalid: {0}")]
    InvalidSignature(String),
    #[error("plugin package checksum mismatch: {0}")]
    ChecksumMismatch(String),
    #[error("plugin package contains an undeclared or unsafe file: {0}")]
    UndeclaredFile(String),
    #[error("plugin package exceeds limit {limit}: {actual}")]
    PackageLimit { limit: &'static str, actual: u64 },
    #[error("plugin package changed after inspection: expected {expected}, found {actual}")]
    ConcurrentModification { expected: String, actual: String },
    #[error("installed plugin package is invalid: {0}")]
    InvalidInstalledPackage(String),
    #[error("plugin install preview does not exist or expired: {0}")]
    PreviewNotFound(String),
}

/// Immutable on-disk package store. Runtime activation is intentionally kept
/// outside this type and is persisted by the Server database.
#[derive(Clone, Debug)]
pub struct PluginInstallStore {
    root: Arc<PathBuf>,
    versions_root: Arc<PathBuf>,
    staging_root: Arc<PathBuf>,
    trust_store: PluginTrustStore,
}

#[derive(Clone, Debug)]
pub struct InstallPreview {
    pub source: PathBuf,
    pub source_type: String,
    pub source_uri: String,
    pub plugin: LoadedPlugin,
}

#[derive(Clone, Debug)]
pub struct InstallOutcome {
    pub source: PathBuf,
    pub source_type: String,
    pub source_uri: String,
    pub plugin: LoadedPlugin,
    pub installed: bool,
}

#[derive(Clone, Debug)]
pub struct ManagedInstallPreview {
    pub id: String,
    pub owner: String,
    pub expires_at: i64,
    pub preview: InstallPreview,
}

#[derive(Clone, Debug)]
pub struct PluginInstaller {
    store: PluginInstallStore,
    previews: Arc<RwLock<BTreeMap<String, ManagedInstallPreview>>>,
}

impl PluginInstaller {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, PluginError> {
        Ok(Self {
            store: PluginInstallStore::open(root)?,
            previews: Arc::new(RwLock::new(BTreeMap::new())),
        })
    }

    #[must_use]
    pub fn store(&self) -> &PluginInstallStore {
        &self.store
    }

    pub fn inspect_local_for(
        &self,
        owner: &str,
        source: impl AsRef<Path>,
    ) -> Result<ManagedInstallPreview, PluginError> {
        let preview = self.store.inspect_local(source)?;
        self.manage_preview(owner, preview)
    }

    pub fn inspect_with_provenance_for(
        &self,
        owner: &str,
        source: impl AsRef<Path>,
        source_type: &str,
        source_uri: &str,
    ) -> Result<ManagedInstallPreview, PluginError> {
        let preview = self
            .store
            .inspect_with_provenance(source, source_type, source_uri)?;
        self.manage_preview(owner, preview)
    }

    fn manage_preview(
        &self,
        owner: &str,
        preview: InstallPreview,
    ) -> Result<ManagedInstallPreview, PluginError> {
        let managed = ManagedInstallPreview {
            id: Uuid::now_v7().to_string(),
            owner: owner.to_owned(),
            expires_at: epoch_millis()
                .saturating_add(i64::try_from(INSTALL_PREVIEW_TTL.as_millis()).unwrap_or(i64::MAX)),
            preview,
        };
        let mut previews = self
            .previews
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        previews.retain(|_, value| value.expires_at > epoch_millis());
        previews.insert(managed.id.clone(), managed.clone());
        Ok(managed)
    }

    pub fn install_preview_for(
        &self,
        owner: &str,
        preview_id: &str,
        require_verified: bool,
    ) -> Result<InstallOutcome, PluginError> {
        let managed = {
            let mut previews = self
                .previews
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            previews.retain(|_, value| value.expires_at > epoch_millis());
            previews
                .get(preview_id)
                .filter(|value| value.owner == owner)
                .cloned()
                .ok_or_else(|| PluginError::PreviewNotFound(preview_id.to_owned()))?
        };
        let outcome = if require_verified || managed.preview.source_type == "market" {
            self.store.install_verified(&managed.preview)?
        } else {
            self.store.install_local(&managed.preview)?
        };
        self.previews
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(preview_id);
        Ok(outcome)
    }
}

impl PluginInstallStore {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, PluginError> {
        fs::create_dir_all(root.as_ref())?;
        let root = fs::canonicalize(root.as_ref())?;
        let versions_root = root.join("store");
        let staging_root = root.join("staging");
        fs::create_dir_all(&versions_root)?;
        fs::create_dir_all(&staging_root)?;
        let trust_root = root.join("trust");
        fs::create_dir_all(&trust_root)?;
        Ok(Self {
            root: Arc::new(root),
            versions_root: Arc::new(fs::canonicalize(versions_root)?),
            staging_root: Arc::new(fs::canonicalize(staging_root)?),
            trust_store: PluginTrustStore::open(trust_root)?,
        })
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn inspect_local(&self, source: impl AsRef<Path>) -> Result<InstallPreview, PluginError> {
        let source = fs::canonicalize(source.as_ref())?;
        let source_uri = source.to_string_lossy().into_owned();
        self.inspect_with_provenance(source, "local", &source_uri)
    }

    pub fn inspect_with_provenance(
        &self,
        source: impl AsRef<Path>,
        source_type: &str,
        source_uri: &str,
    ) -> Result<InstallPreview, PluginError> {
        if source_type.trim().is_empty() || source_uri.trim().is_empty() {
            return Err(PluginError::Invalid(
                "plugin source provenance cannot be empty".to_owned(),
            ));
        }
        let source = fs::canonicalize(source.as_ref())?;
        let plugin = LoadedPlugin::load_with_trust(
            &source,
            LoadPolicy::Development,
            Some(&self.trust_store),
        )?;
        Ok(InstallPreview {
            source,
            source_type: source_type.to_owned(),
            source_uri: source_uri.to_owned(),
            plugin,
        })
    }

    pub fn install_local(&self, preview: &InstallPreview) -> Result<InstallOutcome, PluginError> {
        self.install(preview, LoadPolicy::Development)
    }

    pub fn install_verified(
        &self,
        preview: &InstallPreview,
    ) -> Result<InstallOutcome, PluginError> {
        self.install(preview, LoadPolicy::Production)
    }

    fn install(
        &self,
        preview: &InstallPreview,
        policy: LoadPolicy,
    ) -> Result<InstallOutcome, PluginError> {
        let current =
            LoadedPlugin::load_with_trust(&preview.source, policy, Some(&self.trust_store))?;
        if policy == LoadPolicy::Production && !current.trust.verified() {
            return Err(PluginError::SignatureRequired);
        }
        if current.revision != preview.plugin.revision {
            return Err(PluginError::ConcurrentModification {
                expected: preview.plugin.revision.clone(),
                actual: current.revision,
            });
        }
        let destination = self
            .versions_root
            .join(&current.manifest.id)
            .join(&current.manifest.version)
            .join(&current.revision);
        if destination.is_dir() {
            let installed = self.load_installed(&destination, policy)?;
            return Ok(InstallOutcome {
                source: preview.source.clone(),
                source_type: preview.source_type.clone(),
                source_uri: preview.source_uri.clone(),
                plugin: installed,
                installed: false,
            });
        }

        let staging = tempfile::Builder::new()
            .prefix(".plugin-stage-")
            .tempdir_in(&*self.staging_root)?;
        let staged = staging.path().join("package");
        copy_package(&preview.source, &staged)?;
        let staged_plugin =
            LoadedPlugin::load_with_trust(&staged, policy, Some(&self.trust_store))?;
        if staged_plugin.revision != current.revision
            || staged_plugin.manifest.id != current.manifest.id
            || staged_plugin.manifest.version != current.manifest.version
        {
            return Err(PluginError::ConcurrentModification {
                expected: current.revision,
                actual: staged_plugin.revision,
            });
        }
        let parent = destination.parent().ok_or_else(|| {
            PluginError::InvalidInstalledPackage("destination has no parent".to_owned())
        })?;
        fs::create_dir_all(parent)?;
        match fs::rename(&staged, &destination) {
            Ok(()) => {}
            Err(error) if destination.is_dir() => {
                let installed =
                    self.load_installed(&destination, policy)
                        .map_err(|load_error| {
                            PluginError::InvalidInstalledPackage(format!(
                                "{} after concurrent install ({error}): {load_error}",
                                destination.display()
                            ))
                        })?;
                return Ok(InstallOutcome {
                    source: preview.source.clone(),
                    source_type: preview.source_type.clone(),
                    source_uri: preview.source_uri.clone(),
                    plugin: installed,
                    installed: false,
                });
            }
            Err(error) => return Err(PluginError::Io(error)),
        }
        let installed = self.load_installed(&destination, policy)?;
        Ok(InstallOutcome {
            source: preview.source.clone(),
            source_type: preview.source_type.clone(),
            source_uri: preview.source_uri.clone(),
            plugin: installed,
            installed: true,
        })
    }

    pub fn installed(&self) -> Result<Vec<LoadedPlugin>, PluginError> {
        let mut installed = Vec::new();
        for id in sorted_directories(&self.versions_root)? {
            for version in sorted_directories(&id)? {
                for revision in sorted_directories(&version)? {
                    if revision.join("plugin.json").is_file() {
                        installed.push(self.load_installed(&revision, LoadPolicy::Development)?);
                    }
                }
            }
        }
        installed.sort_by(|left, right| {
            left.manifest
                .id
                .cmp(&right.manifest.id)
                .then_with(|| left.manifest.version.cmp(&right.manifest.version))
                .then_with(|| left.revision.cmp(&right.revision))
        });
        Ok(installed)
    }

    /// Remove one exact immutable version. The target is derived only from a
    /// validated plugin identity and is reloaded before recursive deletion.
    pub fn remove_installed_version(
        &self,
        plugin_id: &str,
        version: &str,
        revision: &str,
    ) -> Result<bool, PluginError> {
        validate_identifier(plugin_id, "plugin ID")?;
        validate_version(version, "version")?;
        let revision_pattern =
            Regex::new(r"^[0-9a-f]{64}$").expect("static plugin revision pattern");
        if !revision_pattern.is_match(revision) {
            return Err(PluginError::Invalid(format!(
                "invalid plugin revision {revision}"
            )));
        }
        let target = self
            .versions_root
            .join(plugin_id)
            .join(version)
            .join(revision);
        if !target.exists() {
            return Ok(false);
        }
        let target = fs::canonicalize(&target)?;
        if !target.starts_with(&*self.versions_root) {
            return Err(PluginError::PathEscape(target.display().to_string()));
        }
        let installed = self.load_installed(&target, LoadPolicy::Development)?;
        if installed.manifest.id != plugin_id
            || installed.manifest.version != version
            || installed.revision != revision
        {
            return Err(PluginError::InvalidInstalledPackage(format!(
                "{} does not match {plugin_id}@{version}#{revision}",
                target.display()
            )));
        }
        fs::remove_dir_all(&target)?;
        if let Some(version_root) = target.parent() {
            let _ = fs::remove_dir(version_root);
            if let Some(plugin_root) = version_root.parent() {
                let _ = fs::remove_dir(plugin_root);
            }
        }
        Ok(true)
    }

    fn load_installed(&self, root: &Path, policy: LoadPolicy) -> Result<LoadedPlugin, PluginError> {
        LoadedPlugin::load_with_trust(root, policy, Some(&self.trust_store)).map_err(|error| {
            PluginError::InvalidInstalledPackage(format!("{}: {error}", root.display()))
        })
    }

    #[must_use]
    pub fn trust_store(&self) -> &PluginTrustStore {
        &self.trust_store
    }
}

fn sorted_directories(root: &Path) -> Result<Vec<PathBuf>, PluginError> {
    let mut directories = fs::read_dir(root)?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    directories.sort();
    Ok(directories)
}

fn copy_package(source: &Path, destination: &Path) -> Result<(), PluginError> {
    fn copy_directory(source: &Path, destination: &Path) -> Result<(), PluginError> {
        fs::create_dir(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let source_path = entry.path();
            let destination_path = destination.join(entry.file_name());
            let metadata = fs::symlink_metadata(&source_path)?;
            if metadata.file_type().is_symlink() {
                return Err(PluginError::UndeclaredFile(
                    source_path.display().to_string(),
                ));
            }
            if metadata.is_dir() {
                copy_directory(&source_path, &destination_path)?;
            } else if metadata.is_file() {
                fs::copy(&source_path, &destination_path)?;
            } else {
                return Err(PluginError::UndeclaredFile(
                    source_path.display().to_string(),
                ));
            }
        }
        Ok(())
    }

    copy_directory(source, destination)
}

pub fn validate_manifest(manifest: &PluginManifest) -> Result<(), PluginError> {
    if manifest.schema_version != PLUGIN_SCHEMA_VERSION {
        return Err(PluginError::Invalid(format!(
            "unsupported schema version {}",
            manifest.schema_version
        )));
    }
    validate_identifier(&manifest.id, "plugin ID")?;
    validate_version(&manifest.version, "version")?;
    if let Some(version) = &manifest.min_host_version {
        validate_version(version, "minHostVersion")?;
    }
    if let Some(version) = &manifest.max_host_version {
        validate_version(version, "maxHostVersion")?;
    }
    if manifest.name.trim().is_empty() || manifest.description.trim().is_empty() {
        return Err(PluginError::Invalid(
            "name and description are required".to_owned(),
        ));
    }
    if manifest.components.is_empty() {
        return Err(PluginError::Invalid(
            "at least one plugin component is required".to_owned(),
        ));
    }

    let mut component_ids = BTreeSet::new();
    for skill in &manifest.components.skills {
        validate_component_id(&skill.id, &mut component_ids)?;
        validate_relative_path(&skill.path)?;
        if Path::new(&skill.path)
            .file_name()
            .and_then(|name| name.to_str())
            != Some("SKILL.md")
        {
            return Err(PluginError::Invalid(format!(
                "skill component {} must point to SKILL.md",
                skill.id
            )));
        }
    }
    for runtime in &manifest.components.runtimes {
        validate_component_id(&runtime.id, &mut component_ids)?;
        validate_relative_path(&runtime.manifest)?;
        if runtime.kind == RuntimeKind::NativeWorker
            && Path::new(&runtime.manifest)
                .file_name()
                .and_then(|name| name.to_str())
                != Some("connector.json")
        {
            return Err(PluginError::Invalid(format!(
                "native worker component {} must point to connector.json",
                runtime.id
            )));
        }
    }
    for ui in &manifest.components.ui {
        validate_component_id(&ui.id, &mut component_ids)?;
        validate_relative_path(&ui.entry)?;
        if Path::new(&ui.entry)
            .extension()
            .and_then(|value| value.to_str())
            != Some("json")
        {
            return Err(PluginError::Invalid(format!(
                "UI component {} must point to a JSON contribution document",
                ui.id
            )));
        }
    }
    let skill_ids = manifest
        .components
        .skills
        .iter()
        .map(|skill| skill.id.as_str())
        .collect::<BTreeSet<_>>();
    for hook in &manifest.components.hooks {
        validate_component_id(&hook.id, &mut component_ids)?;
        validate_event_name(&hook.event)?;
        if !skill_ids.contains(hook.skill.as_str()) {
            return Err(PluginError::Invalid(format!(
                "hook {} references unknown skill component {}",
                hook.id, hook.skill
            )));
        }
    }
    for permission in &manifest.permissions {
        if permission.capability.trim().is_empty()
            || permission.resource.trim().is_empty()
            || permission.access.trim().is_empty()
            || permission.description.trim().is_empty()
        {
            return Err(PluginError::Invalid(
                "plugin permission fields cannot be empty".to_owned(),
            ));
        }
    }
    for asset in &manifest.assets {
        validate_relative_path(&asset.source)?;
        if asset.target_kind.trim().is_empty() || asset.target.trim().is_empty() {
            return Err(PluginError::Invalid(
                "asset targetKind and target are required".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_component_targets(root: &Path, manifest: &PluginManifest) -> Result<(), PluginError> {
    for path in manifest
        .components
        .skills
        .iter()
        .map(|component| component.path.as_str())
        .chain(
            manifest
                .components
                .runtimes
                .iter()
                .map(|component| component.manifest.as_str()),
        )
        .chain(
            manifest
                .components
                .ui
                .iter()
                .map(|component| component.entry.as_str()),
        )
    {
        resolve_package_file(root, path)?;
    }
    for asset in &manifest.assets {
        let target = fs::canonicalize(root.join(&asset.source)).map_err(PluginError::Io)?;
        if !target.starts_with(root) || (!target.is_file() && !target.is_dir()) {
            return Err(PluginError::PathEscape(asset.source.clone()));
        }
    }
    Ok(())
}

fn validate_component_id(id: &str, seen: &mut BTreeSet<String>) -> Result<(), PluginError> {
    validate_identifier(id, "component ID")?;
    if !seen.insert(id.to_owned()) {
        return Err(PluginError::Invalid(format!(
            "duplicate plugin component ID {id}"
        )));
    }
    Ok(())
}

fn validate_identifier(value: &str, label: &str) -> Result<(), PluginError> {
    let pattern = Regex::new(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
        .expect("static plugin identifier pattern");
    if pattern.is_match(value) {
        Ok(())
    } else {
        Err(PluginError::Invalid(format!("invalid {label} {value}")))
    }
}

fn validate_event_name(value: &str) -> Result<(), PluginError> {
    validate_identifier(value, "hook event")
}

fn validate_version(value: &str, label: &str) -> Result<(), PluginError> {
    let pattern = Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
        .expect("static semantic version pattern");
    if pattern.is_match(value) {
        Ok(())
    } else {
        Err(PluginError::Invalid(format!("invalid {label} {value}")))
    }
}

fn validate_relative_path(value: &str) -> Result<(), PluginError> {
    if value.trim().is_empty() {
        return Err(PluginError::Invalid(
            "plugin package path cannot be empty".to_owned(),
        ));
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(PluginError::PathEscape(value.to_owned()));
    }
    Ok(())
}

fn resolve_package_file(root: &Path, relative: &str) -> Result<PathBuf, PluginError> {
    validate_relative_path(relative)?;
    let target = fs::canonicalize(root.join(relative)).map_err(PluginError::Io)?;
    if !target.starts_with(root) || !target.is_file() {
        return Err(PluginError::PathEscape(relative.to_owned()));
    }
    Ok(target)
}

fn verify_integrity(root: &Path, policy: LoadPolicy) -> Result<IntegrityState, PluginError> {
    let files = package_files(root)?;
    let bytes = package_size(root, &files)?;
    let checksum_path = root.join("checksums.json");
    if !checksum_path.is_file() {
        return if policy == LoadPolicy::Development {
            Ok(IntegrityState::UnverifiedDevelopment {
                files: files.len(),
                bytes,
                digest: aggregate_file_digest(root, &files)?,
            })
        } else {
            Err(PluginError::IntegrityRequired)
        };
    }
    let checksums: BTreeMap<String, String> = serde_json::from_slice(&fs::read(checksum_path)?)?;
    if checksums.is_empty() {
        return Err(PluginError::Invalid(
            "checksums.json cannot be empty".to_owned(),
        ));
    }
    for relative in &files {
        if !checksums.contains_key(relative) {
            return Err(PluginError::UndeclaredFile(relative.clone()));
        }
    }
    if let Some(missing) = checksums.keys().find(|relative| !files.contains(*relative)) {
        return Err(PluginError::ChecksumMismatch(missing.clone()));
    }
    let mut aggregate = Sha256::new();
    for (relative, expected) in &checksums {
        let file = resolve_package_file(root, relative)?;
        let actual = hex::encode(Sha256::digest(fs::read(file)?));
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(PluginError::ChecksumMismatch(relative.clone()));
        }
        aggregate.update(relative.as_bytes());
        aggregate.update(actual.as_bytes());
    }
    Ok(IntegrityState::Verified {
        files: checksums.len(),
        bytes,
        digest: hex::encode(aggregate.finalize()),
    })
}

fn verify_signature(
    root: &Path,
    integrity: &IntegrityState,
    trust_store: Option<&PluginTrustStore>,
) -> Result<PluginTrustState, PluginError> {
    let path = root.join("signature.json");
    if !path.is_file() {
        return Ok(PluginTrustState::Unsigned);
    }
    let signature: PluginSignature = serde_json::from_slice(&fs::read(path)?)
        .map_err(|error| PluginError::InvalidSignature(error.to_string()))?;
    validate_identifier(&signature.key_id, "signature key ID")?;
    let key_id = signature.key_id.clone();
    if signature.algorithm != "ed25519" {
        return Err(PluginError::InvalidSignature(format!(
            "unsupported algorithm {}",
            signature.algorithm
        )));
    }
    let Some(key) = trust_store
        .map(|store| store.key(&signature.key_id))
        .transpose()?
        .flatten()
    else {
        return Ok(PluginTrustState::UnknownKey {
            key_id: signature.key_id,
        });
    };
    let bytes = BASE64
        .decode(&signature.signature)
        .map_err(|error| PluginError::InvalidSignature(error.to_string()))?;
    let signature = Signature::from_slice(&bytes)
        .map_err(|error| PluginError::InvalidSignature(error.to_string()))?;
    key.verify(integrity.revision_material().as_slice(), &signature)
        .map_err(|error| PluginError::InvalidSignature(error.to_string()))?;
    Ok(PluginTrustState::Verified { key_id })
}

fn aggregate_file_digest(root: &Path, files: &[String]) -> Result<String, PluginError> {
    let mut aggregate = Sha256::new();
    for relative in files {
        let digest = hex::encode(Sha256::digest(fs::read(resolve_package_file(
            root, relative,
        )?)?));
        aggregate.update(relative.as_bytes());
        aggregate.update(digest.as_bytes());
    }
    Ok(hex::encode(aggregate.finalize()))
}

fn package_files(root: &Path) -> Result<Vec<String>, PluginError> {
    fn visit(root: &Path, directory: &Path, files: &mut Vec<String>) -> Result<(), PluginError> {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            let relative = path
                .strip_prefix(root)
                .map_err(|_| PluginError::PathEscape(path.display().to_string()))?
                .to_string_lossy()
                .replace('\\', "/");
            if metadata.file_type().is_symlink() {
                return Err(PluginError::UndeclaredFile(relative));
            }
            if metadata.is_dir() {
                visit(root, &path, files)?;
            } else if metadata.is_file()
                && relative != "checksums.json"
                && relative != "signature.json"
            {
                files.push(relative);
                if files.len() > MAX_PACKAGE_FILES {
                    return Err(PluginError::PackageLimit {
                        limit: "file count",
                        actual: files.len() as u64,
                    });
                }
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    visit(root, root, &mut files)?;
    files.sort();
    Ok(files)
}

fn package_size(root: &Path, files: &[String]) -> Result<u64, PluginError> {
    let mut bytes = 0_u64;
    for relative in files {
        bytes = bytes.saturating_add(fs::metadata(resolve_package_file(root, relative)?)?.len());
        if bytes > MAX_PACKAGE_BYTES {
            return Err(PluginError::PackageLimit {
                limit: "total bytes",
                actual: bytes,
            });
        }
    }
    Ok(bytes)
}

fn read_catalog(root: &Path, policy: LoadPolicy) -> Result<PluginCatalogState, PluginError> {
    let mut package_roots = fs::read_dir(root)?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && path.join("plugin.json").is_file())
        .collect::<Vec<_>>();
    package_roots.sort();
    let mut plugins = BTreeMap::new();
    let mut errors = Vec::new();
    let mut revision = Sha256::new();
    for package_root in package_roots {
        let key = package_root
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let plugin = match LoadedPlugin::load(&package_root, policy) {
            Ok(plugin) => plugin,
            Err(error) => {
                revision.update(key.as_bytes());
                revision.update(error.to_string().as_bytes());
                errors.push(PluginCatalogError {
                    key,
                    error: error.to_string(),
                });
                continue;
            }
        };
        revision.update(plugin.manifest.id.as_bytes());
        revision.update(plugin.revision.as_bytes());
        if plugins.contains_key(&plugin.manifest.id) {
            let error = format!("duplicate plugin ID in {}", root.display());
            revision.update(error.as_bytes());
            errors.push(PluginCatalogError { key, error });
            continue;
        }
        plugins.insert(plugin.manifest.id.clone(), plugin);
    }
    Ok(PluginCatalogState {
        plugins,
        errors,
        revision: hex::encode(revision.finalize()),
    })
}

fn default_true() -> bool {
    true
}

fn epoch_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    fn manifest(skill_path: &str) -> serde_json::Value {
        json!({
            "schemaVersion": 1,
            "id": "mon.test",
            "name": "Test Plugin",
            "description": "test plugin package",
            "version": "1.0.0",
            "minHostVersion": "1.8.0",
            "components": {
                "skills": [{"id":"workflow","path":skill_path}],
                "runtimes": [{
                    "id":"service",
                    "kind":"native_worker",
                    "manifest":"connector/connector.json"
                }],
                "hooks": [{
                    "id":"on_start",
                    "event":"agent.session.started",
                    "skill":"workflow"
                }]
            },
            "permissions": []
        })
    }

    fn write_development_package(root: &Path) {
        fs::create_dir_all(root.join("skills/workflow")).expect("skill directory");
        fs::create_dir_all(root.join("connector")).expect("connector directory");
        fs::write(root.join("skills/workflow/SKILL.md"), b"# Workflow").expect("skill");
        fs::write(root.join("connector/connector.json"), b"{}").expect("connector manifest");
        fs::write(
            root.join("plugin.json"),
            serde_json::to_vec(&manifest("skills/workflow/SKILL.md")).expect("manifest"),
        )
        .expect("plugin manifest");
    }

    #[test]
    fn loads_a_componentized_development_plugin() {
        let directory = tempfile::tempdir().expect("tempdir");
        write_development_package(directory.path());
        let plugin =
            LoadedPlugin::load(directory.path(), LoadPolicy::Development).expect("load plugin");
        assert_eq!(plugin.manifest.id, "mon.test");
        assert_eq!(plugin.manifest.components.skills.len(), 1);
        assert_eq!(plugin.manifest.components.runtimes.len(), 1);
        assert!(!plugin.integrity.verified());
    }

    #[test]
    fn loads_only_bounded_host_rendered_ui_contributions() {
        let directory = tempfile::tempdir().expect("tempdir");
        write_development_package(directory.path());
        fs::create_dir(directory.path().join("ui")).expect("ui directory");
        fs::write(
            directory.path().join("ui/contributions.json"),
            serde_json::to_vec(&json!({
                "schemaVersion":1,
                "cards":[{
                    "id":"status",
                    "location":"plugin_detail",
                    "title":"Ready",
                    "body":"The plugin is configured.",
                    "tone":"success"
                }]
            }))
            .expect("UI JSON"),
        )
        .expect("UI document");
        let mut value = manifest("skills/workflow/SKILL.md");
        value["components"]["ui"] = json!([{
            "id":"dashboard",
            "entry":"ui/contributions.json",
            "enabledByDefault":true
        }]);
        fs::write(
            directory.path().join("plugin.json"),
            serde_json::to_vec(&value).expect("manifest"),
        )
        .expect("manifest");
        let plugin = LoadedPlugin::load(directory.path(), LoadPolicy::Development).expect("plugin");
        let contributions = plugin.ui_contributions().expect("contributions");
        assert_eq!(contributions.len(), 1);
        assert_eq!(contributions[0].1.location, "plugin_detail");

        fs::write(
            directory.path().join("ui/contributions.json"),
            br#"{"schemaVersion":1,"cards":[{"id":"unsafe","location":"webview","title":"Unsafe","body":"x"}]}"#,
        )
        .expect("unsafe UI");
        let plugin = LoadedPlugin::load(directory.path(), LoadPolicy::Development).expect("plugin");
        assert!(plugin.ui_contributions().is_err());
    }

    #[test]
    fn rejects_component_path_traversal() {
        let directory = tempfile::tempdir().expect("tempdir");
        fs::write(
            directory.path().join("plugin.json"),
            serde_json::to_vec(&manifest("../SKILL.md")).expect("manifest"),
        )
        .expect("plugin manifest");
        assert!(matches!(
            LoadedPlugin::load(directory.path(), LoadPolicy::Development),
            Err(PluginError::PathEscape(_))
        ));
    }

    #[test]
    fn rejects_duplicate_component_ids_and_unknown_hook_skills() {
        let mut duplicate = manifest("skills/workflow/SKILL.md");
        duplicate["components"]["runtimes"][0]["id"] = json!("workflow");
        let duplicate_manifest: PluginManifest =
            serde_json::from_value(duplicate).expect("manifest");
        assert!(matches!(
            validate_manifest(&duplicate_manifest),
            Err(PluginError::Invalid(message)) if message.contains("duplicate")
        ));

        let mut unknown = manifest("skills/workflow/SKILL.md");
        unknown["components"]["hooks"][0]["skill"] = json!("missing");
        let unknown_manifest: PluginManifest = serde_json::from_value(unknown).expect("manifest");
        assert!(matches!(
            validate_manifest(&unknown_manifest),
            Err(PluginError::Invalid(message)) if message.contains("unknown skill")
        ));
    }

    #[test]
    fn production_requires_complete_integrity_metadata() {
        let directory = tempfile::tempdir().expect("tempdir");
        write_development_package(directory.path());
        assert!(matches!(
            LoadedPlugin::load(directory.path(), LoadPolicy::Production),
            Err(PluginError::IntegrityRequired)
        ));
        fs::write(
            directory.path().join("checksums.json"),
            br#"{"plugin.json":"0000"}"#,
        )
        .expect("checksums");
        assert!(matches!(
            LoadedPlugin::load(directory.path(), LoadPolicy::Production),
            Err(PluginError::UndeclaredFile(_) | PluginError::ChecksumMismatch(_))
        ));
    }

    #[test]
    fn production_install_requires_and_verifies_a_trusted_signature() {
        let source = tempfile::tempdir().expect("source");
        write_development_package(source.path());
        let mut checksums = BTreeMap::new();
        for relative in [
            "connector/connector.json",
            "plugin.json",
            "skills/workflow/SKILL.md",
        ] {
            checksums.insert(
                relative,
                hex::encode(Sha256::digest(
                    fs::read(source.path().join(relative)).expect("package file"),
                )),
            );
        }
        fs::write(
            source.path().join("checksums.json"),
            serde_json::to_vec(&checksums).expect("checksums JSON"),
        )
        .expect("checksums");

        let storage = tempfile::tempdir().expect("storage");
        let store = PluginInstallStore::open(storage.path()).expect("store");
        let signing = SigningKey::from_bytes(&[7_u8; 32]);
        fs::write(
            store.trust_store.root().join("release.pub"),
            BASE64.encode(signing.verifying_key().to_bytes()),
        )
        .expect("trusted key");
        let integrity = verify_integrity(source.path(), LoadPolicy::Production).expect("integrity");
        fs::write(
            source.path().join("signature.json"),
            serde_json::to_vec(&json!({
                "keyId":"release",
                "algorithm":"ed25519",
                "signature":BASE64.encode(signing.sign(&integrity.revision_material()).to_bytes())
            }))
            .expect("signature JSON"),
        )
        .expect("signature");

        let preview = store.inspect_local(source.path()).expect("trusted preview");
        assert!(preview.plugin.trust.verified());
        let installed = store
            .install_verified(&preview)
            .expect("trusted production install");
        assert_eq!(installed.plugin.trust.label(), "verified:release");
    }

    #[test]
    fn catalog_isolates_invalid_plugins_and_refreshes() {
        let directory = tempfile::tempdir().expect("tempdir");
        let valid = directory.path().join("valid");
        fs::create_dir_all(&valid).expect("valid root");
        write_development_package(&valid);
        let broken = directory.path().join("broken");
        fs::create_dir_all(&broken).expect("broken root");
        fs::write(broken.join("plugin.json"), b"not json").expect("broken manifest");

        let catalog = PluginCatalog::load(directory.path().to_path_buf(), LoadPolicy::Development)
            .expect("catalog");
        assert!(catalog.get("mon.test").is_some());
        assert_eq!(catalog.errors().len(), 1);
        let revision = catalog.revision();
        fs::remove_file(broken.join("plugin.json")).expect("remove broken manifest");
        assert!(catalog.refresh().expect("refresh"));
        assert_ne!(revision, catalog.revision());
        assert!(catalog.errors().is_empty());
    }

    #[test]
    fn install_store_commits_immutable_revisions_idempotently() {
        let source = tempfile::tempdir().expect("source");
        write_development_package(source.path());
        let storage = tempfile::tempdir().expect("storage");
        let store = PluginInstallStore::open(storage.path()).expect("store");
        let preview = store.inspect_local(source.path()).expect("preview");

        let first = store.install_local(&preview).expect("first install");
        assert!(first.installed);
        assert!(first.plugin.root.starts_with(store.root()));
        let second = store.install_local(&preview).expect("idempotent install");
        assert!(!second.installed);
        assert_eq!(first.plugin.root, second.plugin.root);
        assert_eq!(store.installed().expect("installed list").len(), 1);
    }

    #[test]
    fn install_store_rejects_changes_after_inspection() {
        let source = tempfile::tempdir().expect("source");
        write_development_package(source.path());
        let storage = tempfile::tempdir().expect("storage");
        let store = PluginInstallStore::open(storage.path()).expect("store");
        let preview = store.inspect_local(source.path()).expect("preview");
        fs::write(source.path().join("skills/workflow/SKILL.md"), b"changed")
            .expect("change source");

        assert!(matches!(
            store.install_local(&preview),
            Err(PluginError::ConcurrentModification { .. })
        ));
        assert!(store.installed().expect("installed list").is_empty());
    }

    #[test]
    fn managed_previews_are_owner_scoped_and_single_use() {
        let source = tempfile::tempdir().expect("source");
        write_development_package(source.path());
        let storage = tempfile::tempdir().expect("storage");
        let installer = PluginInstaller::open(storage.path()).expect("installer");
        let preview = installer
            .inspect_local_for("owner-a", source.path())
            .expect("preview");
        assert!(matches!(
            installer.install_preview_for("owner-b", &preview.id, false),
            Err(PluginError::PreviewNotFound(_))
        ));
        assert!(
            installer
                .install_preview_for("owner-a", &preview.id, false)
                .expect("install")
                .installed
        );
        assert!(matches!(
            installer.install_preview_for("owner-a", &preview.id, false),
            Err(PluginError::PreviewNotFound(_))
        ));
    }

    #[test]
    fn installed_version_removal_is_exact_and_confined() {
        let source = tempfile::tempdir().expect("source");
        write_development_package(source.path());
        let storage = tempfile::tempdir().expect("storage");
        let store = PluginInstallStore::open(storage.path()).expect("store");
        let preview = store.inspect_local(source.path()).expect("preview");
        let installed = store.install_local(&preview).expect("install").plugin;
        assert!(
            store
                .remove_installed_version(
                    &installed.manifest.id,
                    &installed.manifest.version,
                    &installed.revision,
                )
                .expect("remove")
        );
        assert!(store.installed().expect("installed").is_empty());
        assert!(
            !store
                .remove_installed_version(
                    &installed.manifest.id,
                    &installed.manifest.version,
                    &installed.revision,
                )
                .expect("already removed")
        );
        assert!(
            store
                .remove_installed_version("../../outside", "1.0.0", &installed.revision)
                .is_err()
        );
    }

    #[test]
    fn official_connector_sources_are_valid_unified_plugin_bundles() {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        for (directory, plugin_id, connector_id) in [
            ("hoi4", "official.hoi4", "hoi4"),
            ("lichess", "official.lichess", "lichess"),
            ("openttd", "official.openttd", "openttd"),
            ("victoria3", "official.victoria3", "victoria3"),
        ] {
            let loaded = LoadedPlugin::load(
                workspace
                    .join("Connectors/official")
                    .join(directory)
                    .join("package"),
                LoadPolicy::Development,
            )
            .unwrap_or_else(|error| panic!("{directory} plugin bundle failed: {error}"));
            assert_eq!(loaded.manifest.id, plugin_id);
            assert_eq!(loaded.manifest.components.runtimes.len(), 1);
            assert_eq!(loaded.manifest.components.runtimes[0].id, connector_id);
            assert_eq!(
                loaded.manifest.components.runtimes[0].kind,
                RuntimeKind::NativeWorker
            );
        }
    }
}
