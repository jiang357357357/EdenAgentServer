//! Validated skill catalog and model-facing skill tools.

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use eden_agent_core::{
    ContentBlock, DynamicToolSource, PermissionRequest, Tool, ToolCall, ToolCallContext,
    ToolDefinition, ToolExecutionMode, ToolFailure, ToolOutput,
};
use eden_agent_tools::{ProcessSandbox, SandboxedProgramRequest, run_sandboxed_program};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use thiserror::Error;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillDefinition {
    pub name: String,
    pub description: String,
    pub content: String,
    pub file_path: PathBuf,
    pub disable_model_invocation: bool,
    #[serde(default)]
    pub display_name: String,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub profiles: Vec<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub default_prompt: String,
    #[serde(default)]
    pub root_path: PathBuf,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub content_hash: String,
    #[serde(default)]
    pub total_bytes: u64,
    #[serde(default = "default_scope")]
    pub scope: String,
    #[serde(default = "default_source_type")]
    pub source_type: String,
    #[serde(default)]
    pub manifest: Value,
    #[serde(default, skip)]
    pub code_tools: Vec<SkillCodeToolDefinition>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkillCodeToolDefinition {
    pub skill_name: String,
    pub profiles: Vec<String>,
    pub name: String,
    pub label: String,
    pub description: String,
    pub parameters: Value,
    pub output_schema: Option<Value>,
    pub command: Vec<String>,
    pub test_command: Vec<String>,
    pub timeout_seconds: u64,
    pub revision: String,
    pub root_path: PathBuf,
    pub manifest_path: PathBuf,
}

fn default_version() -> String {
    "1".to_owned()
}

fn default_scope() -> String {
    "system".to_owned()
}

fn default_source_type() -> String {
    "builtin".to_owned()
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkillDiagnostic {
    pub code: String,
    pub message: String,
    pub path: PathBuf,
    #[serde(default)]
    pub r#type: String,
}

#[derive(Debug, Deserialize)]
struct LoadedCatalog {
    skills: Vec<SkillDefinition>,
    diagnostics: Vec<SkillDiagnostic>,
}

#[derive(Debug, Error)]
pub enum SkillError {
    #[error("skill catalog could not be decoded: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("duplicate skill name: {0}")]
    Duplicate(String),
    #[error("invalid skill name: {0}")]
    InvalidName(String),
    #[error("skill is not user-installed: {0}")]
    NotUserInstalled(String),
    #[error("skill filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Git skill source failed: {0}")]
    Git(String),
    #[error("unsafe skill package: {0}")]
    UnsafePackage(String),
    #[error("skill package changed after preview: {0}")]
    ConcurrentModification(String),
}

#[derive(Clone)]
struct SkillPreviewRecord {
    owner: String,
    skill: SkillDefinition,
    package_path: PathBuf,
    source: Value,
    scope: String,
    expires_at: i64,
}

#[derive(Clone)]
struct SkillUpdatePreview {
    candidate: SkillDefinition,
    base_hash: String,
    package_path: PathBuf,
}

#[derive(Clone)]
pub struct SkillCatalog {
    skills: Arc<RwLock<BTreeMap<String, SkillDefinition>>>,
    diagnostics: Arc<Vec<SkillDiagnostic>>,
    disabled: Arc<RwLock<BTreeSet<String>>>,
    install_root: Arc<PathBuf>,
    state_path: Arc<PathBuf>,
    roots: Arc<RwLock<Vec<PathBuf>>>,
    plugin_roots: Arc<RwLock<BTreeMap<String, Vec<PathBuf>>>>,
    previews: Arc<RwLock<BTreeMap<String, SkillPreviewRecord>>>,
    update_previews: Arc<RwLock<BTreeMap<String, SkillUpdatePreview>>>,
    known_tools: Arc<RwLock<BTreeSet<String>>>,
    code_tools_available: Arc<AtomicBool>,
}

impl SkillCatalog {
    pub fn discover(roots: &[PathBuf], install_root: PathBuf) -> Result<Self, SkillError> {
        fs::create_dir_all(&install_root)?;
        let mut roots = roots.to_vec();
        if !roots.iter().any(|root| root == &install_root) {
            roots.push(install_root.clone());
        }
        let directories = roots
            .iter()
            .map(|root| root.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let loaded: LoadedCatalog =
            serde_json::from_value(eden_agent_tools::load_skills(&directories))?;
        let mut skills = BTreeMap::new();
        for skill in loaded.skills {
            let skill = enrich_skill(skill, &install_root)?;
            let name = skill.name.clone();
            if skills.insert(name.clone(), skill).is_some() {
                return Err(SkillError::Duplicate(name));
            }
        }
        let catalog = Self {
            skills: Arc::new(RwLock::new(skills)),
            diagnostics: Arc::new(loaded.diagnostics),
            disabled: Arc::new(RwLock::new(load_disabled(&install_root)?)),
            state_path: Arc::new(install_root.join(".disabled.json")),
            roots: Arc::new(RwLock::new(roots)),
            plugin_roots: Arc::new(RwLock::new(BTreeMap::new())),
            install_root: Arc::new(install_root),
            previews: Arc::new(RwLock::new(BTreeMap::new())),
            update_previews: Arc::new(RwLock::new(BTreeMap::new())),
            known_tools: Arc::new(RwLock::new(BTreeSet::new())),
            code_tools_available: Arc::new(AtomicBool::new(false)),
        };
        catalog.validate_code_tool_catalog(
            &catalog
                .skills
                .read()
                .unwrap_or_else(|value| value.into_inner()),
        )?;
        Ok(catalog)
    }

    #[must_use]
    pub fn list(&self) -> Vec<SkillDefinition> {
        self.skills
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .values()
            .cloned()
            .collect()
    }

    #[must_use]
    pub fn diagnostics(&self) -> &[SkillDiagnostic] {
        &self.diagnostics
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<SkillDefinition> {
        self.skills
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .get(name)
            .cloned()
    }

    #[must_use]
    pub fn is_enabled(&self, name: &str) -> bool {
        !self
            .disabled
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .contains(name)
    }

    pub fn set_known_tools<I>(&self, names: I) -> Result<(), SkillError>
    where
        I: IntoIterator<Item = String>,
    {
        let replacement = names.into_iter().collect();
        let previous = {
            let mut known = self
                .known_tools
                .write()
                .unwrap_or_else(|value| value.into_inner());
            std::mem::replace(&mut *known, replacement)
        };
        let validation = self.validate_code_tool_catalog(
            &self
                .skills
                .read()
                .unwrap_or_else(|value| value.into_inner()),
        );
        if let Err(error) = validation {
            *self
                .known_tools
                .write()
                .unwrap_or_else(|value| value.into_inner()) = previous;
            return Err(error);
        }
        Ok(())
    }

    #[must_use]
    pub fn missing_tools(&self, skill: &SkillDefinition) -> Vec<String> {
        let known = self
            .known_tools
            .read()
            .unwrap_or_else(|value| value.into_inner());
        let code_tools_available = self.code_tools_available.load(Ordering::Acquire);
        let local_code_tools = skill
            .code_tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<BTreeSet<_>>();
        skill
            .tools
            .iter()
            .filter(|tool| {
                !known.contains(*tool)
                    && !(code_tools_available && local_code_tools.contains(tool.as_str()))
            })
            .cloned()
            .collect()
    }

    /// Re-scan all configured roots and atomically replace the visible catalog.
    /// Existing readers always observe either the old or the new complete snapshot.
    pub fn refresh(&self) -> Result<bool, SkillError> {
        let base_roots = self
            .roots
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .clone();
        let plugin_roots = self
            .plugin_roots
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .clone();
        let roots = effective_skill_roots(&base_roots, &plugin_roots);
        let directories = roots
            .iter()
            .map(|root| root.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let loaded: LoadedCatalog =
            serde_json::from_value(eden_agent_tools::load_skills(&directories))?;
        let mut refreshed = BTreeMap::new();
        for skill in loaded.skills {
            let mut skill = enrich_skill(skill, self.install_root.as_ref())?;
            mark_plugin_skill(&mut skill, &plugin_roots);
            self.validate_skill_policy(&skill)?;
            let name = skill.name.clone();
            if refreshed.insert(name.clone(), skill).is_some() {
                return Err(SkillError::Duplicate(name));
            }
        }
        self.validate_code_tool_catalog(&refreshed)?;
        let mut current = self
            .skills
            .write()
            .unwrap_or_else(|value| value.into_inner());
        if *current == refreshed {
            return Ok(false);
        }
        *current = refreshed;
        Ok(true)
    }

    #[must_use]
    pub fn roots(&self) -> Vec<PathBuf> {
        self.roots
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .clone()
    }

    /// Validate and atomically publish a replacement set of discovery roots.
    /// The user install root is always retained.
    pub fn replace_roots(&self, mut roots: Vec<PathBuf>) -> Result<bool, SkillError> {
        if !roots.iter().any(|root| root == self.install_root.as_ref()) {
            roots.push(self.install_root.as_ref().clone());
        }
        let plugin_roots = self
            .plugin_roots
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .clone();
        let effective_roots = effective_skill_roots(&roots, &plugin_roots);
        let directories = effective_roots
            .iter()
            .map(|root| root.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let loaded: LoadedCatalog =
            serde_json::from_value(eden_agent_tools::load_skills(&directories))?;
        let mut refreshed = BTreeMap::new();
        for skill in loaded.skills {
            let mut skill = enrich_skill(skill, self.install_root.as_ref())?;
            mark_plugin_skill(&mut skill, &plugin_roots);
            self.validate_skill_policy(&skill)?;
            let name = skill.name.clone();
            if refreshed.insert(name.clone(), skill).is_some() {
                return Err(SkillError::Duplicate(name));
            }
        }
        self.validate_code_tool_catalog(&refreshed)?;
        let mut current = self
            .skills
            .write()
            .unwrap_or_else(|value| value.into_inner());
        let changed = *current != refreshed;
        *current = refreshed;
        *self
            .roots
            .write()
            .unwrap_or_else(|value| value.into_inner()) = roots;
        Ok(changed)
    }

    /// Atomically publish discovery roots owned by one plugin. Workspace root
    /// replacement cannot remove these roots; disabling the plugin must do so
    /// explicitly through `remove_plugin_roots`.
    pub fn set_plugin_roots(
        &self,
        plugin_id: &str,
        roots: Vec<PathBuf>,
    ) -> Result<bool, SkillError> {
        if plugin_id.trim().is_empty() {
            return Err(SkillError::UnsafePackage(
                "plugin ID cannot be empty".to_owned(),
            ));
        }
        let mut canonical = roots
            .into_iter()
            .map(fs::canonicalize)
            .collect::<Result<Vec<_>, _>>()?;
        canonical.sort();
        canonical.dedup();
        let mut plugin_roots = self
            .plugin_roots
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .clone();
        plugin_roots.insert(plugin_id.to_owned(), canonical);
        self.publish_plugin_roots(plugin_roots)
    }

    pub fn remove_plugin_roots(&self, plugin_id: &str) -> Result<bool, SkillError> {
        let mut plugin_roots = self
            .plugin_roots
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .clone();
        if plugin_roots.remove(plugin_id).is_none() {
            return Ok(false);
        }
        self.publish_plugin_roots(plugin_roots)
    }

    fn publish_plugin_roots(
        &self,
        plugin_roots: BTreeMap<String, Vec<PathBuf>>,
    ) -> Result<bool, SkillError> {
        let base_roots = self
            .roots
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .clone();
        let effective_roots = effective_skill_roots(&base_roots, &plugin_roots);
        let directories = effective_roots
            .iter()
            .map(|root| root.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let loaded: LoadedCatalog =
            serde_json::from_value(eden_agent_tools::load_skills(&directories))?;
        let mut refreshed = BTreeMap::new();
        for skill in loaded.skills {
            let mut skill = enrich_skill(skill, self.install_root.as_ref())?;
            mark_plugin_skill(&mut skill, &plugin_roots);
            self.validate_skill_policy(&skill)?;
            let name = skill.name.clone();
            if refreshed.insert(name.clone(), skill).is_some() {
                return Err(SkillError::Duplicate(name));
            }
        }
        self.validate_code_tool_catalog(&refreshed)?;
        let mut current = self
            .skills
            .write()
            .unwrap_or_else(|value| value.into_inner());
        let changed = *current != refreshed;
        *current = refreshed;
        *self
            .plugin_roots
            .write()
            .unwrap_or_else(|value| value.into_inner()) = plugin_roots;
        Ok(changed)
    }

    pub fn install(
        &self,
        name: &str,
        description: &str,
        content: &str,
    ) -> Result<SkillDefinition, SkillError> {
        self.install_with_metadata(name, name, description, content, &[], &[])
    }

    pub fn install_with_metadata(
        &self,
        name: &str,
        display_name: &str,
        description: &str,
        content: &str,
        tools: &[String],
        profiles: &[String],
    ) -> Result<SkillDefinition, SkillError> {
        self.install_generated_package(
            name,
            display_name,
            "1",
            description,
            content,
            tools,
            profiles,
            &[],
            "",
            "user",
            None,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn install_generated_package(
        &self,
        name: &str,
        display_name: &str,
        version: &str,
        description: &str,
        content: &str,
        tools: &[String],
        profiles: &[String],
        permissions: &[String],
        default_prompt: &str,
        scope: &str,
        files: Option<&Value>,
    ) -> Result<SkillDefinition, SkillError> {
        validate_name(name)?;
        validate_scope(scope)?;
        if self.get(name).is_some() {
            return Err(SkillError::Duplicate(name.to_owned()));
        }
        if description.trim().is_empty() || content.trim().is_empty() {
            return Err(SkillError::InvalidName(
                "description and content are required".to_owned(),
            ));
        }
        let installation_root = self.installation_root(scope)?;
        let directory = installation_root.join(name);
        if directory.exists() {
            return Err(SkillError::Duplicate(name.to_owned()));
        }
        let staging = tempfile::Builder::new()
            .prefix(".skill-stage-")
            .tempdir_in(&installation_root)?;
        let staged_directory = staging.path().join(name);
        fs::create_dir(&staged_directory)?;
        let frontmatter = render_skill_file(SkillFileContent {
            name,
            display_name,
            version,
            description,
            content,
            tools,
            profiles,
            permissions,
            default_prompt,
        });
        fs::write(staged_directory.join("SKILL.md"), frontmatter)?;
        apply_generated_file_changes(&staged_directory, files, false)?;
        fs::write(
            staged_directory.join(INSTALLATION_MANIFEST),
            serde_json::to_vec_pretty(&json!({
                "schemaVersion":1,
                "installationID":uuid::Uuid::now_v7().to_string(),
                "scope":scope,
                "source":{"type":"generated"},
                "sourceType":"generated",
                "installedAt":chrono_now_ms(),
            }))?,
        )?;
        let loaded: LoadedCatalog =
            serde_json::from_value(eden_agent_tools::load_skills(&[staged_directory
                .to_string_lossy()
                .into_owned()]))?;
        let staged_skill = loaded
            .skills
            .into_iter()
            .next()
            .ok_or_else(|| SkillError::InvalidName(name.to_owned()))?;
        let staged_skill = enrich_skill(staged_skill, self.install_root.as_ref())?;
        self.validate_package_metadata(&staged_skill)?;
        fs::rename(&staged_directory, &directory)?;
        let skill = load_one_skill(&directory, self.install_root.as_ref())?;
        self.skills
            .write()
            .unwrap_or_else(|value| value.into_inner())
            .insert(name.to_owned(), skill.clone());
        self.set_enabled(name, true)?;
        Ok(skill)
    }

    pub fn inspect_local(
        &self,
        source: &Path,
        subpath: Option<&str>,
    ) -> Result<(String, SkillDefinition), SkillError> {
        self.inspect_local_for("local", source, subpath, "user", "local", None)
    }

    pub fn inspect_local_for(
        &self,
        owner: &str,
        source: &Path,
        subpath: Option<&str>,
        scope: &str,
        source_type: &str,
        source_metadata: Option<Value>,
    ) -> Result<(String, SkillDefinition), SkillError> {
        validate_scope(scope)?;
        let root = fs::canonicalize(source)?;
        let target = if let Some(subpath) = subpath.filter(|value| !value.trim().is_empty()) {
            fs::canonicalize(root.join(subpath))?
        } else {
            root.clone()
        };
        if !target.starts_with(&root) {
            return Err(SkillError::InvalidName(
                "skill subpath escapes source root".to_owned(),
            ));
        }
        let loaded: LoadedCatalog =
            serde_json::from_value(eden_agent_tools::load_skills(&[target
                .to_string_lossy()
                .into_owned()]))?;
        let skill =
            loaded.skills.into_iter().next().ok_or_else(|| {
                SkillError::InvalidName("source contains no valid skill".to_owned())
            })?;
        let package_root = skill
            .file_path
            .parent()
            .ok_or_else(|| {
                SkillError::UnsafePackage("SKILL.md has no parent directory".to_owned())
            })?
            .to_owned();
        let mut skill = enrich_skill(skill, self.install_root.as_ref())?;
        self.validate_package_metadata(&skill)?;
        let preview_id = uuid::Uuid::now_v7().to_string();
        let preview_root = tempfile::Builder::new()
            .prefix("edenagent-skill-preview-")
            .tempdir()?
            .keep();
        copy_skill_package(&package_root, &preview_root)?;
        skill.root_path = preview_root.clone();
        skill.file_path = preview_root.join("SKILL.md");
        skill.scope = scope.to_owned();
        skill.source_type = source_type.to_owned();
        let source_value = source_metadata.unwrap_or_else(|| {
            json!({
                "type":source_type,
                "uri":source.to_string_lossy(),
                "ref":"",
                "subpath":subpath.unwrap_or(""),
            })
        });
        self.previews
            .write()
            .unwrap_or_else(|value| value.into_inner())
            .insert(
                preview_id.clone(),
                SkillPreviewRecord {
                    owner: owner.to_owned(),
                    skill: skill.clone(),
                    package_path: preview_root,
                    source: source_value,
                    scope: scope.to_owned(),
                    expires_at: chrono_now_ms().saturating_add(900_000),
                },
            );
        Ok((preview_id, skill))
    }

    pub fn inspect_git(
        &self,
        source: &str,
        reference: Option<&str>,
        subpath: Option<&str>,
    ) -> Result<(String, SkillDefinition), SkillError> {
        self.inspect_git_for("local", source, reference, subpath, "user")
    }

    pub fn inspect_git_for(
        &self,
        owner: &str,
        source: &str,
        reference: Option<&str>,
        subpath: Option<&str>,
        scope: &str,
    ) -> Result<(String, SkillDefinition), SkillError> {
        let source = source.trim();
        if source.starts_with('-')
            || !(source.starts_with("https://")
                || source.starts_with("http://")
                || source.starts_with("ssh://")
                || source.starts_with("git@"))
        {
            return Err(SkillError::Git(
                "source must be an HTTP(S) or SSH Git repository URL".to_owned(),
            ));
        }
        if reference.is_some_and(|value| value.starts_with('-') || value.contains(['\r', '\n'])) {
            return Err(SkillError::Git("invalid Git ref".to_owned()));
        }
        let checkout = tempfile::tempdir()?;
        let mut command = std::process::Command::new("git");
        command.args(["clone", "--depth", "1"]);
        if let Some(reference) = reference.filter(|value| !value.trim().is_empty()) {
            command.args(["--branch", reference.trim()]);
        }
        let output = command.arg(source).arg(checkout.path()).output()?;
        if !output.status.success() {
            return Err(SkillError::Git(
                String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            ));
        }
        self.inspect_local_for(
            owner,
            checkout.path(),
            subpath,
            scope,
            "git",
            Some(json!({
                "type":"git",
                "uri":source,
                "ref":reference.unwrap_or(""),
                "subpath":subpath.unwrap_or(""),
            })),
        )
    }

    pub fn install_preview(&self, preview_id: &str) -> Result<SkillDefinition, SkillError> {
        self.install_preview_for("local", preview_id)
    }

    pub fn install_preview_for(
        &self,
        owner: &str,
        preview_id: &str,
    ) -> Result<SkillDefinition, SkillError> {
        let preview = self
            .previews
            .write()
            .unwrap_or_else(|value| value.into_inner())
            .remove(preview_id)
            .ok_or_else(|| {
                SkillError::InvalidName("unknown or expired skill preview".to_owned())
            })?;
        if preview.owner != owner || preview.expires_at < chrono_now_ms() {
            let _ = fs::remove_dir_all(&preview.package_path);
            return Err(SkillError::InvalidName(
                "unknown or expired skill preview".to_owned(),
            ));
        }
        if package_hash(&preview.package_path)? != preview.skill.content_hash {
            let _ = fs::remove_dir_all(&preview.package_path);
            return Err(SkillError::ConcurrentModification(preview.skill.name));
        }
        let installation_root = self.installation_root(&preview.scope)?;
        let destination = installation_root.join(&preview.skill.name);
        if destination.exists() || self.get(&preview.skill.name).is_some() {
            let _ = fs::remove_dir_all(&preview.package_path);
            return Err(SkillError::Duplicate(preview.skill.name));
        }
        let staging = tempfile::Builder::new()
            .prefix(".skill-stage-")
            .tempdir_in(&installation_root)?;
        let staged = staging.path().join(&preview.skill.name);
        fs::create_dir(&staged)?;
        copy_skill_package(&preview.package_path, &staged)?;
        let manifest = json!({
            "schemaVersion":1,
            "installationID":uuid::Uuid::now_v7().to_string(),
            "owner":owner,
            "scope":preview.scope,
            "source":preview.source,
            "sourceType":preview.skill.source_type,
            "contentHash":preview.skill.content_hash,
            "installedAt":chrono_now_ms(),
        });
        fs::write(
            staged.join(".edenagent-install.json"),
            serde_json::to_vec_pretty(&manifest)?,
        )?;
        let staged_skill = load_one_skill(&staged, self.install_root.as_ref())?;
        self.validate_package_metadata(&staged_skill)?;
        fs::rename(&staged, &destination)?;
        let skill = load_one_skill(&destination, self.install_root.as_ref())?;
        self.skills
            .write()
            .unwrap_or_else(|value| value.into_inner())
            .insert(skill.name.clone(), skill.clone());
        self.set_enabled(&skill.name, true)?;
        let _ = fs::remove_dir_all(&preview.package_path);
        Ok(skill)
    }

    pub fn preview_update(
        &self,
        name: &str,
        description: Option<&str>,
        content: Option<&str>,
    ) -> Result<(String, SkillDefinition), SkillError> {
        self.preview_update_with_metadata(name, description, content, None, None)
    }

    pub fn preview_update_with_metadata(
        &self,
        name: &str,
        description: Option<&str>,
        content: Option<&str>,
        tools: Option<&[String]>,
        profiles: Option<&[String]>,
    ) -> Result<(String, SkillDefinition), SkillError> {
        let (preview_id, candidate, _) = self.preview_generated_update(
            name,
            None,
            None,
            description,
            content,
            None,
            tools,
            profiles,
            None,
            None,
            None,
        )?;
        Ok((preview_id, candidate))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn preview_generated_update(
        &self,
        name: &str,
        expected_content_hash: Option<&str>,
        display_name: Option<&str>,
        description: Option<&str>,
        content: Option<&str>,
        version: Option<&str>,
        tools: Option<&[String]>,
        profiles: Option<&[String]>,
        permissions: Option<&[String]>,
        default_prompt: Option<&str>,
        files: Option<&Value>,
    ) -> Result<(String, SkillDefinition, Vec<String>), SkillError> {
        let current = self
            .get(name)
            .ok_or_else(|| SkillError::InvalidName(name.to_owned()))?;
        if current.source_type != "generated" {
            return Err(SkillError::NotUserInstalled(format!(
                "{} is not a generated skill",
                current.name
            )));
        }
        let directory = self.ensure_managed_installed(&current)?;
        let base_hash = package_hash(&directory)?;
        if expected_content_hash
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some_and(|expected| expected != base_hash)
        {
            return Err(SkillError::ConcurrentModification(name.to_owned()));
        }
        let preview_root = tempfile::Builder::new()
            .prefix("edenagent-skill-update-preview-")
            .tempdir()?
            .keep();
        copy_skill_package(&directory, &preview_root)?;
        let next_display_name = display_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&current.display_name);
        let next_description = description
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&current.description);
        let next_content = content
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&current.content);
        let next_version = version
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&current.version);
        let next_tools = tools.unwrap_or(&current.tools);
        let next_profiles = profiles.unwrap_or(&current.profiles);
        let next_permissions = permissions.unwrap_or(&current.permissions);
        let next_default_prompt = default_prompt.unwrap_or(&current.default_prompt);
        let rendered = render_skill_file(SkillFileContent {
            name: &current.name,
            display_name: next_display_name,
            version: next_version,
            description: next_description,
            content: next_content,
            tools: next_tools,
            profiles: next_profiles,
            permissions: next_permissions,
            default_prompt: next_default_prompt,
        });
        let previous_skill_file = fs::read_to_string(preview_root.join("SKILL.md"))?;
        fs::write(preview_root.join("SKILL.md"), &rendered)?;
        let mut changed_files = apply_generated_file_changes(&preview_root, files, true)?;
        if rendered != previous_skill_file {
            changed_files.push("SKILL.md".to_owned());
        }
        changed_files.sort();
        changed_files.dedup();
        let candidate = load_one_skill(&preview_root, self.install_root.as_ref())?;
        self.validate_package_metadata(&candidate)?;
        let preview_id = uuid::Uuid::now_v7().to_string();
        self.update_previews
            .write()
            .unwrap_or_else(|value| value.into_inner())
            .insert(
                preview_id.clone(),
                SkillUpdatePreview {
                    candidate: candidate.clone(),
                    base_hash,
                    package_path: preview_root,
                },
            );
        Ok((preview_id, candidate, changed_files))
    }

    pub fn apply_update(&self, preview_id: &str) -> Result<SkillDefinition, SkillError> {
        let preview = self
            .update_previews
            .write()
            .unwrap_or_else(|value| value.into_inner())
            .remove(preview_id)
            .ok_or_else(|| {
                SkillError::InvalidName("unknown or expired update preview".to_owned())
            })?;
        let candidate = preview.candidate;
        let current = self
            .get(&candidate.name)
            .ok_or_else(|| SkillError::InvalidName(candidate.name.clone()))?;
        if current.scope != candidate.scope {
            let _ = fs::remove_dir_all(&preview.package_path);
            return Err(SkillError::ConcurrentModification(candidate.name));
        }
        let directory = self.ensure_managed_installed(&current)?;
        if package_hash(&directory)? != preview.base_hash {
            let _ = fs::remove_dir_all(&preview.package_path);
            return Err(SkillError::ConcurrentModification(candidate.name));
        }
        let staging = tempfile::Builder::new()
            .prefix(".skill-update-")
            .tempdir_in(
                directory
                    .parent()
                    .ok_or_else(|| SkillError::NotUserInstalled(candidate.name.clone()))?,
            )?;
        let staged = staging.path().join(&candidate.name);
        fs::create_dir(&staged)?;
        copy_skill_package(&preview.package_path, &staged)?;
        let staged_skill = load_one_skill(&staged, self.install_root.as_ref())?;
        self.validate_package_metadata(&staged_skill)?;
        let backup = directory
            .parent()
            .ok_or_else(|| SkillError::NotUserInstalled(candidate.name.clone()))?
            .join(format!(".skill-backup-{}", uuid::Uuid::now_v7()));
        fs::rename(&directory, &backup)?;
        if let Err(error) = fs::rename(&staged, &directory) {
            let _ = fs::rename(&backup, &directory);
            return Err(SkillError::Io(error));
        }
        fs::remove_dir_all(backup)?;
        let _ = fs::remove_dir_all(&preview.package_path);
        let candidate = load_one_skill(&directory, self.install_root.as_ref())?;
        self.skills
            .write()
            .unwrap_or_else(|value| value.into_inner())
            .insert(candidate.name.clone(), candidate.clone());
        Ok(candidate)
    }

    fn installation_root(&self, scope: &str) -> Result<PathBuf, SkillError> {
        validate_scope(scope)?;
        let root = if scope == "user" {
            self.install_root.as_ref().clone()
        } else {
            self.roots()
                .into_iter()
                .find(|root| root.ends_with(Path::new(".agents/skills")))
                .ok_or_else(|| {
                    SkillError::UnsafePackage(
                        "project skill root .agents/skills is not configured".to_owned(),
                    )
                })?
        };
        fs::create_dir_all(&root)?;
        Ok(fs::canonicalize(root)?)
    }

    fn ensure_managed_installed(&self, skill: &SkillDefinition) -> Result<PathBuf, SkillError> {
        let root = self.installation_root(&skill.scope)?;
        let directory = skill
            .file_path
            .parent()
            .and_then(|value| fs::canonicalize(value).ok())
            .ok_or_else(|| SkillError::NotUserInstalled(skill.name.clone()))?;
        if !directory.starts_with(&root) || directory == root {
            return Err(SkillError::NotUserInstalled(skill.name.clone()));
        }
        Ok(directory)
    }

    pub fn set_enabled(&self, name: &str, enabled: bool) -> Result<SkillDefinition, SkillError> {
        let skill = self
            .get(name)
            .ok_or_else(|| SkillError::InvalidName(name.to_owned()))?;
        let mut disabled = self
            .disabled
            .write()
            .unwrap_or_else(|value| value.into_inner());
        if enabled {
            disabled.remove(name);
        } else {
            disabled.insert(name.to_owned());
        }
        persist_disabled(&self.state_path, &disabled)?;
        Ok(skill)
    }

    pub fn uninstall(&self, name: &str) -> Result<(), SkillError> {
        let skill = self
            .get(name)
            .ok_or_else(|| SkillError::InvalidName(name.to_owned()))?;
        let root = self.installation_root(&skill.scope)?;
        let directory = skill
            .file_path
            .parent()
            .and_then(|value| fs::canonicalize(value).ok())
            .ok_or_else(|| SkillError::NotUserInstalled(name.to_owned()))?;
        if !directory.starts_with(&root) || directory == root {
            return Err(SkillError::NotUserInstalled(name.to_owned()));
        }
        fs::remove_dir_all(directory)?;
        self.skills
            .write()
            .unwrap_or_else(|value| value.into_inner())
            .remove(name);
        let mut disabled = self
            .disabled
            .write()
            .unwrap_or_else(|value| value.into_inner());
        disabled.remove(name);
        persist_disabled(&self.state_path, &disabled)?;
        Ok(())
    }

    #[must_use]
    pub fn inventory_prompt(&self) -> String {
        let skills = self
            .skills
            .read()
            .unwrap_or_else(|value| value.into_inner());
        if skills.is_empty() {
            return String::new();
        }
        let entries = skills
            .values()
            .filter(|skill| {
                !skill.disable_model_invocation
                    && self.is_enabled(&skill.name)
                    && self.missing_tools(skill).is_empty()
            })
            .map(|skill| {
                let profiles = if skill.profiles.is_empty() {
                    "profiles: user_chat, self_awake".to_owned()
                } else {
                    format!("profiles: {}", skill.profiles.join(", "))
                };
                format!("- {} ({profiles}): {}", skill.name, skill.description)
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "\n\nAvailable skills:\n{entries}\nUse load_skill only when a skill is relevant, then follow its instructions."
        )
    }

    /// Resolve an explicit skill set into a stable prompt snapshot for one runtime profile.
    /// Profile declarations and host tool dependencies are checked before any agent starts.
    pub fn prompt_snapshot_for_profile(
        &self,
        names: &[String],
        profile: &str,
    ) -> Result<String, SkillError> {
        let mut seen = BTreeSet::new();
        let mut sections = Vec::new();
        for name in names {
            if !seen.insert(name.clone()) {
                continue;
            }
            let skill = self
                .get(name)
                .ok_or_else(|| SkillError::InvalidName(name.clone()))?;
            if !self.is_enabled(name) || skill.disable_model_invocation {
                return Err(SkillError::UnsafePackage(format!(
                    "skill {name} is disabled or not model-invocable"
                )));
            }
            let profile_allowed = if skill.profiles.is_empty() {
                matches!(profile, "user_chat" | "self_awake")
            } else {
                skill.profiles.iter().any(|value| value == profile)
            };
            if !profile_allowed {
                return Err(SkillError::UnsafePackage(format!(
                    "skill {name} is not available in profile {profile}"
                )));
            }
            let missing = self.missing_tools(&skill);
            if !missing.is_empty() {
                return Err(SkillError::UnsafePackage(format!(
                    "skill {name} requires unavailable tools: {}",
                    missing.join(", ")
                )));
            }
            sections.push(format!(
                "# Preloaded skill: {}\nVersion: {}. Content hash: {}. Declared host permissions: {}. These declarations never grant access; runtime tool policy remains authoritative.\n\n{}",
                skill.name,
                skill.version,
                skill.content_hash,
                if skill.permissions.is_empty() {
                    "none".to_owned()
                } else {
                    skill.permissions.join(", ")
                },
                skill.content
            ));
        }
        Ok(sections.join("\n\n"))
    }

    #[must_use]
    pub fn tools(&self) -> Vec<Arc<dyn Tool>> {
        vec![
            Arc::new(ListSkillsTool(self.clone())),
            Arc::new(LoadSkillTool(self.clone())),
            Arc::new(CreateSkillTool(self.clone())),
            Arc::new(UpdateSkillTool(self.clone())),
        ]
    }

    /// Expose enabled skill-defined code tools through a reloadable registry
    /// source. No source is returned when process isolation is unavailable.
    pub fn code_tool_source(&self, sandbox: ProcessSandbox) -> Option<Arc<dyn DynamicToolSource>> {
        if !sandbox.is_available() {
            self.code_tools_available.store(false, Ordering::Release);
            return None;
        }
        self.code_tools_available.store(true, Ordering::Release);
        Some(Arc::new(SkillCodeToolSource {
            catalog: self.clone(),
            sandbox,
            tested_revisions: Arc::new(tokio::sync::Mutex::new(BTreeSet::new())),
        }))
    }

    fn validate_declared_tools(&self, skill: &SkillDefinition) -> Result<(), SkillError> {
        let known = self
            .known_tools
            .read()
            .unwrap_or_else(|value| value.into_inner());
        if known.is_empty() {
            return Ok(());
        }
        let local_code_tools = skill
            .code_tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<BTreeSet<_>>();
        let unknown = skill
            .tools
            .iter()
            .filter(|tool| !known.contains(*tool) && !local_code_tools.contains(tool.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if unknown.is_empty() {
            Ok(())
        } else {
            Err(SkillError::UnsafePackage(format!(
                "unknown tools declared by {}: {}",
                skill.name,
                unknown.join(", ")
            )))
        }
    }

    fn validate_package_metadata(&self, skill: &SkillDefinition) -> Result<(), SkillError> {
        self.validate_skill_policy(skill)?;
        self.validate_declared_tools(skill)?;
        self.validate_code_tool_collisions(skill)
    }

    fn validate_code_tool_collisions(&self, candidate: &SkillDefinition) -> Result<(), SkillError> {
        let known = self
            .known_tools
            .read()
            .unwrap_or_else(|value| value.into_inner());
        let skills = self
            .skills
            .read()
            .unwrap_or_else(|value| value.into_inner());
        for tool in &candidate.code_tools {
            if known.contains(&tool.name) {
                return Err(SkillError::UnsafePackage(format!(
                    "code tool {} from {} collides with a host tool",
                    tool.name, candidate.name
                )));
            }
            if let Some(owner) = skills.values().find(|skill| {
                skill.name != candidate.name
                    && skill
                        .code_tools
                        .iter()
                        .any(|existing| existing.name == tool.name)
            }) {
                return Err(SkillError::UnsafePackage(format!(
                    "code tool {} from {} collides with skill {}",
                    tool.name, candidate.name, owner.name
                )));
            }
        }
        Ok(())
    }

    fn validate_code_tool_catalog(
        &self,
        skills: &BTreeMap<String, SkillDefinition>,
    ) -> Result<(), SkillError> {
        for skill in skills.values() {
            self.validate_skill_policy(skill)?;
        }
        let known = self
            .known_tools
            .read()
            .unwrap_or_else(|value| value.into_inner());
        let mut owners = BTreeMap::<String, String>::new();
        for skill in skills.values() {
            for tool in &skill.code_tools {
                if known.contains(&tool.name) {
                    return Err(SkillError::UnsafePackage(format!(
                        "code tool {} from {} collides with a host tool",
                        tool.name, skill.name
                    )));
                }
                if let Some(owner) = owners.insert(tool.name.clone(), skill.name.clone()) {
                    return Err(SkillError::UnsafePackage(format!(
                        "code tool {} is declared by both {} and {}",
                        tool.name, owner, skill.name
                    )));
                }
            }
        }
        Ok(())
    }

    fn validate_skill_policy(&self, skill: &SkillDefinition) -> Result<(), SkillError> {
        let invalid_profiles = skill
            .profiles
            .iter()
            .filter(|profile| !matches!(profile.as_str(), "user_chat" | "self_awake" | "subagent"))
            .cloned()
            .collect::<Vec<_>>();
        if !invalid_profiles.is_empty() {
            return Err(SkillError::UnsafePackage(format!(
                "unknown profiles declared by {}: {}",
                skill.name,
                invalid_profiles.join(", ")
            )));
        }
        if skill.permissions.iter().any(|permission| {
            permission.is_empty()
                || permission.len() > 96
                || !permission.chars().all(|value| {
                    value.is_ascii_alphanumeric() || matches!(value, '.' | ':' | '_' | '-')
                })
        }) {
            return Err(SkillError::UnsafePackage(format!(
                "invalid permission declaration in {}",
                skill.name
            )));
        }
        Ok(())
    }
}

const MAX_PACKAGE_FILES: usize = 256;
const MAX_PACKAGE_BYTES: u64 = 32 * 1024 * 1024;
const INSTALLATION_MANIFEST: &str = ".edenagent-install.json";

struct SkillFileContent<'a> {
    name: &'a str,
    display_name: &'a str,
    version: &'a str,
    description: &'a str,
    content: &'a str,
    tools: &'a [String],
    profiles: &'a [String],
    permissions: &'a [String],
    default_prompt: &'a str,
}

fn render_skill_file(skill: SkillFileContent<'_>) -> String {
    let quoted = |value: &str| serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned());
    format!(
        "---\nname: {}\ndescription: {}\nmetadata:\n  edenagent:\n    display_name: {}\n    version: {}\n    tools: {}\n    profiles: {}\n    permissions: {}\n    default_prompt: {}\n---\n{}\n",
        quoted(skill.name),
        quoted(skill.description.trim()),
        quoted(skill.display_name.trim()),
        quoted(skill.version.trim()),
        serde_json::to_string(skill.tools).unwrap_or_else(|_| "[]".to_owned()),
        serde_json::to_string(skill.profiles).unwrap_or_else(|_| "[]".to_owned()),
        serde_json::to_string(skill.permissions).unwrap_or_else(|_| "[]".to_owned()),
        quoted(skill.default_prompt.trim()),
        skill.content.trim(),
    )
}

fn effective_skill_roots(
    base_roots: &[PathBuf],
    plugin_roots: &BTreeMap<String, Vec<PathBuf>>,
) -> Vec<PathBuf> {
    let mut seen = BTreeSet::new();
    base_roots
        .iter()
        .chain(plugin_roots.values().flatten())
        .filter(|root| seen.insert((*root).clone()))
        .cloned()
        .collect()
}

fn mark_plugin_skill(skill: &mut SkillDefinition, plugin_roots: &BTreeMap<String, Vec<PathBuf>>) {
    let Some(plugin_id) = plugin_roots.iter().find_map(|(plugin_id, roots)| {
        roots
            .iter()
            .any(|root| skill.root_path.starts_with(root))
            .then_some(plugin_id)
    }) else {
        return;
    };
    skill.scope = "plugin".to_owned();
    skill.source_type = "plugin".to_owned();
    let mut manifest = skill.manifest.as_object().cloned().unwrap_or_default();
    manifest.insert("pluginId".to_owned(), Value::String(plugin_id.clone()));
    skill.manifest = Value::Object(manifest);
}

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn validate_scope(scope: &str) -> Result<(), SkillError> {
    if matches!(scope, "user" | "project") {
        Ok(())
    } else {
        Err(SkillError::UnsafePackage(format!(
            "unsupported skill scope: {scope}"
        )))
    }
}

fn load_one_skill(directory: &Path, install_root: &Path) -> Result<SkillDefinition, SkillError> {
    let loaded: LoadedCatalog =
        serde_json::from_value(eden_agent_tools::load_skills(&[directory
            .to_string_lossy()
            .into_owned()]))?;
    let skill =
        loaded.skills.into_iter().next().ok_or_else(|| {
            SkillError::InvalidName("package contains no valid SKILL.md".to_owned())
        })?;
    enrich_skill(skill, install_root)
}

fn enrich_skill(
    mut skill: SkillDefinition,
    install_root: &Path,
) -> Result<SkillDefinition, SkillError> {
    let root = skill
        .file_path
        .parent()
        .ok_or_else(|| SkillError::UnsafePackage("SKILL.md has no parent directory".to_owned()))?;
    let root = fs::canonicalize(root)?;
    let files = package_files(&root)?;
    let frontmatter = parse_frontmatter(&skill.file_path)?;
    let edenagent = frontmatter
        .get("metadata")
        .and_then(|value| value.get("edenagent"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let string = |name: &str| {
        edenagent
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    let strings = |name: &str| {
        edenagent
            .get(name)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let manifest_path = root.join(INSTALLATION_MANIFEST);
    let manifest = if manifest_path.is_file() {
        serde_json::from_slice(&fs::read(&manifest_path)?)?
    } else {
        Value::Null
    };
    let canonical_install_root =
        fs::canonicalize(install_root).unwrap_or_else(|_| install_root.to_owned());
    let user_installed =
        root.starts_with(&canonical_install_root) && root != canonical_install_root;
    let path_text = root.to_string_lossy().replace('\\', "/");
    let scope = manifest
        .get("scope")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if user_installed {
                "user".to_owned()
            } else if path_text.contains("/.agents/skills/") {
                "project".to_owned()
            } else {
                "system".to_owned()
            }
        });
    let source_type = manifest
        .get("sourceType")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if user_installed {
                "generated".to_owned()
            } else if scope == "system" {
                "builtin".to_owned()
            } else {
                "local".to_owned()
            }
        });
    skill.display_name = {
        let value = string("display_name");
        if value.is_empty() {
            skill.name.clone()
        } else {
            value
        }
    };
    skill.version = {
        let value = string("version");
        if value.is_empty() {
            default_version()
        } else {
            value
        }
    };
    skill.tools = strings("tools");
    skill.profiles = strings("profiles");
    skill.permissions = strings("permissions");
    skill.default_prompt = string("default_prompt");
    skill.root_path = root.clone();
    skill.files = files
        .iter()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .collect();
    skill.content_hash = package_hash_from_files(&root, &files)?;
    skill.total_bytes = files.iter().try_fold(0_u64, |total, relative| {
        Ok::<_, std::io::Error>(total.saturating_add(fs::metadata(root.join(relative))?.len()))
    })?;
    skill.scope = scope;
    skill.source_type = source_type;
    skill.manifest = manifest;
    skill.code_tools = load_skill_code_tools(&root, &skill.name, &skill.content_hash)?;
    for tool in &mut skill.code_tools {
        tool.profiles.clone_from(&skill.profiles);
    }
    Ok(skill)
}

const MAX_CODE_TOOL_TIMEOUT_SECONDS: u64 = 120;

fn load_skill_code_tools(
    root: &Path,
    skill_name: &str,
    revision: &str,
) -> Result<Vec<SkillCodeToolDefinition>, SkillError> {
    let directory = root.join("tools");
    if !directory.is_dir() {
        return Ok(Vec::new());
    }
    let mut manifests = fs::read_dir(&directory)?.collect::<Result<Vec<_>, _>>()?;
    manifests.sort_by_key(std::fs::DirEntry::file_name);
    let mut names = BTreeSet::new();
    let mut tools = Vec::new();
    for entry in manifests {
        let path = entry.path();
        if !entry.file_type()?.is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("json")
        {
            return Err(SkillError::UnsafePackage(format!(
                "tools may contain only root-level JSON manifests: {}",
                path.strip_prefix(root).unwrap_or(&path).display()
            )));
        }
        let manifest: Value = serde_json::from_slice(&fs::read(&path)?).map_err(|error| {
            SkillError::UnsafePackage(format!(
                "invalid code-tool JSON {}: {error}",
                path.strip_prefix(root).unwrap_or(&path).display()
            ))
        })?;
        if manifest.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
            return Err(SkillError::UnsafePackage(format!(
                "code-tool schemaVersion must be 1: {}",
                path.strip_prefix(root).unwrap_or(&path).display()
            )));
        }
        let name = manifest
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| valid_tool_name(value))
            .ok_or_else(|| {
                SkillError::UnsafePackage(format!(
                    "invalid code-tool name: {}",
                    path.strip_prefix(root).unwrap_or(&path).display()
                ))
            })?
            .to_owned();
        if !names.insert(name.clone()) {
            return Err(SkillError::UnsafePackage(format!(
                "duplicate code-tool name in {skill_name}: {name}"
            )));
        }
        let description = manifest
            .get("description")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                SkillError::UnsafePackage(format!("code tool {name} requires a description"))
            })?
            .to_owned();
        let parameters = manifest
            .get("parameters")
            .cloned()
            .unwrap_or_else(|| json!({"type":"object","properties":{}}));
        if parameters.get("type").and_then(Value::as_str) != Some("object") {
            return Err(SkillError::UnsafePackage(format!(
                "code tool {name} parameters must be an object JSON Schema"
            )));
        }
        let output_schema = manifest.get("outputSchema").cloned();
        if output_schema
            .as_ref()
            .is_some_and(|schema| schema.get("type").and_then(Value::as_str).is_none())
        {
            return Err(SkillError::UnsafePackage(format!(
                "code tool {name} outputSchema must be a JSON Schema"
            )));
        }
        let command = code_tool_command(&manifest, "command", root, &name)?;
        let test_command = if manifest.get("testCommand").is_some() {
            code_tool_command(&manifest, "testCommand", root, &name)?
        } else {
            Vec::new()
        };
        let timeout_seconds = manifest
            .get("timeoutSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(30);
        if !(1..=MAX_CODE_TOOL_TIMEOUT_SECONDS).contains(&timeout_seconds) {
            return Err(SkillError::UnsafePackage(format!(
                "code tool {name} timeoutSeconds must be between 1 and {MAX_CODE_TOOL_TIMEOUT_SECONDS}"
            )));
        }
        tools.push(SkillCodeToolDefinition {
            skill_name: skill_name.to_owned(),
            profiles: Vec::new(),
            label: manifest
                .get("label")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or(&name)
                .to_owned(),
            name,
            description,
            parameters,
            output_schema,
            command,
            test_command,
            timeout_seconds,
            revision: revision.to_owned(),
            root_path: root.to_owned(),
            manifest_path: path,
        });
    }
    Ok(tools)
}

fn code_tool_command(
    manifest: &Value,
    field: &str,
    root: &Path,
    tool_name: &str,
) -> Result<Vec<String>, SkillError> {
    let command = manifest
        .get(field)
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| {
            SkillError::UnsafePackage(format!(
                "code tool {tool_name} {field} must be a non-empty string array"
            ))
        })?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| {
                    SkillError::UnsafePackage(format!(
                        "code tool {tool_name} {field} must contain only non-empty strings"
                    ))
                })
        })
        .collect::<Result<Vec<_>, _>>()?;
    for token in &command {
        if token.starts_with('-') || (!token.contains('/') && !token.contains('\\')) {
            continue;
        }
        let relative = Path::new(token);
        if relative.is_absolute()
            || relative.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
        {
            return Err(SkillError::UnsafePackage(format!(
                "code tool {tool_name} command path must remain inside the skill: {token}"
            )));
        }
        let target = root.join(relative);
        if !target.is_file() {
            return Err(SkillError::UnsafePackage(format!(
                "code tool {tool_name} command path does not exist: {token}"
            )));
        }
    }
    Ok(command)
}

fn valid_tool_name(name: &str) -> bool {
    (2..=64).contains(&name.len())
        && name.bytes().enumerate().all(|(index, value)| {
            value.is_ascii_lowercase() || value == b'_' || (index > 0 && value.is_ascii_digit())
        })
}

fn parse_frontmatter(path: &Path) -> Result<Value, SkillError> {
    let raw = fs::read_to_string(path)?
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let yaml = raw
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---"))
        .map(|(yaml, _)| yaml)
        .unwrap_or_default();
    let value = serde_yaml::from_str::<serde_yaml::Value>(yaml).map_err(|error| {
        SkillError::UnsafePackage(format!("invalid SKILL.md metadata: {error}"))
    })?;
    serde_json::to_value(value).map_err(SkillError::Decode)
}

fn apply_generated_file_changes(
    root: &Path,
    raw_files: Option<&Value>,
    allow_delete: bool,
) -> Result<Vec<String>, SkillError> {
    let Some(raw_files) = raw_files else {
        return Ok(Vec::new());
    };
    let files = raw_files.as_array().ok_or_else(|| {
        SkillError::UnsafePackage("files must be an array of skill resource changes".to_owned())
    })?;
    let mut changed = BTreeSet::new();
    let mut decoded_bytes = 0_u64;
    for file in files {
        let path = file
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                SkillError::UnsafePackage("generated file path is required".to_owned())
            })?;
        let relative = safe_generated_file_path(path)?;
        if !changed.insert(relative.to_string_lossy().replace('\\', "/")) {
            return Err(SkillError::UnsafePackage(format!(
                "generated file change is duplicated: {path}"
            )));
        }
        let target = root.join(&relative);
        let operation = file
            .get("operation")
            .and_then(Value::as_str)
            .unwrap_or("upsert");
        if operation == "delete" {
            if !allow_delete {
                return Err(SkillError::UnsafePackage(
                    "delete is not allowed while creating a skill".to_owned(),
                ));
            }
            if target.is_file() {
                fs::remove_file(&target)?;
            } else if target.exists() {
                return Err(SkillError::UnsafePackage(format!(
                    "generated file delete target is not a regular file: {path}"
                )));
            }
            continue;
        }
        if operation != "upsert" {
            return Err(SkillError::UnsafePackage(format!(
                "unsupported generated file operation: {operation}"
            )));
        }
        let content = file.get("content").and_then(Value::as_str).ok_or_else(|| {
            SkillError::UnsafePackage(format!(
                "generated file content is required for upsert: {path}"
            ))
        })?;
        let bytes = match file
            .get("encoding")
            .and_then(Value::as_str)
            .unwrap_or("utf-8")
        {
            "utf-8" => content.as_bytes().to_vec(),
            "base64" => BASE64.decode(content).map_err(|error| {
                SkillError::UnsafePackage(format!(
                    "generated file is not valid base64 ({path}): {error}"
                ))
            })?,
            encoding => {
                return Err(SkillError::UnsafePackage(format!(
                    "unsupported generated file encoding {encoding}: {path}"
                )));
            }
        };
        decoded_bytes = decoded_bytes.saturating_add(bytes.len() as u64);
        if decoded_bytes > MAX_PACKAGE_BYTES {
            return Err(SkillError::UnsafePackage(
                "generated files exceed the skill package byte limit".to_owned(),
            ));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&target, bytes)?;
        #[cfg(unix)]
        if file
            .get("executable")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o755))?;
        }
    }
    Ok(changed.into_iter().collect())
}

fn safe_generated_file_path(value: &str) -> Result<PathBuf, SkillError> {
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            ) || matches!(component, std::path::Component::Normal(name) if name.to_string_lossy().starts_with('.'))
        })
    {
        return Err(SkillError::UnsafePackage(format!(
            "generated file path is unsafe: {value}"
        )));
    }
    let first = path
        .components()
        .next()
        .and_then(|component| match component {
            std::path::Component::Normal(value) => value.to_str(),
            _ => None,
        });
    if !matches!(
        first,
        Some("scripts" | "references" | "assets" | "agents" | "tools" | "tests")
    ) {
        return Err(SkillError::UnsafePackage(format!(
            "generated files must be inside scripts, references, assets, agents, tools, or tests: {value}"
        )));
    }
    Ok(path.to_owned())
}

fn package_files(root: &Path) -> Result<Vec<PathBuf>, SkillError> {
    let mut pending = vec![root.to_owned()];
    let mut files = Vec::new();
    let mut total_bytes = 0_u64;
    while let Some(directory) = pending.pop() {
        let mut entries = fs::read_dir(&directory)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let path = entry.path();
            let relative = path.strip_prefix(root).map_err(|_| {
                SkillError::UnsafePackage("package path escaped its root".to_owned())
            })?;
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() {
                return Err(SkillError::UnsafePackage(format!(
                    "symbolic links are not allowed: {}",
                    relative.display()
                )));
            }
            let first = relative
                .components()
                .next()
                .and_then(|component| match component {
                    std::path::Component::Normal(value) => value.to_str(),
                    _ => None,
                });
            if first == Some(".git") {
                continue;
            }
            if relative.components().any(|component| {
                matches!(component, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_))
                    || matches!(component, std::path::Component::Normal(value) if value.to_string_lossy().starts_with('.') && value != INSTALLATION_MANIFEST)
            }) {
                return Err(SkillError::UnsafePackage(format!(
                    "hidden or unsafe path is not allowed: {}",
                    relative.display()
                )));
            }
            let allowed = relative == Path::new("SKILL.md")
                || relative == Path::new(INSTALLATION_MANIFEST)
                || matches!(
                    first,
                    Some("scripts" | "references" | "assets" | "agents" | "tools" | "tests")
                );
            if !allowed {
                return Err(SkillError::UnsafePackage(format!(
                    "unrelated package path is not allowed: {}",
                    relative.display()
                )));
            }
            if metadata.is_dir() {
                pending.push(path);
                continue;
            }
            if !metadata.is_file() {
                return Err(SkillError::UnsafePackage(format!(
                    "non-regular package entry is not allowed: {}",
                    relative.display()
                )));
            }
            if matches!(
                path.extension()
                    .and_then(|value| value.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("exe" | "dll" | "so" | "dylib")
            ) {
                return Err(SkillError::UnsafePackage(format!(
                    "native executable files are not allowed: {}",
                    relative.display()
                )));
            }
            total_bytes = total_bytes.saturating_add(metadata.len());
            files.push(relative.to_owned());
            if files.len() > MAX_PACKAGE_FILES || total_bytes > MAX_PACKAGE_BYTES {
                return Err(SkillError::UnsafePackage(
                    "skill package exceeds file-count or byte limits".to_owned(),
                ));
            }
        }
    }
    files.sort();
    if !files.iter().any(|path| path == Path::new("SKILL.md")) {
        return Err(SkillError::UnsafePackage(
            "skill package has no root SKILL.md".to_owned(),
        ));
    }
    Ok(files)
}

fn package_hash(root: &Path) -> Result<String, SkillError> {
    let files = package_files(root)?;
    package_hash_from_files(root, &files)
}

fn package_hash_from_files(root: &Path, files: &[PathBuf]) -> Result<String, SkillError> {
    let mut digest = Sha256::new();
    for relative in files
        .iter()
        .filter(|path| path.as_path() != Path::new(INSTALLATION_MANIFEST))
    {
        digest.update(relative.to_string_lossy().replace('\\', "/").as_bytes());
        digest.update([0]);
        digest.update(fs::read(root.join(relative))?);
        digest.update([0xff]);
    }
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn copy_skill_package(source: &Path, destination: &Path) -> Result<(), SkillError> {
    let files = package_files(source)?;
    fs::create_dir_all(destination)?;
    for relative in files {
        let target = destination.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(source.join(&relative), target)?;
    }
    Ok(())
}

struct SkillCodeToolSource {
    catalog: SkillCatalog,
    sandbox: ProcessSandbox,
    tested_revisions: Arc<tokio::sync::Mutex<BTreeSet<String>>>,
}

impl SkillCodeToolSource {
    fn tool(&self, name: &str) -> Option<SkillCodeTool> {
        self.catalog
            .skills
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .values()
            .filter(|skill| !skill.disable_model_invocation && self.catalog.is_enabled(&skill.name))
            .flat_map(|skill| skill.code_tools.iter())
            .find(|tool| tool.name == name)
            .cloned()
            .map(|definition| SkillCodeTool {
                definition,
                sandbox: self.sandbox.clone(),
                tested_revisions: Arc::clone(&self.tested_revisions),
            })
    }

    fn tools(&self) -> Vec<SkillCodeTool> {
        self.catalog
            .skills
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .values()
            .filter(|skill| !skill.disable_model_invocation && self.catalog.is_enabled(&skill.name))
            .flat_map(|skill| skill.code_tools.iter().cloned())
            .map(|definition| SkillCodeTool {
                definition,
                sandbox: self.sandbox.clone(),
                tested_revisions: Arc::clone(&self.tested_revisions),
            })
            .collect()
    }
}

impl DynamicToolSource for SkillCodeToolSource {
    fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tool(name).map(|tool| Arc::new(tool) as Arc<dyn Tool>)
    }

    fn direct_definitions(&self) -> Vec<ToolDefinition> {
        self.tools()
            .into_iter()
            .map(|tool| tool.definition())
            .collect()
    }
}

struct SkillCodeTool {
    definition: SkillCodeToolDefinition,
    sandbox: ProcessSandbox,
    tested_revisions: Arc<tokio::sync::Mutex<BTreeSet<String>>>,
}

impl SkillCodeTool {
    fn tool_definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.definition.name.clone(),
            label: self.definition.label.clone(),
            description: self.definition.description.clone(),
            parameters: self.definition.parameters.clone(),
            output_schema: self.definition.output_schema.clone(),
            source: "skill".to_owned(),
            version: "1".to_owned(),
            namespace: self.definition.skill_name.clone(),
            profiles: self.definition.profiles.clone(),
            execution_mode: ToolExecutionMode::Sequential,
            exposure: eden_agent_core::ToolExposure::Direct,
        }
    }

    async fn run_command(
        &self,
        command: &[String],
        stdin: &[u8],
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<eden_agent_tools::SandboxedProgramOutput, ToolFailure> {
        let root = self.definition.root_path.to_string_lossy().into_owned();
        run_sandboxed_program(
            &self.sandbox,
            SandboxedProgramRequest {
                workspace_root: &self.definition.root_path,
                cwd: &self.definition.root_path,
                program: &command[0],
                arguments: &command[1..],
                stdin,
                environment: &[("EDENAGENT_SKILL_ROOT", root.as_str())],
                timeout: Duration::from_secs(self.definition.timeout_seconds),
            },
            cancellation,
        )
        .await
    }

    async fn ensure_self_test(
        &self,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<(), ToolFailure> {
        if self.definition.test_command.is_empty() {
            return Ok(());
        }
        let key = format!("{}:{}", self.definition.name, self.definition.revision);
        let mut tested = self.tested_revisions.lock().await;
        if tested.contains(&key) {
            return Ok(());
        }
        let output = self
            .run_command(&self.definition.test_command, b"{}", cancellation)
            .await?;
        if output.exit_code != Some(0) {
            return Err(ToolFailure::new(
                "skill_tool_self_test_failed",
                format!(
                    "skill code tool {} self-test failed: {}",
                    self.definition.name,
                    truncate_text(
                        if output.stderr.trim().is_empty() {
                            &output.stdout
                        } else {
                            &output.stderr
                        },
                        2_000,
                    )
                ),
            )
            .with_details(json!({"exitCode":output.exit_code})));
        }
        tested.insert(key);
        Ok(())
    }
}

#[async_trait]
impl Tool for SkillCodeTool {
    fn definition(&self) -> ToolDefinition {
        self.tool_definition()
    }

    fn timeout(&self) -> Option<Duration> {
        Some(Duration::from_secs(
            self.definition.timeout_seconds.saturating_mul(2),
        ))
    }

    fn permission_request(&self, _arguments: &Value) -> Option<PermissionRequest> {
        Some(PermissionRequest {
            permission: "skill.process".to_owned(),
            patterns: vec![format!(
                "{}/{}",
                self.definition.skill_name, self.definition.name
            )],
            always: vec![self.definition.name.clone()],
        })
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let profile = context
            .metadata
            .get("promptProfile")
            .and_then(Value::as_str)
            .unwrap_or("user_chat");
        let profile_allowed = if self.definition.profiles.is_empty() {
            matches!(profile, "user_chat" | "self_awake")
        } else {
            self.definition
                .profiles
                .iter()
                .any(|value| value == profile)
        };
        if !profile_allowed {
            return Err(ToolFailure::new(
                "skill_tool_profile_mismatch",
                format!(
                    "skill code tool {} is not available in profile {profile}",
                    self.definition.name
                ),
            ));
        }
        self.ensure_self_test(&context.cancellation).await?;
        let stdin = serde_json::to_vec(&call.arguments)
            .map_err(|error| ToolFailure::new("invalid_arguments", error.to_string()))?;
        let output = self
            .run_command(&self.definition.command, &stdin, &context.cancellation)
            .await?;
        if output.exit_code != Some(0) {
            return Err(ToolFailure::new(
                "skill_tool_process_failed",
                format!(
                    "skill code tool {} failed: {}",
                    self.definition.name,
                    truncate_text(
                        if output.stderr.trim().is_empty() {
                            &output.stdout
                        } else {
                            &output.stderr
                        },
                        2_000,
                    )
                ),
            )
            .with_details(json!({"exitCode":output.exit_code})));
        }
        let text = output.stdout.trim();
        let parsed = serde_json::from_str::<Value>(text).ok();
        if self.definition.output_schema.is_some() && parsed.is_none() {
            return Err(ToolFailure::new(
                "invalid_tool_output",
                format!(
                    "skill code tool {} declares outputSchema but stdout is not JSON",
                    self.definition.name
                ),
            ));
        }
        let display = parsed
            .as_ref()
            .and_then(|value| {
                value
                    .get("text")
                    .or_else(|| value.get("message"))
                    .and_then(Value::as_str)
            })
            .unwrap_or(text);
        Ok(ToolOutput {
            content: vec![ContentBlock::Text {
                text: truncate_text(
                    if display.is_empty() {
                        "Skill code tool completed."
                    } else {
                        display
                    },
                    8_000,
                ),
            }],
            details: json!({
                "tool":self.definition.name,
                "skill":self.definition.skill_name,
                "exitCode":output.exit_code,
                "result":parsed,
            }),
            structured_content: self.definition.output_schema.as_ref().and(parsed),
            external_context: Vec::new(),
            terminate: false,
            success: true,
        })
    }
}

fn truncate_text(value: &str, maximum: usize) -> String {
    value.chars().take(maximum).collect()
}

struct ListSkillsTool(SkillCatalog);

#[async_trait]
impl Tool for ListSkillsTool {
    fn definition(&self) -> ToolDefinition {
        let mut definition =
            ToolDefinition::direct("list_skills", "List locally installed agent skills");
        definition.parameters = json!({"type":"object","properties":{}});
        definition
    }

    async fn execute(
        &self,
        _call: &ToolCall,
        _context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let skills = self
            .0
            .list()
            .into_iter()
            .map(|skill| {
                json!({
                    "name": skill.name,
                    "description": skill.description,
                    "modelInvocable": !skill.disable_model_invocation,
                    "enabled": self.0.is_enabled(&skill.name),
                })
            })
            .collect::<Vec<_>>();
        Ok(ToolOutput {
            content: vec![ContentBlock::Text {
                text: serde_json::to_string_pretty(&skills).unwrap_or_else(|_| "[]".to_owned()),
            }],
            structured_content: Some(json!({"skills": skills})),
            ..ToolOutput::default()
        })
    }
}

struct LoadSkillTool(SkillCatalog);

#[async_trait]
impl Tool for LoadSkillTool {
    fn definition(&self) -> ToolDefinition {
        let mut definition = ToolDefinition::direct(
            "load_skill",
            "Load the complete instructions for one installed skill",
        );
        definition.parameters = json!({
            "type":"object",
            "required":["name"],
            "properties":{"name":{"type":"string"}},
            "additionalProperties":false
        });
        definition
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let name = call
            .arguments
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| ToolFailure::new("invalid_arguments", "name is required"))?;
        let skill = self.0.get(name).ok_or_else(|| {
            ToolFailure::new("skill_not_found", format!("skill not found: {name}"))
        })?;
        if skill.disable_model_invocation || !self.0.is_enabled(name) {
            return Err(ToolFailure::new(
                "skill_not_model_invocable",
                format!("skill cannot be loaded by the model: {name}"),
            ));
        }
        let missing_tools = self.0.missing_tools(&skill);
        if !missing_tools.is_empty() {
            return Err(ToolFailure::new(
                "skill_dependencies_unavailable",
                format!(
                    "skill {name} requires unavailable tools: {}",
                    missing_tools.join(", ")
                ),
            ));
        }
        let profile = context
            .metadata
            .get("promptProfile")
            .and_then(Value::as_str)
            .unwrap_or("user_chat");
        let profile_allowed = if skill.profiles.is_empty() {
            matches!(profile, "user_chat" | "self_awake")
        } else {
            skill.profiles.iter().any(|value| value == profile)
        };
        if !profile_allowed {
            return Err(ToolFailure::new(
                "skill_profile_mismatch",
                format!("skill {name} is not available in profile {profile}"),
            ));
        }
        Ok(ToolOutput {
            content: vec![ContentBlock::Text {
                text: format!(
                    "# Skill: {}\n\nDeclared host permissions: {}. These declarations never grant access; every consequential tool call still uses the host permission policy.\n\n{}",
                    skill.name,
                    if skill.permissions.is_empty() {
                        "none".to_owned()
                    } else {
                        skill.permissions.join(", ")
                    },
                    skill.content
                ),
            }],
            details: json!({"name": skill.name, "filePath": skill.file_path}),
            ..ToolOutput::default()
        })
    }
}

struct CreateSkillTool(SkillCatalog);

#[async_trait]
impl Tool for CreateSkillTool {
    fn definition(&self) -> ToolDefinition {
        let mut definition = ToolDefinition::direct(
            "create_skill",
            "Create a complete user or project skill package without overwriting an existing skill",
        );
        definition.parameters = json!({"type":"object","required":["name","description","instructions"],"properties":{"name":{"type":"string"},"displayName":{"type":"string"},"display_name":{"type":"string"},"description":{"type":"string"},"instructions":{"type":"string"},"version":{"type":"string"},"defaultPrompt":{"type":"string"},"default_prompt":{"type":"string"},"scope":{"type":"string","enum":["user","project"]},"tools":{"type":"array","items":{"type":"string"}},"profiles":{"type":"array","items":{"type":"string","enum":["user_chat","self_awake","subagent"]}},"permissions":{"type":"array","items":{"type":"string"}},"files":{"type":"array","items":{"type":"object","required":["path","content"],"properties":{"path":{"type":"string"},"content":{"type":"string"},"encoding":{"type":"string","enum":["utf-8","base64"]},"executable":{"type":"boolean"}},"additionalProperties":false}}},"additionalProperties":false});
        definition
    }

    fn permission_request(&self, arguments: &Value) -> Option<eden_agent_core::PermissionRequest> {
        Some(eden_agent_core::PermissionRequest {
            permission: "skill.write".to_owned(),
            patterns: vec![
                arguments
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            ],
            always: vec![],
        })
    }

    async fn execute(
        &self,
        call: &ToolCall,
        _context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let name = required_text(&call.arguments, "name")?;
        let description = required_text(&call.arguments, "description")?;
        let instructions = required_text(&call.arguments, "instructions")?;
        let tools = string_array(&call.arguments, "tools");
        let profiles = string_array(&call.arguments, "profiles");
        let permissions = string_array(&call.arguments, "permissions");
        let skill = self
            .0
            .install_generated_package(
                name,
                call.arguments
                    .get("displayName")
                    .or_else(|| call.arguments.get("display_name"))
                    .and_then(Value::as_str)
                    .unwrap_or(name),
                call.arguments
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or("1.0.0"),
                description,
                instructions,
                &tools,
                &profiles,
                &permissions,
                call.arguments
                    .get("defaultPrompt")
                    .or_else(|| call.arguments.get("default_prompt"))
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                call.arguments
                    .get("scope")
                    .and_then(Value::as_str)
                    .unwrap_or("user"),
                call.arguments.get("files"),
            )
            .map_err(|error| ToolFailure::new("skill_create_failed", error.to_string()))?;
        Ok(skill_output(&skill, json!({"created":true})))
    }
}

struct UpdateSkillTool(SkillCatalog);

#[async_trait]
impl Tool for UpdateSkillTool {
    fn definition(&self) -> ToolDefinition {
        let mut definition = ToolDefinition::direct(
            "update_skill",
            "Preview or apply an atomic package-level update to a generated skill",
        );
        definition.parameters = json!({"type":"object","required":["action"],"properties":{"action":{"type":"string","enum":["preview","apply"]},"previewId":{"type":"string"},"preview_id":{"type":"string"},"name":{"type":"string"},"scope":{"type":"string","enum":["user","project"]},"expectedContentHash":{"type":"string"},"expected_content_hash":{"type":"string"},"displayName":{"type":"string"},"display_name":{"type":"string"},"description":{"type":"string"},"instructions":{"type":"string"},"version":{"type":"string"},"defaultPrompt":{"type":"string"},"default_prompt":{"type":"string"},"tools":{"type":"array","items":{"type":"string"}},"profiles":{"type":"array","items":{"type":"string","enum":["user_chat","self_awake","subagent"]}},"permissions":{"type":"array","items":{"type":"string"}},"files":{"type":"array","items":{"type":"object","required":["path"],"properties":{"path":{"type":"string"},"operation":{"type":"string","enum":["upsert","delete"]},"content":{"type":"string"},"encoding":{"type":"string","enum":["utf-8","base64"]},"executable":{"type":"boolean"}},"additionalProperties":false}}},"additionalProperties":false});
        definition
    }

    fn permission_request(&self, arguments: &Value) -> Option<eden_agent_core::PermissionRequest> {
        (arguments.get("action").and_then(Value::as_str) == Some("apply")).then(|| {
            eden_agent_core::PermissionRequest {
                permission: "skill.write".to_owned(),
                patterns: vec![
                    arguments
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("update-preview")
                        .to_owned(),
                ],
                always: vec![],
            }
        })
    }

    async fn execute(
        &self,
        call: &ToolCall,
        _context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        match call.arguments.get("action").and_then(Value::as_str) {
            Some("preview") => {
                let name = required_text(&call.arguments, "name")?;
                if let Some(scope) = call.arguments.get("scope").and_then(Value::as_str)
                    && self.0.get(name).as_ref().map(|skill| skill.scope.as_str()) != Some(scope)
                {
                    return Err(ToolFailure::new(
                        "skill_update_failed",
                        "scope does not match the installed skill",
                    ));
                }
                let tools = optional_string_array(&call.arguments, "tools")?;
                let profiles = optional_string_array(&call.arguments, "profiles")?;
                let permissions = optional_string_array(&call.arguments, "permissions")?;
                let (preview_id, skill, changed_files) = self
                    .0
                    .preview_generated_update(
                        name,
                        call.arguments
                            .get("expectedContentHash")
                            .or_else(|| call.arguments.get("expected_content_hash"))
                            .and_then(Value::as_str),
                        call.arguments
                            .get("displayName")
                            .or_else(|| call.arguments.get("display_name"))
                            .and_then(Value::as_str),
                        call.arguments.get("description").and_then(Value::as_str),
                        call.arguments.get("instructions").and_then(Value::as_str),
                        call.arguments.get("version").and_then(Value::as_str),
                        tools.as_deref(),
                        profiles.as_deref(),
                        permissions.as_deref(),
                        call.arguments
                            .get("defaultPrompt")
                            .or_else(|| call.arguments.get("default_prompt"))
                            .and_then(Value::as_str),
                        call.arguments.get("files"),
                    )
                    .map_err(|error| ToolFailure::new("skill_update_failed", error.to_string()))?;
                Ok(skill_output(
                    &skill,
                    json!({"action":"preview","previewId":preview_id,"changedFiles":changed_files}),
                ))
            }
            Some("apply") => {
                let preview_id = call
                    .arguments
                    .get("previewId")
                    .or_else(|| call.arguments.get("preview_id"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        ToolFailure::new("invalid_arguments", "previewId is required")
                    })?;
                let skill = self
                    .0
                    .apply_update(preview_id)
                    .map_err(|error| ToolFailure::new("skill_update_failed", error.to_string()))?;
                Ok(skill_output(
                    &skill,
                    json!({"action":"apply","updated":true}),
                ))
            }
            _ => Err(ToolFailure::new(
                "invalid_arguments",
                "action must be preview or apply",
            )),
        }
    }
}

fn required_text<'a>(value: &'a Value, name: &str) -> Result<&'a str, ToolFailure> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ToolFailure::new("invalid_arguments", format!("{name} is required")))
}

fn string_array(value: &Value, name: &str) -> Vec<String> {
    value
        .get(name)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn optional_string_array(value: &Value, name: &str) -> Result<Option<Vec<String>>, ToolFailure> {
    match value.get(name) {
        None => Ok(None),
        Some(Value::Array(_)) => Ok(Some(string_array(value, name))),
        Some(_) => Err(ToolFailure::new(
            "invalid_arguments",
            format!("{name} must be an array of strings"),
        )),
    }
}

fn skill_output(skill: &SkillDefinition, details: Value) -> ToolOutput {
    ToolOutput {
        content: vec![ContentBlock::Text {
            text: format!("Skill {} is ready.", skill.name),
        }],
        structured_content: Some(
            json!({"name":skill.name,"description":skill.description,"content":skill.content,"details":details}),
        ),
        details,
        external_context: Vec::new(),
        terminate: false,
        success: true,
    }
}

fn validate_name(name: &str) -> Result<(), SkillError> {
    if name.is_empty()
        || name.len() > 64
        || !name.chars().all(|value| {
            value.is_ascii_lowercase() || value.is_ascii_digit() || matches!(value, '-' | '_')
        })
    {
        Err(SkillError::InvalidName(name.to_owned()))
    } else {
        Ok(())
    }
}

fn load_disabled(root: &Path) -> Result<BTreeSet<String>, SkillError> {
    let path = root.join(".disabled.json");
    if !path.exists() {
        return Ok(BTreeSet::new());
    }
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn persist_disabled(path: &Path, disabled: &BTreeSet<String>) -> Result<(), SkillError> {
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(disabled)?)?;
    fs::rename(temporary, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn discovers_and_renders_valid_skills() {
        let root = tempfile::tempdir().expect("root");
        let skill = root.path().join("research");
        fs::create_dir(&skill).expect("directory");
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: research\ndescription: Research carefully\n---\nUse primary sources.\n",
        )
        .expect("skill");
        let catalog = SkillCatalog::discover(&[root.path().to_owned()], root.path().join("user"))
            .expect("catalog");
        assert_eq!(catalog.list().len(), 1);
        assert!(
            catalog
                .inventory_prompt()
                .contains("research (profiles: user_chat, self_awake): Research carefully")
        );
        assert_eq!(
            catalog.get("research").expect("research").content,
            "Use primary sources."
        );
    }

    fn write_package(root: &Path, tools: &str) {
        fs::create_dir_all(root.join("scripts")).expect("scripts");
        fs::create_dir_all(root.join("references")).expect("references");
        fs::create_dir_all(root.join("assets")).expect("assets");
        fs::create_dir_all(root.join("agents")).expect("agents");
        fs::write(
            root.join("SKILL.md"),
            format!(
                "---\nname: package-skill\ndescription: Complete package\nmetadata:\n  edenagent:\n    display_name: Package Skill\n    version: 1.2.3\n    tools: [{tools}]\n    profiles: [user_chat]\n    default_prompt: Run package\n---\nUse bundled resources.\n"
            ),
        )
        .expect("skill");
        fs::write(root.join("scripts/run.py"), "print('ok')\n").expect("script");
        fs::write(root.join("references/format.md"), "# Format\n").expect("reference");
        fs::write(root.join("assets/template.bin"), [0_u8, 1, 2]).expect("asset");
        fs::write(
            root.join("agents/openai.yaml"),
            "interface:\n  display_name: Package\n",
        )
        .expect("agent metadata");
    }

    fn write_code_tool_package(root: &Path, description: &str) {
        fs::create_dir_all(root.join("tools")).expect("tools");
        fs::write(
            root.join("SKILL.md"),
            "---\nname: code-skill\ndescription: Code skill\nmetadata:\n  edenagent:\n    tools: [echo_skill_value]\n---\nCall the bundled tool.\n",
        )
        .expect("skill");
        #[cfg(windows)]
        let command = vec![
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::Out.Write('{\"text\":\"ok\"}')",
        ];
        #[cfg(not(windows))]
        let command = vec!["sh", "-c", "printf '{\"text\":\"ok\"}'"];
        fs::write(
            root.join("tools/echo.json"),
            serde_json::to_vec_pretty(&json!({
                "schemaVersion":1,
                "name":"echo_skill_value",
                "label":"Echo skill value",
                "description":description,
                "parameters":{"type":"object","properties":{"value":{"type":"string"}}},
                "outputSchema":{"type":"object","required":["text"],"properties":{"text":{"type":"string"}}},
                "command":command,
                "testCommand":command,
                "timeoutSeconds":10,
            }))
            .expect("manifest JSON"),
        )
        .expect("manifest");
    }

    #[tokio::test]
    async fn code_tools_are_sandbox_gated_executable_and_reloadable() {
        let workspace = tempfile::tempdir().expect("workspace");
        let source = workspace.path().join("source");
        let skill = source.join("code-skill");
        write_code_tool_package(&skill, "First description");
        let catalog =
            SkillCatalog::discover(&[source], workspace.path().join("installed")).expect("catalog");
        catalog
            .set_known_tools(["read".to_owned()])
            .expect("known tools");
        let loaded = catalog.get("code-skill").expect("skill");
        assert_eq!(
            catalog.missing_tools(&loaded),
            vec!["echo_skill_value"],
            "code tools must fail closed before a sandbox source is registered"
        );

        let source = catalog
            .code_tool_source(ProcessSandbox::Direct)
            .expect("direct test sandbox");
        let mut registry = eden_agent_core::ToolRegistry::new();
        registry.register_dynamic_source(source);
        assert!(catalog.missing_tools(&loaded).is_empty());
        let tool = registry.get("echo_skill_value").expect("dynamic tool");
        assert_eq!(tool.definition().source, "skill");
        assert_eq!(tool.definition().description, "First description");
        assert!(tool.definition().profiles.is_empty());
        assert_eq!(
            tool.permission_request(&json!({"value":"hello"}))
                .expect("process permission")
                .permission,
            "skill.process"
        );
        let (events, _receiver) = eden_agent_core::event_channel(4);
        let output = tool
            .execute(
                &ToolCall {
                    id: "call-1".to_owned(),
                    name: "echo_skill_value".to_owned(),
                    arguments: json!({"value":"hello"}),
                },
                ToolCallContext {
                    cancellation: tokio_util::sync::CancellationToken::new(),
                    events,
                    session_id: None,
                    metadata: json!({}),
                },
            )
            .await
            .expect("code tool output");
        assert_eq!(output.structured_content, Some(json!({"text":"ok"})));
        assert_eq!(output.details["result"]["text"], "ok");

        let (events, _receiver) = eden_agent_core::event_channel(1);
        let error = tool
            .execute(
                &ToolCall {
                    id: "subagent-call".to_owned(),
                    name: "echo_skill_value".to_owned(),
                    arguments: json!({"value":"blocked"}),
                },
                ToolCallContext {
                    cancellation: tokio_util::sync::CancellationToken::new(),
                    events,
                    session_id: None,
                    metadata: json!({"promptProfile":"subagent"}),
                },
            )
            .await
            .expect_err("default-profile code tool must not leak into subagents");
        assert_eq!(error.info.code, "skill_tool_profile_mismatch");

        write_code_tool_package(&skill, "Second description");
        assert!(catalog.refresh().expect("refresh"));
        assert_eq!(
            registry
                .get("echo_skill_value")
                .expect("refreshed tool")
                .definition()
                .description,
            "Second description"
        );
        catalog
            .set_enabled("code-skill", false)
            .expect("disable skill");
        assert!(registry.get("echo_skill_value").is_none());
        assert!(
            registry
                .direct_definitions()
                .iter()
                .all(|definition| definition.name != "echo_skill_value")
        );
    }

    #[test]
    fn generated_project_skill_preserves_and_atomically_updates_package_files() {
        let workspace = tempfile::tempdir().expect("workspace");
        let project_root = workspace.path().join(".agents/skills");
        let user_root = workspace.path().join("user-skills");
        let catalog =
            SkillCatalog::discover(std::slice::from_ref(&project_root), user_root.clone())
                .expect("catalog");
        catalog
            .set_known_tools(["read".to_owned()])
            .expect("known tools");
        let files = json!([
            {"path":"scripts/run.py","content":"print('first')\n","executable":true},
            {"path":"references/format.md","content":"# First\n"},
            {"path":"assets/data.bin","content":"AAEC","encoding":"base64"},
            {"path":"tools/echo.json","content":serde_json::to_string(&json!({
                "schemaVersion":1,
                "name":"echo_generated",
                "description":"Echo generated values",
                "parameters":{"type":"object"},
                "outputSchema":{"type":"object"},
                "command":["python","scripts/run.py"]
            })).expect("tool manifest")}
        ]);
        let installed = catalog
            .install_generated_package(
                "generated-project",
                "Generated Project",
                "1.0.0",
                "Generated package",
                "Use the generated tool.",
                &["echo_generated".to_owned()],
                &["user_chat".to_owned()],
                &[],
                "Run the generated package",
                "project",
                Some(&files),
            )
            .expect("install generated project skill");
        assert_eq!(installed.scope, "project");
        assert_eq!(installed.source_type, "generated");
        assert_eq!(installed.code_tools.len(), 1);
        let installed_root = project_root.join("generated-project");
        assert!(installed_root.join("assets/data.bin").is_file());
        assert!(!user_root.join("generated-project").exists());

        let changes = json!([
            {"path":"scripts/run.py","operation":"upsert","content":"print('second')\n"},
            {"path":"references/format.md","operation":"delete"},
            {"path":"tests/case.txt","operation":"upsert","content":"case\n"}
        ]);
        let (preview_id, candidate, changed_files) = catalog
            .preview_generated_update(
                "generated-project",
                Some(&installed.content_hash),
                None,
                Some("Updated generated package"),
                None,
                Some("1.1.0"),
                None,
                None,
                None,
                None,
                Some(&changes),
            )
            .expect("preview package update");
        assert_eq!(candidate.version, "1.1.0");
        assert!(changed_files.contains(&"SKILL.md".to_owned()));
        assert!(changed_files.contains(&"scripts/run.py".to_owned()));
        assert!(changed_files.contains(&"references/format.md".to_owned()));
        let updated = catalog.apply_update(&preview_id).expect("apply update");
        assert_eq!(updated.description, "Updated generated package");
        assert_eq!(
            fs::read_to_string(installed_root.join("scripts/run.py")).expect("script"),
            "print('second')\n"
        );
        assert!(!installed_root.join("references/format.md").exists());
        assert!(installed_root.join("tests/case.txt").is_file());
        assert_eq!(
            fs::read(installed_root.join("assets/data.bin")).expect("asset"),
            [0, 1, 2]
        );
    }

    #[test]
    fn preview_installs_the_complete_validated_package_once() {
        let workspace = tempfile::tempdir().expect("workspace");
        let source = workspace.path().join("package-skill");
        let install_root = workspace.path().join("installed");
        let project_root = workspace.path().join(".agents/skills");
        write_package(&source, "read");
        let catalog = SkillCatalog::discover(std::slice::from_ref(&project_root), install_root)
            .expect("catalog");
        catalog
            .set_known_tools(["read".to_owned()])
            .expect("known tools");
        let (preview_id, preview) = catalog
            .inspect_local_for("owner-1", &source, None, "project", "local", None)
            .expect("preview");
        assert_eq!(preview.version, "1.2.3");
        assert_eq!(preview.tools, vec!["read"]);
        assert_eq!(preview.profiles, vec!["user_chat"]);
        assert_eq!(preview.files.len(), 5);
        assert_eq!(preview.content_hash.len(), 64);

        fs::write(
            source.join("scripts/run.py"),
            "print('changed after preview')\n",
        )
        .expect("source change");
        let installed = catalog
            .install_preview_for("owner-1", &preview_id)
            .expect("install snapshot");
        assert_eq!(installed.scope, "project");
        assert_eq!(installed.source_type, "local");
        assert_eq!(
            fs::read_to_string(project_root.join("package-skill/scripts/run.py"))
                .expect("installed script"),
            "print('ok')\n",
        );
        assert!(
            project_root
                .join("package-skill/assets/template.bin")
                .is_file()
        );
        assert!(
            project_root
                .join("package-skill/agents/openai.yaml")
                .is_file()
        );
        assert!(
            catalog
                .install_preview_for("owner-1", &preview_id)
                .expect_err("preview is single use")
                .to_string()
                .contains("expired")
        );
    }

    #[test]
    fn preview_rejects_unknown_tools_and_unsafe_paths() {
        let workspace = tempfile::tempdir().expect("workspace");
        let source = workspace.path().join("package-skill");
        write_package(&source, "made_up_tool");
        let catalog =
            SkillCatalog::discover(&[], workspace.path().join("installed")).expect("catalog");
        catalog
            .set_known_tools(["read".to_owned()])
            .expect("known tools");
        assert!(
            catalog
                .inspect_local(&source, None)
                .expect_err("unknown tool")
                .to_string()
                .contains("unknown tools")
        );
        fs::write(source.join("README.md"), "not part of a skill package").expect("unrelated file");
        assert!(
            package_files(&source)
                .expect_err("unrelated file")
                .to_string()
                .contains("unrelated package path")
        );
    }

    #[test]
    fn preview_owner_mismatch_consumes_the_capability() {
        let workspace = tempfile::tempdir().expect("workspace");
        let source = workspace.path().join("package-skill");
        write_package(&source, "read");
        let catalog =
            SkillCatalog::discover(&[], workspace.path().join("installed")).expect("catalog");
        catalog
            .set_known_tools(["read".to_owned()])
            .expect("known tools");
        let (preview_id, _) = catalog
            .inspect_local_for("owner-1", &source, None, "user", "local", None)
            .expect("preview");
        assert!(catalog.install_preview_for("owner-2", &preview_id).is_err());
        assert!(catalog.install_preview_for("owner-1", &preview_id).is_err());
    }

    #[test]
    fn update_refuses_changes_made_after_preview() {
        let workspace = tempfile::tempdir().expect("workspace");
        let install_root = workspace.path().join("installed");
        let catalog = SkillCatalog::discover(&[], install_root.clone()).expect("catalog");
        let installed = catalog
            .install("generated-skill", "Generated", "Original instructions")
            .expect("install");
        let (preview_id, _) = catalog
            .preview_update("generated-skill", None, Some("Updated instructions"))
            .expect("update preview");
        fs::write(&installed.file_path, "changed outside preview\n").expect("external change");
        assert!(matches!(
            catalog.apply_update(&preview_id),
            Err(SkillError::ConcurrentModification(_))
        ));
    }

    #[test]
    fn refresh_atomically_publishes_external_changes() {
        let workspace = tempfile::tempdir().expect("workspace");
        let source = workspace.path().join("source");
        let skill = source.join("research");
        fs::create_dir_all(&skill).expect("skill directory");
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: research\ndescription: First\n---\nFirst instructions.\n",
        )
        .expect("skill");
        let catalog =
            SkillCatalog::discover(&[source], workspace.path().join("installed")).expect("catalog");
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: research\ndescription: Second\n---\nSecond instructions.\n",
        )
        .expect("skill update");
        assert!(catalog.refresh().expect("refresh"));
        assert_eq!(
            catalog.get("research").expect("research").description,
            "Second"
        );
        assert!(!catalog.refresh().expect("stable refresh"));
    }

    #[test]
    fn root_replacement_is_atomic_and_keeps_the_install_root() {
        let workspace = tempfile::tempdir().expect("workspace");
        let first_root = workspace.path().join("first-root");
        let second_root = workspace.path().join("second-root");
        let duplicate_root = workspace.path().join("duplicate-root");
        for (root, name, description) in [
            (&first_root, "first", "First workspace"),
            (&second_root, "second", "Second workspace"),
            (&duplicate_root, "second", "Duplicate second"),
        ] {
            let directory = root.join(name);
            fs::create_dir_all(&directory).expect("skill directory");
            fs::write(
                directory.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: {description}\n---\nInstructions.\n"),
            )
            .expect("skill");
        }
        let install_root = workspace.path().join("installed");
        let catalog = SkillCatalog::discover(&[first_root], install_root.clone()).expect("catalog");
        assert!(
            catalog
                .replace_roots(vec![second_root.clone()])
                .expect("replace")
        );
        assert!(catalog.get("first").is_none());
        assert!(catalog.get("second").is_some());
        assert!(catalog.roots().contains(&install_root));

        assert!(
            catalog
                .replace_roots(vec![second_root.clone(), duplicate_root])
                .is_err()
        );
        assert_eq!(
            catalog.roots(),
            vec![second_root, install_root],
            "failed validation must not publish roots or skills"
        );
        assert_eq!(
            catalog.get("second").expect("second").description,
            "Second workspace"
        );
    }

    #[test]
    fn plugin_roots_survive_workspace_changes_and_are_removed_atomically() {
        let workspace = tempfile::tempdir().expect("workspace");
        let first_root = workspace.path().join("first-root");
        let second_root = workspace.path().join("second-root");
        let plugin_root = workspace.path().join("plugin/skills/plugin-skill");
        for (root, name) in [
            (&first_root, "first"),
            (&second_root, "second"),
            (&plugin_root, "plugin-skill"),
        ] {
            fs::create_dir_all(root).expect("skill directory");
            fs::write(
                root.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: {name}\n---\nInstructions.\n"),
            )
            .expect("skill");
        }
        let install_root = workspace.path().join("installed");
        let catalog = SkillCatalog::discover(&[first_root], install_root).expect("skill catalog");
        assert!(
            catalog
                .set_plugin_roots("mon.test", vec![plugin_root])
                .expect("plugin roots")
        );
        let plugin_skill = catalog.get("plugin-skill").expect("plugin skill");
        assert_eq!(plugin_skill.scope, "plugin");
        assert_eq!(plugin_skill.source_type, "plugin");
        assert_eq!(plugin_skill.manifest["pluginId"], "mon.test");

        assert!(catalog.replace_roots(vec![second_root]).expect("workspace"));
        assert!(catalog.get("first").is_none());
        assert!(catalog.get("second").is_some());
        assert!(catalog.get("plugin-skill").is_some());

        assert!(
            catalog
                .remove_plugin_roots("mon.test")
                .expect("remove plugin roots")
        );
        assert!(catalog.get("plugin-skill").is_none());
        assert!(catalog.get("second").is_some());
    }

    #[test]
    fn explicit_subagent_skill_snapshot_enforces_profile_and_dependencies() {
        let workspace = tempfile::tempdir().expect("workspace");
        let source = workspace.path().join("research");
        fs::create_dir_all(&source).expect("skill directory");
        fs::write(
            source.join("SKILL.md"),
            "---\nname: research\ndescription: Research\nmetadata:\n  edenagent:\n    tools: [web]\n    profiles: [subagent]\n---\nUse primary evidence.\n",
        )
        .expect("skill");
        let catalog = SkillCatalog::discover(
            &[workspace.path().to_owned()],
            workspace.path().join("installed"),
        )
        .expect("catalog");
        catalog
            .set_known_tools(["web".to_owned()])
            .expect("known tools");
        let prompt = catalog
            .prompt_snapshot_for_profile(&["research".to_owned()], "subagent")
            .expect("snapshot");
        assert!(prompt.contains("# Preloaded skill: research"));
        assert!(prompt.contains("Use primary evidence."));
        assert!(
            !catalog
                .get("research")
                .expect("skill")
                .content_hash
                .is_empty()
        );

        catalog
            .set_known_tools(["read".to_owned()])
            .expect("known tools");
        assert!(
            catalog
                .prompt_snapshot_for_profile(&["research".to_owned()], "subagent")
                .expect_err("missing web tool")
                .to_string()
                .contains("unavailable tools")
        );
        assert!(
            catalog
                .prompt_snapshot_for_profile(&["research".to_owned()], "user_chat")
                .expect_err("profile mismatch")
                .to_string()
                .contains("profile user_chat")
        );
    }

    #[tokio::test]
    async fn load_skill_enforces_profile_and_tool_dependencies() {
        let workspace = tempfile::tempdir().expect("workspace");
        let source = workspace.path().join("package-skill");
        write_package(&source, "read");
        let catalog = SkillCatalog::discover(
            &[workspace.path().to_owned()],
            workspace.path().join("installed"),
        )
        .expect("catalog");
        catalog
            .set_known_tools(["other".to_owned()])
            .expect("known tools");
        let tool = catalog
            .tools()
            .into_iter()
            .find(|tool| tool.definition().name == "load_skill")
            .expect("load skill tool");
        let (events, _receiver) = eden_agent_core::event_channel(1);
        let context = ToolCallContext {
            cancellation: tokio_util::sync::CancellationToken::new(),
            events,
            session_id: None,
            metadata: json!({"promptProfile":"self_awake"}),
        };
        let error = tool
            .execute(
                &ToolCall {
                    id: "call".to_owned(),
                    name: "load_skill".to_owned(),
                    arguments: json!({"name":"package-skill"}),
                },
                context,
            )
            .await
            .expect_err("missing dependency");
        assert_eq!(error.info.code, "skill_dependencies_unavailable");

        catalog
            .set_known_tools(["read".to_owned()])
            .expect("known tools");
        let (events, _receiver) = eden_agent_core::event_channel(1);
        let error = tool
            .execute(
                &ToolCall {
                    id: "call-2".to_owned(),
                    name: "load_skill".to_owned(),
                    arguments: json!({"name":"package-skill"}),
                },
                ToolCallContext {
                    cancellation: tokio_util::sync::CancellationToken::new(),
                    events,
                    session_id: None,
                    metadata: json!({"promptProfile":"subagent"}),
                },
            )
            .await
            .expect_err("root skill must not leak into subagent profile");
        assert_eq!(error.info.code, "skill_profile_mismatch");
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_are_rejected() {
        use std::os::unix::fs::symlink;
        let workspace = tempfile::tempdir().expect("workspace");
        let source = workspace.path().join("package-skill");
        write_package(&source, "read");
        symlink(workspace.path(), source.join("scripts/outside")).expect("symlink");
        assert!(
            package_files(&source)
                .expect_err("symbolic link")
                .to_string()
                .contains("symbolic links")
        );
    }
}
