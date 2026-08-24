use super::*;

pub(crate) const SUPPORTED_PLUGIN_HOOK_EVENTS: &[&str] = &[
    "session.created",
    "session.environment_updated",
    "session.participants_updated",
    "character.action.changed",
    "character.sticker.sent",
    "permission.resolved",
    "question.resolved",
    "workspace.changed",
];

#[derive(Clone, Debug)]
pub(crate) struct PluginHookRegistration {
    pub(crate) plugin_id: String,
    pub(crate) hook_id: String,
    pub(crate) event: String,
    pub(crate) skill: String,
}

#[derive(Clone, Default)]
pub(crate) struct PluginHookCatalog {
    plugins: Arc<RwLock<BTreeMap<String, Vec<PluginHookRegistration>>>>,
}

impl PluginHookCatalog {
    pub(crate) fn set(&self, plugin_id: &str, hooks: Vec<PluginHookRegistration>) -> bool {
        let mut plugins = self
            .plugins
            .write()
            .unwrap_or_else(|value| value.into_inner());
        let changed = plugins.get(plugin_id).is_none_or(|current| {
            current.len() != hooks.len()
                || current.iter().zip(&hooks).any(|(left, right)| {
                    left.hook_id != right.hook_id
                        || left.event != right.event
                        || left.skill != right.skill
                })
        });
        plugins.insert(plugin_id.to_owned(), hooks);
        changed
    }

    pub(crate) fn remove(&self, plugin_id: &str) -> bool {
        self.plugins
            .write()
            .unwrap_or_else(|value| value.into_inner())
            .remove(plugin_id)
            .is_some()
    }

    pub(crate) fn matching(&self, event: &str) -> Vec<PluginHookRegistration> {
        self.plugins
            .read()
            .unwrap_or_else(|value| value.into_inner())
            .values()
            .flatten()
            .filter(|hook| hook.event == event)
            .cloned()
            .collect()
    }
}

pub(crate) fn skill_system_prompt(skills: &SkillCatalog) -> String {
    format!(
        "You are Eden Agent, a local assistant. Use tools carefully and explain consequential actions.{}",
        skills.inventory_prompt()
    )
}

pub(crate) fn apply_skill_system_prompt(state: &AppState) {
    let prompt = skill_system_prompt(&state.skills);
    state.runtime.set_system_prompt(&prompt);
    state.multiagents.set_system_prompt(prompt);
}

pub(crate) fn skill_info(
    catalog: &SkillCatalog,
    skill: SkillDefinition,
    include_content: bool,
) -> SkillInfo {
    let missing_tools = catalog.missing_tools(&skill);
    SkillInfo {
        enabled: catalog.is_enabled(&skill.name),
        available: missing_tools.is_empty(),
        missing_tools,
        name: skill.name,
        display_name: skill.display_name,
        description: skill.description,
        version: skill.version,
        model_invocable: !skill.disable_model_invocation,
        scope: skill.scope,
        source_type: skill.source_type,
        tools: skill.tools,
        profiles: skill.profiles,
        permissions: skill.permissions,
        default_prompt: skill.default_prompt,
        content_hash: skill.content_hash,
        total_bytes: skill.total_bytes,
        files: skill.files,
        manifest: skill.manifest,
        content: include_content.then_some(skill.content),
    }
}

pub(crate) fn plugin_components(manifest: &PluginManifest) -> Vec<PluginComponentInfo> {
    let mut components = Vec::new();
    components.extend(
        manifest
            .components
            .skills
            .iter()
            .map(|component| PluginComponentInfo {
                id: component.id.clone(),
                kind: "skill".to_owned(),
                path: component.path.clone(),
                enabled_by_default: component.enabled_by_default,
            }),
    );
    components.extend(manifest.components.runtimes.iter().map(|component| {
        PluginComponentInfo {
            id: component.id.clone(),
            kind: match component.kind {
                RuntimeKind::NativeWorker => "native_worker",
                RuntimeKind::McpStdio => "mcp_stdio",
                RuntimeKind::McpHttp => "mcp_http",
            }
            .to_owned(),
            path: component.manifest.clone(),
            enabled_by_default: component.enabled_by_default,
        }
    }));
    components.extend(
        manifest
            .components
            .ui
            .iter()
            .map(|component| PluginComponentInfo {
                id: component.id.clone(),
                kind: "ui".to_owned(),
                path: component.entry.clone(),
                enabled_by_default: component.enabled_by_default,
            }),
    );
    components.extend(
        manifest
            .components
            .hooks
            .iter()
            .map(|component| PluginComponentInfo {
                id: component.id.clone(),
                kind: format!("hook:{}", component.event),
                path: format!("skill:{}", component.skill),
                enabled_by_default: component.enabled_by_default,
            }),
    );
    components
}

pub(crate) fn plugin_permissions(manifest: &PluginManifest) -> Vec<PluginPermissionInfo> {
    manifest
        .permissions
        .iter()
        .map(|permission| PluginPermissionInfo {
            capability: permission.capability.clone(),
            resource: permission.resource.clone(),
            access: permission.access.clone(),
            required: permission.required,
            description: permission.description.clone(),
        })
        .collect()
}

pub(crate) fn plugin_preview_info(preview: ManagedInstallPreview) -> PluginPreviewInfo {
    let source_type = preview.preview.source_type.clone();
    let source_uri = preview.preview.source_uri.clone();
    let plugin = preview.preview.plugin;
    PluginPreviewInfo {
        preview_id: preview.id,
        id: plugin.manifest.id.clone(),
        name: plugin.manifest.name.clone(),
        description: plugin.manifest.description.clone(),
        version: plugin.manifest.version.clone(),
        revision: plugin.revision,
        verified: plugin.trust.verified(),
        source_type,
        source_uri,
        components: plugin_components(&plugin.manifest),
        permissions: plugin_permissions(&plugin.manifest),
        expires_at: preview.expires_at,
    }
}

pub(crate) fn validate_plugin_permission_decisions(
    manifest: &PluginManifest,
    params: &PluginPermissionSetParams,
) -> Result<Vec<PluginPermissionGrantInput>, RpcFailure> {
    let mut seen = HashSet::new();
    let mut grants = Vec::with_capacity(params.decisions.len());
    for decision in &params.decisions {
        if !matches!(decision.decision.as_str(), "allowed" | "denied") {
            return Err(RpcFailure::invalid_params(format!(
                "invalid plugin permission decision: {}",
                decision.decision
            )));
        }
        let key = (
            decision.capability.clone(),
            decision.resource.clone(),
            decision.access.clone(),
        );
        if !seen.insert(key.clone()) {
            return Err(RpcFailure::invalid_params(format!(
                "duplicate plugin permission decision: {} {} {}",
                decision.capability, decision.access, decision.resource
            )));
        }
        if !manifest.permissions.iter().any(|permission| {
            permission.capability == decision.capability
                && permission.resource == decision.resource
                && permission.access == decision.access
        }) {
            return Err(RpcFailure::invalid_params(format!(
                "permission is not declared by the active plugin manifest: {} {} {}",
                decision.capability, decision.access, decision.resource
            )));
        }
        grants.push(PluginPermissionGrantInput {
            capability: key.0,
            resource: key.1,
            access: key.2,
            decision: decision.decision.clone(),
        });
    }
    Ok(grants)
}

pub(crate) async fn plugin_info(
    state: &AppState,
    record: PluginRecord,
) -> Result<PluginInfo, RpcFailure> {
    let manifest: PluginManifest =
        serde_json::from_value(record.manifest.clone()).map_err(|error| {
            RpcFailure::application(format!("invalid persisted plugin manifest: {error}"))
        })?;
    let versions = state
        .store
        .list_plugin_versions(&record.id)
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?
        .into_iter()
        .map(|version| PluginVersionInfo {
            active: version.version == record.active_version
                && version.revision == record.active_revision,
            version: version.version,
            revision: version.revision,
            trust_state: version.trust_state,
            source_type: version.source_type,
            source_uri: version.source_uri,
            installed_at: version.installed_at,
        })
        .collect();
    let permission_grants = state
        .store
        .list_plugin_permission_grants(&record.id)
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?
        .into_iter()
        .map(|grant| PluginPermissionGrantInfo {
            capability: grant.capability,
            resource: grant.resource,
            access: grant.access,
            decision: grant.decision,
            manifest_revision: grant.manifest_revision,
            decided_at: grant.decided_at,
        })
        .collect();
    let ui_contributions = load_active_plugin_package(&state.store, &record)
        .await
        .map_err(RpcFailure::application)?
        .ui_contributions()
        .map_err(|error| RpcFailure::application(error.to_string()))?
        .into_iter()
        .map(|(component_id, card)| PluginUiContributionInfo {
            component_id,
            id: card.id,
            location: card.location,
            title: card.title,
            body: card.body,
            tone: card.tone,
        })
        .collect();
    Ok(PluginInfo {
        id: record.id,
        name: record.name,
        description: record.description,
        version: record.active_version,
        revision: record.active_revision,
        enabled: record.enabled,
        trust_state: record.trust_state,
        source_type: record.source_type,
        source_uri: record.source_uri,
        components: plugin_components(&manifest),
        ui_contributions,
        permissions: plugin_permissions(&manifest),
        permission_grants,
        versions,
        manifest: record.manifest,
        created_at: record.created_at,
        updated_at: record.updated_at,
    })
}

pub(crate) fn plugin_market_source_info(
    source: PluginMarketSourceRecord,
) -> PluginMarketSourceInfo {
    PluginMarketSourceInfo {
        id: source.id,
        name: source.name,
        url: source.url,
        key_id: source.key_id,
        enabled: source.enabled,
        index_revision: source.index_revision,
        last_refreshed_at: source.last_refreshed_at,
        last_error: source.last_error,
    }
}

pub(crate) fn cached_market_index(
    state: &AppState,
    source: &PluginMarketSourceRecord,
) -> Result<VerifiedMarketIndex, RpcFailure> {
    let value = source.index.clone().ok_or_else(|| {
        RpcFailure::application(format!(
            "market source has not been refreshed: {}",
            source.id
        ))
    })?;
    let envelope: MarketIndexEnvelope = serde_json::from_value(value).map_err(|error| {
        RpcFailure::application(format!("invalid cached market index: {error}"))
    })?;
    verify_index(
        envelope,
        &source.key_id,
        state.plugins.store().trust_store(),
    )
    .map_err(RpcFailure::application)
}

pub(crate) async fn refresh_market_source(
    state: &AppState,
    source: PluginMarketSourceRecord,
) -> Result<PluginMarketSourceRecord, RpcFailure> {
    let fetched = state
        .marketplace
        .fetch_index(
            &source.url,
            &source.key_id,
            state.plugins.store().trust_store(),
        )
        .await;
    let index = match fetched {
        Ok(index) => index,
        Err(error) => {
            let _ = state
                .store
                .cache_plugin_market_index(&source.id, None, None, Some(&error))
                .await;
            return Err(RpcFailure::application(error));
        }
    };
    let value = serde_json::to_value(&index.envelope)
        .map_err(|error| RpcFailure::application(error.to_string()))?;
    state
        .store
        .cache_plugin_market_snapshot(
            &source.id,
            &value,
            &index.revision,
            index
                .envelope
                .payload
                .revocations
                .iter()
                .map(|item| PluginMarketRevocationInput {
                    plugin_id: item.plugin_id.clone(),
                    version: item.version.clone(),
                    revision: item.revision.clone(),
                    reason: item.reason.clone(),
                })
                .collect(),
        )
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?;
    apply_plugin_market_revocations(state, &index.envelope.payload.revocations).await?;
    state
        .store
        .get_plugin_market_source(&source.id)
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))
}

pub(crate) async fn apply_plugin_market_revocations(
    state: &AppState,
    revocations: &[MarketRevocation],
) -> Result<(), RpcFailure> {
    for revocation in revocations {
        if let Ok(record) = state.store.get_plugin(&revocation.plugin_id).await
            && record.enabled
            && record.active_version == revocation.version
            && record.active_revision == revocation.revision
        {
            let disabled = state
                .store
                .set_plugin_enabled(&record.id, false)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            reconcile_plugin_components(state, disabled).await?;
        }
    }
    Ok(())
}

pub(crate) async fn ensure_plugin_release_not_revoked(
    store: &Store,
    id: &str,
    version: &str,
    revision: &str,
) -> Result<(), RpcFailure> {
    if let Some(revocation) = store
        .get_plugin_market_revocation(id, version, revision)
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?
    {
        return Err(RpcFailure::application(format!(
            "plugin release was revoked by market {}: {}",
            revocation.source_id, revocation.reason
        )));
    }
    Ok(())
}

pub(crate) async fn load_active_plugin_package(
    store: &Store,
    record: &PluginRecord,
) -> Result<LoadedPlugin, String> {
    let version = store
        .list_plugin_versions(&record.id)
        .await
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|version| {
            version.version == record.active_version && version.revision == record.active_revision
        })
        .ok_or_else(|| {
            format!(
                "active plugin version is not installed: {}@{}#{}",
                record.id, record.active_version, record.active_revision
            )
        })?;
    let package = LoadedPlugin::load(&version.root_path, PluginLoadPolicy::Development)
        .map_err(|error| error.to_string())?;
    if package.manifest.id != record.id
        || package.manifest.version != record.active_version
        || package.revision != record.active_revision
    {
        return Err(format!(
            "installed plugin package does not match registry entry: {}",
            record.id
        ));
    }
    Ok(package)
}

pub(crate) fn plugin_skill_roots(package: &LoadedPlugin) -> Result<Vec<PathBuf>, String> {
    package
        .manifest
        .components
        .skills
        .iter()
        .filter(|component| component.enabled_by_default)
        .map(|component| {
            package
                .resolve_file(&component.path)
                .map_err(|error| error.to_string())?
                .parent()
                .map(StdPath::to_path_buf)
                .ok_or_else(|| format!("plugin skill has no parent: {}", component.path))
        })
        .collect()
}

pub(crate) fn permission_is_allowed(
    permission: &eden_agent_plugins::PermissionDeclaration,
    revision: &str,
    grants: &[PluginPermissionGrantRecord],
) -> bool {
    grants.iter().any(|grant| {
        grant.manifest_revision == revision
            && grant.decision == "allowed"
            && grant.capability == permission.capability
            && grant.resource == permission.resource
            && grant.access == permission.access
    })
}

pub(crate) async fn active_plugin_permission_grants(
    store: &Store,
    record: &PluginRecord,
    manifest: &PluginManifest,
) -> Result<Vec<PluginPermissionGrantRecord>, String> {
    let grants = store
        .list_plugin_permission_grants(&record.id)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(permission) = manifest.permissions.iter().find(|permission| {
        permission.required && !permission_is_allowed(permission, &record.active_revision, &grants)
    }) {
        return Err(format!(
            "required permission has not been allowed for revision {}: {} {} {}",
            record.active_revision, permission.capability, permission.access, permission.resource
        ));
    }
    Ok(grants)
}

pub(crate) fn plugin_connector_packages(
    plugin: &LoadedPlugin,
    grants: &[PluginPermissionGrantRecord],
) -> Result<Vec<PluginConnectorPackage>, String> {
    let mut packages = Vec::new();
    for component in plugin
        .manifest
        .components
        .runtimes
        .iter()
        .filter(|component| {
            component.enabled_by_default && component.kind == RuntimeKind::NativeWorker
        })
    {
        let manifest = plugin
            .resolve_file(&component.manifest)
            .map_err(|error| error.to_string())?;
        let root = manifest.parent().ok_or_else(|| {
            format!(
                "native worker manifest has no parent: {}",
                component.manifest
            )
        })?;
        let connector_package =
            LoadedConnectorPackage::load(root, ConnectorPackageLoadPolicy::Development)
                .map_err(|error| error.to_string())?;
        let mut granted_permissions = Vec::new();
        for permission in &connector_package.manifest.permissions {
            let outer = plugin
                .manifest
                .permissions
                .iter()
                .find(|outer| {
                    outer.capability == permission.capability
                        && outer.resource == permission.resource
                        && outer.access == permission.access
                })
                .ok_or_else(|| {
                    format!(
                        "connector {} requests undeclared plugin permission: {} {} {}",
                        connector_package.manifest.id,
                        permission.capability,
                        permission.access,
                        permission.resource
                    )
                })?;
            if permission_is_allowed(outer, &plugin.revision, grants) {
                granted_permissions.push(ConnectorPermissionGrant {
                    capability: permission.capability.clone(),
                    resource: permission.resource.clone(),
                    access: permission.access.clone(),
                });
            }
        }
        packages.push(PluginConnectorPackage {
            package: connector_package,
            granted_permissions,
        });
    }
    Ok(packages)
}

pub(crate) fn plugin_mcp_components(
    plugin: &LoadedPlugin,
    grants: &[PluginPermissionGrantRecord],
) -> Result<Vec<McpComponentConfig>, String> {
    let mut components = Vec::new();
    for component in plugin
        .manifest
        .components
        .runtimes
        .iter()
        .filter(|component| {
            component.enabled_by_default
                && matches!(component.kind, RuntimeKind::McpStdio | RuntimeKind::McpHttp)
        })
    {
        let descriptor_path = plugin
            .resolve_file(&component.manifest)
            .map_err(|error| error.to_string())?;
        let descriptor: Value = serde_json::from_slice(
            &std::fs::read(&descriptor_path).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("invalid MCP descriptor: {error}"))?;
        let (kind, capability, resource, access) = match component.kind {
            RuntimeKind::McpStdio => (
                McpRuntimeKind::Stdio,
                "process.execute",
                descriptor.get("command").and_then(Value::as_str),
                "execute",
            ),
            RuntimeKind::McpHttp => (
                McpRuntimeKind::Http,
                "network.connect",
                descriptor.get("url").and_then(Value::as_str),
                "connect",
            ),
            RuntimeKind::NativeWorker => continue,
        };
        let resource = resource.ok_or_else(|| {
            format!(
                "MCP descriptor is missing its permission resource: {}",
                component.id
            )
        })?;
        let permission = plugin
            .manifest
            .permissions
            .iter()
            .find(|permission| {
                permission.capability == capability
                    && permission.resource == resource
                    && permission.access == access
            })
            .ok_or_else(|| {
                format!(
                    "MCP component {} requires undeclared permission: {capability} {access} {resource}",
                    component.id
                )
            })?;
        if !permission_is_allowed(permission, &plugin.revision, grants) {
            return Err(format!(
                "MCP component {} permission has not been allowed: {capability} {access} {resource}",
                component.id
            ));
        }
        components.push(McpComponentConfig {
            plugin_id: plugin.manifest.id.clone(),
            component_id: component.id.clone(),
            kind,
            plugin_root: plugin.root.clone(),
            descriptor_path,
        });
    }
    Ok(components)
}

pub(crate) async fn reconcile_plugin_skills(
    store: &Store,
    skills: &SkillCatalog,
    record: &PluginRecord,
) -> Result<bool, String> {
    if !record.enabled {
        return skills
            .remove_plugin_roots(&record.id)
            .map_err(|error| error.to_string());
    }
    let package = load_active_plugin_package(store, record).await?;
    skills
        .set_plugin_roots(&record.id, plugin_skill_roots(&package)?)
        .map_err(|error| error.to_string())
}

pub(crate) async fn reconcile_plugin_connectors(
    store: &Store,
    connectors: &ConnectorService,
    record: &PluginRecord,
) -> Result<bool, String> {
    if !record.enabled {
        return connectors.remove_plugin_packages(&record.id).await;
    }
    let package = load_active_plugin_package(store, record).await?;
    let grants = active_plugin_permission_grants(store, record, &package.manifest).await?;
    connectors
        .set_plugin_packages(&record.id, plugin_connector_packages(&package, &grants)?)
        .await
}

pub(crate) async fn reconcile_plugin_mcp(
    store: &Store,
    mcp: &McpManager,
    record: &PluginRecord,
) -> Result<bool, String> {
    if !record.enabled {
        return Ok(mcp.remove_plugin_components(&record.id));
    }
    let package = load_active_plugin_package(store, record).await?;
    let grants = active_plugin_permission_grants(store, record, &package.manifest).await?;
    mcp.set_plugin_components(&record.id, plugin_mcp_components(&package, &grants)?)
        .await
}

pub(crate) async fn reconcile_plugin_hooks(
    store: &Store,
    hooks: &PluginHookCatalog,
    record: &PluginRecord,
) -> Result<bool, String> {
    if !record.enabled {
        return Ok(hooks.remove(&record.id));
    }
    let package = load_active_plugin_package(store, record).await?;
    let grants = active_plugin_permission_grants(store, record, &package.manifest).await?;
    let mut registrations = Vec::new();
    for hook in package
        .manifest
        .components
        .hooks
        .iter()
        .filter(|hook| hook.enabled_by_default)
    {
        if !SUPPORTED_PLUGIN_HOOK_EVENTS.contains(&hook.event.as_str()) {
            return Err(format!(
                "plugin hook event is not supported by the safe dispatcher: {}",
                hook.event
            ));
        }
        let skill = package
            .manifest
            .components
            .skills
            .iter()
            .find(|skill| skill.id == hook.skill && skill.enabled_by_default)
            .ok_or_else(|| format!("plugin hook references a disabled skill: {}", hook.skill))?;
        let permission = package
            .manifest
            .permissions
            .iter()
            .find(|permission| {
                permission.capability == "agent.invoke"
                    && permission.resource == hook.event
                    && permission.access == "execute"
            })
            .ok_or_else(|| {
                format!(
                    "plugin hook {} requires undeclared permission: agent.invoke execute {}",
                    hook.id, hook.event
                )
            })?;
        if !permission_is_allowed(permission, &record.active_revision, &grants) {
            return Err(format!(
                "plugin hook {} permission has not been allowed",
                hook.id
            ));
        }
        registrations.push(PluginHookRegistration {
            plugin_id: record.id.clone(),
            hook_id: hook.id.clone(),
            event: hook.event.clone(),
            skill: skill.id.clone(),
        });
    }
    Ok(hooks.set(&record.id, registrations))
}

pub(crate) async fn hydrate_plugin_skills(store: &Store, skills: &SkillCatalog) -> Result<()> {
    for record in store.list_plugins().await? {
        if record.enabled {
            let package = load_active_plugin_package(store, &record).await;
            let valid = match package {
                Ok(package) => active_plugin_permission_grants(store, &record, &package.manifest)
                    .await
                    .map(|_| ()),
                Err(error) => Err(error),
            };
            if let Err(error) = valid {
                warn!(plugin_id = %record.id, %error, "disabled plugin during hydration");
                store.set_plugin_enabled(&record.id, false).await?;
                let _ = skills.remove_plugin_roots(&record.id);
                continue;
            }
            reconcile_plugin_skills(store, skills, &record)
                .await
                .map_err(|error| anyhow::anyhow!("hydrate plugin {}: {error}", record.id))?;
        }
    }
    Ok(())
}

pub(crate) async fn hydrate_plugin_connectors(
    store: &Store,
    connectors: &ConnectorService,
) -> Result<()> {
    for record in store.list_plugins().await? {
        if record.enabled {
            reconcile_plugin_connectors(store, connectors, &record)
                .await
                .map_err(|error| anyhow::anyhow!("hydrate plugin {}: {error}", record.id))?;
        }
    }
    Ok(())
}

pub(crate) async fn hydrate_plugin_mcp(store: &Store, mcp: &McpManager) -> Result<()> {
    for record in store.list_plugins().await? {
        if record.enabled {
            reconcile_plugin_mcp(store, mcp, &record)
                .await
                .map_err(|error| anyhow::anyhow!("hydrate plugin {} MCP: {error}", record.id))?;
        }
    }
    Ok(())
}

pub(crate) async fn hydrate_plugin_hooks(store: &Store, hooks: &PluginHookCatalog) -> Result<()> {
    for record in store.list_plugins().await? {
        if record.enabled {
            reconcile_plugin_hooks(store, hooks, &record)
                .await
                .map_err(|error| anyhow::anyhow!("hydrate plugin {} hooks: {error}", record.id))?;
        }
    }
    Ok(())
}

pub(crate) async fn reconcile_plugin_components(
    state: &AppState,
    record: PluginRecord,
) -> Result<PluginRecord, RpcFailure> {
    if record.enabled {
        let package = load_active_plugin_package(&state.store, &record)
            .await
            .map_err(RpcFailure::application)?;
        package
            .ui_contributions()
            .map_err(|error| RpcFailure::application(error.to_string()))?;
        if let Err(error) =
            active_plugin_permission_grants(&state.store, &record, &package.manifest).await
        {
            let _ = state.skills.remove_plugin_roots(&record.id);
            let _ = state.connectors.remove_plugin_packages(&record.id).await;
            state.mcp.remove_plugin_components(&record.id);
            state.plugin_hooks.remove(&record.id);
            let disabled = state.store.set_plugin_enabled(&record.id, false).await;
            apply_skill_system_prompt(state);
            return match disabled {
                Ok(_) => Err(RpcFailure::application(format!(
                    "plugin {} was installed but disabled pending permission review: {error}",
                    record.id
                ))),
                Err(store_error) => Err(RpcFailure::application(format!(
                    "plugin {} could not be disabled after permission validation failed ({error}): {store_error}",
                    record.id
                ))),
            };
        }
    }
    match reconcile_plugin_skills(&state.store, &state.skills, &record).await {
        Ok(skills_changed) => {
            let connectors_changed =
                reconcile_plugin_connectors(&state.store, &state.connectors, &record).await;
            if let Err(error) = connectors_changed {
                let _ = state.skills.remove_plugin_roots(&record.id);
                let _ = state.connectors.remove_plugin_packages(&record.id).await;
                state.mcp.remove_plugin_components(&record.id);
                state.plugin_hooks.remove(&record.id);
                let _ = state.store.set_plugin_enabled(&record.id, false).await;
                apply_skill_system_prompt(state);
                return Err(RpcFailure::application(format!(
                    "plugin {} was disabled because its components could not be activated: {error}",
                    record.id
                )));
            }
            let mcp_changed = reconcile_plugin_mcp(&state.store, &state.mcp, &record).await;
            if let Err(error) = mcp_changed {
                let _ = state.skills.remove_plugin_roots(&record.id);
                let _ = state.connectors.remove_plugin_packages(&record.id).await;
                state.mcp.remove_plugin_components(&record.id);
                state.plugin_hooks.remove(&record.id);
                let _ = state.store.set_plugin_enabled(&record.id, false).await;
                apply_skill_system_prompt(state);
                return Err(RpcFailure::application(format!(
                    "plugin {} was disabled because its MCP components could not be activated: {error}",
                    record.id
                )));
            }
            if let Err(error) =
                reconcile_plugin_hooks(&state.store, &state.plugin_hooks, &record).await
            {
                let _ = state.skills.remove_plugin_roots(&record.id);
                let _ = state.connectors.remove_plugin_packages(&record.id).await;
                state.mcp.remove_plugin_components(&record.id);
                state.plugin_hooks.remove(&record.id);
                let _ = state.store.set_plugin_enabled(&record.id, false).await;
                apply_skill_system_prompt(state);
                return Err(RpcFailure::application(format!(
                    "plugin {} was disabled because its hooks could not be activated: {error}",
                    record.id
                )));
            }
            if skills_changed {
                apply_skill_system_prompt(state);
            }
            Ok(record)
        }
        Err(error) => {
            let _ = state.skills.remove_plugin_roots(&record.id);
            let _ = state.connectors.remove_plugin_packages(&record.id).await;
            state.mcp.remove_plugin_components(&record.id);
            state.plugin_hooks.remove(&record.id);
            let _ = state.store.set_plugin_enabled(&record.id, false).await;
            apply_skill_system_prompt(state);
            Err(RpcFailure::application(format!(
                "plugin {} was disabled because its components could not be activated: {error}",
                record.id
            )))
        }
    }
}

pub(crate) fn spawn_catalog_worker(
    skills: SkillCatalog,
    runtime: SessionRuntime,
    multiagents: MultiAgentService,
    workspaces: WorkspaceService,
    workspace_skill_roots: WorkspaceSkillRoots,
    heartbeat: Arc<AtomicI64>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            heartbeat.store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
            let pending = match workspaces.state().await {
                Ok(state) => state.pending_path,
                Err(error) => {
                    warn!(%error, "failed to read durable workspace state");
                    None
                }
            };
            if let Some(pending) = pending {
                match workspaces.runtime_is_idle().await {
                    Ok(true) => {
                        let target = PathBuf::from(&pending);
                        let new_catalog = SubagentCatalog::discover(&target, None);
                        let new_roots = workspace_skill_roots.resolve(&target);
                        let validation = new_catalog.and_then(|catalog| {
                            skills
                                .replace_roots(new_roots)
                                .map_err(|error| error.to_string())?;
                            Ok(catalog)
                        });
                        match validation {
                            Ok(new_catalog) => {
                                let previous_root = workspaces.current_root();
                                let previous_roots = workspace_skill_roots.resolve(&previous_root);
                                let previous_catalog =
                                    SubagentCatalog::discover(&previous_root, None);
                                multiagents.reconfigure_workspace(target.clone(), new_catalog);
                                let prompt = skill_system_prompt(&skills);
                                runtime.set_system_prompt(&prompt);
                                multiagents.set_system_prompt(prompt);
                                match workspaces.commit_pending(&target).await {
                                    Ok(_) => {
                                        info!(workspace = %target.display(), "workspace switch applied")
                                    }
                                    Err(error) => {
                                        let _ = skills.replace_roots(previous_roots);
                                        if let Ok(previous_catalog) = previous_catalog {
                                            multiagents.reconfigure_workspace(
                                                previous_root,
                                                previous_catalog,
                                            );
                                        }
                                        let prompt = skill_system_prompt(&skills);
                                        runtime.set_system_prompt(&prompt);
                                        multiagents.set_system_prompt(prompt);
                                        warn!(%error, workspace = %target.display(), "workspace switch commit failed and runtime configuration was rolled back");
                                    }
                                }
                            }
                            Err(error) => {
                                if let Err(store_error) =
                                    workspaces.fail_pending(&target, &error).await
                                {
                                    warn!(%store_error, %error, workspace = %target.display(), "failed to reject invalid workspace switch");
                                } else {
                                    warn!(%error, workspace = %target.display(), "workspace switch rejected during validation");
                                }
                            }
                        }
                        continue;
                    }
                    Ok(false) => {}
                    Err(error) => warn!(%error, "failed to check workspace runtime idleness"),
                }
            }
            let catalog = skills.clone();
            match tokio::task::spawn_blocking(move || catalog.refresh()).await {
                Ok(Ok(true)) => {
                    let prompt = skill_system_prompt(&skills);
                    runtime.set_system_prompt(&prompt);
                    multiagents.set_system_prompt(prompt);
                    info!("skill catalog refreshed");
                }
                Ok(Ok(false)) => {}
                Ok(Err(error)) => warn!(%error, "skill catalog refresh rejected"),
                Err(error) => warn!(%error, "skill catalog refresh task failed"),
            }
        }
    })
}

pub(crate) fn spawn_plugin_hook_worker(
    store: Store,
    hooks: PluginHookCatalog,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut events = store.subscribe();
        loop {
            let event = match events.recv().await {
                Ok(event) => event,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    warn!(skipped, "plugin hook worker lagged; skipped old events");
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            };
            for hook in hooks.matching(&event.event_type) {
                let payload_text = serde_json::to_string(&event.payload)
                    .unwrap_or_else(|_| "null".to_owned())
                    .chars()
                    .take(16_384)
                    .collect::<String>();
                if let Err(error) = store
                    .schedule_job(
                        "plugin.hook",
                        Some(event.session_id),
                        chrono::Utc::now().timestamp_millis(),
                        json!({
                            "pluginId":hook.plugin_id,
                            "hookId":hook.hook_id,
                            "skill":hook.skill,
                            "triggerEventId":event.id,
                            "triggerEventType":event.event_type,
                            "triggerPayload":payload_text,
                        }),
                        &format!("plugin-hook:{}:{}", hook.hook_id, event.id),
                    )
                    .await
                {
                    warn!(%error, plugin_id=%hook.plugin_id, hook_id=%hook.hook_id, "failed to schedule plugin hook");
                }
            }
        }
    })
}

pub(crate) const PLUGIN_MARKET_REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

pub(crate) fn spawn_plugin_market_refresh_worker(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match state.store.list_plugin_market_sources().await {
                Ok(sources) => {
                    for source in sources.into_iter().filter(|source| source.enabled) {
                        let source_id = source.id.clone();
                        if let Err(error) = refresh_market_source(&state, source).await {
                            warn!(error=%error.message, %source_id, "automatic plugin market refresh failed");
                        }
                    }
                }
                Err(error) => warn!(%error, "failed to list plugin markets for automatic refresh"),
            }
            tokio::time::sleep(PLUGIN_MARKET_REFRESH_INTERVAL).await;
        }
    })
}
