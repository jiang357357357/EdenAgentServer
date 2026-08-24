use super::*;

pub(crate) async fn execute_extensions_rpc(
    state: &AppState,
    method: &str,
    params: Value,
) -> Result<Value, RpcFailure> {
    match method {
        "skill.list" => {
            let _: SkillListParams = parse_params(params)?;
            let skills = state
                .skills
                .list()
                .into_iter()
                .map(|skill| skill_info(&state.skills, skill, false))
                .collect::<Vec<_>>();
            serde_json::to_value(skills).map_err(|error| RpcFailure::application(error.to_string()))
        }
        "skill.read" => {
            let params: SkillReadParams = parse_params(params)?;
            let skill = state.skills.get(&params.name).ok_or_else(|| {
                RpcFailure::application(format!("skill not found: {}", params.name))
            })?;
            serde_json::to_value(skill_info(&state.skills, skill, true))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "skill.install" => {
            let params: SkillInstallParams = parse_params(params)?;
            let skill = state
                .skills
                .install(&params.name, &params.description, &params.content)
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            apply_skill_system_prompt(state);
            serde_json::to_value(skill_info(&state.skills, skill, true))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "skill.enable" => {
            let params: SkillEnableParams = parse_params(params)?;
            let skill = state
                .skills
                .set_enabled(&params.name, params.enabled)
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            apply_skill_system_prompt(state);
            serde_json::to_value(skill_info(&state.skills, skill, true))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "skill.uninstall" => {
            let params: SkillReadParams = parse_params(params)?;
            state
                .skills
                .uninstall(&params.name)
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            apply_skill_system_prompt(state);
            Ok(json!({"deleted":true}))
        }
        "skill.inspect" => {
            let params: SkillInspectParams = parse_params(params)?;
            let source_type = params.source_type.as_str();
            let source = params.source_uri.as_str();
            let subpath = params.source_subpath.as_deref();
            let source_ref = params.source_ref.as_deref();
            let scope = params.scope.as_str();
            let (preview_id, skill) = match source_type {
                "local" => state.skills.inspect_local_for(
                    "rpc-local",
                    std::path::Path::new(source),
                    subpath,
                    scope,
                    "local",
                    None,
                ),
                "git" => {
                    state
                        .skills
                        .inspect_git_for("rpc-local", source, source_ref, subpath, scope)
                }
                other => {
                    return Err(RpcFailure::application(format!(
                        "unsupported skill source type: {other}"
                    )));
                }
            }
            .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(SkillPreviewInfo {
                preview_id,
                skill_name: skill.name,
                display_name: skill.display_name,
                description: skill.description,
                version: skill.version,
                scope: scope.to_owned(),
                source: SkillPreviewSource {
                    source_type: source_type.to_owned(),
                    uri: source.to_owned(),
                    source_ref: source_ref.unwrap_or("").to_owned(),
                    subpath: subpath.unwrap_or("").to_owned(),
                },
                tools: skill.tools,
                profiles: skill.profiles,
                model_invocable: !skill.disable_model_invocation,
                content_hash: skill.content_hash,
                file_count: u64::try_from(skill.files.len()).unwrap_or(u64::MAX),
                total_bytes: skill.total_bytes,
                expires_at: chrono::Utc::now().timestamp_millis() + 900_000,
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "skill.install_preview" => {
            let params: SkillPreviewInstallParams = parse_params(params)?;
            let skill = state
                .skills
                .install_preview_for("rpc-local", &params.preview_id)
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            apply_skill_system_prompt(state);
            serde_json::to_value(skill_info(&state.skills, skill, true))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "plugin.list" => {
            let _: PluginListParams = parse_params(params)?;
            let records = state
                .store
                .list_plugins()
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let mut plugins = Vec::with_capacity(records.len());
            for record in records {
                plugins.push(plugin_info(state, record).await?);
            }
            serde_json::to_value(plugins)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "plugin.read" => {
            let params: PluginReadParams = parse_params(params)?;
            let record = state
                .store
                .get_plugin(&params.id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(plugin_info(state, record).await?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "plugin.inspect" => {
            let params: PluginInspectParams = parse_params(params)?;
            if params.source_type != "local" {
                return Err(RpcFailure::invalid_params(format!(
                    "unsupported plugin source type: {}",
                    params.source_type
                )));
            }
            let preview = state
                .plugins
                .inspect_local_for("rpc-local", StdPath::new(&params.source_uri))
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(plugin_preview_info(preview))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "plugin.install_preview" => {
            let params: PluginPreviewInstallParams = parse_params(params)?;
            let outcome = state
                .plugins
                .install_preview_for("rpc-local", &params.preview_id, params.require_verified)
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let trust_state = outcome.plugin.trust.label();
            let manifest = serde_json::to_value(&outcome.plugin.manifest)
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let record = state
                .store
                .record_plugin_install(PluginInstallRecord {
                    id: outcome.plugin.manifest.id.clone(),
                    name: outcome.plugin.manifest.name.clone(),
                    description: outcome.plugin.manifest.description.clone(),
                    version: outcome.plugin.manifest.version.clone(),
                    revision: outcome.plugin.revision.clone(),
                    root_path: outcome.plugin.root.to_string_lossy().into_owned(),
                    trust_state,
                    source_type: outcome.source_type,
                    source_uri: outcome.source_uri,
                    manifest,
                    enabled: params.enabled,
                    activate: params.activate,
                })
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            if let Err(error) = ensure_plugin_release_not_revoked(
                &state.store,
                &record.id,
                &record.active_version,
                &record.active_revision,
            )
            .await
            {
                let _ = state.store.set_plugin_enabled(&record.id, false).await;
                return Err(error);
            }
            let record = reconcile_plugin_components(state, record).await?;
            serde_json::to_value(plugin_info(state, record).await?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "plugin.enable" => {
            let params: PluginEnableParams = parse_params(params)?;
            if params.enabled {
                let current = state
                    .store
                    .get_plugin(&params.id)
                    .await
                    .map_err(|error| RpcFailure::application(error.to_string()))?;
                ensure_plugin_release_not_revoked(
                    &state.store,
                    &current.id,
                    &current.active_version,
                    &current.active_revision,
                )
                .await?;
            }
            let record = state
                .store
                .set_plugin_enabled(&params.id, params.enabled)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let record = reconcile_plugin_components(state, record).await?;
            serde_json::to_value(plugin_info(state, record).await?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "plugin.permissions.set" => {
            let params: PluginPermissionSetParams = parse_params(params)?;
            let record = state
                .store
                .get_plugin(&params.id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            if record.active_revision != params.revision {
                return Err(RpcFailure::invalid_params(format!(
                    "permission review revision does not match active plugin revision: expected {}, found {}",
                    record.active_revision, params.revision
                )));
            }
            let manifest: PluginManifest = serde_json::from_value(record.manifest.clone())
                .map_err(|error| {
                    RpcFailure::application(format!("invalid persisted plugin manifest: {error}"))
                })?;
            let grants = validate_plugin_permission_decisions(&manifest, &params)?;
            state
                .store
                .replace_plugin_permission_grants(&params.id, &params.revision, grants)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let record = if record.enabled {
                match reconcile_plugin_components(state, record).await {
                    Ok(record) => record,
                    Err(_) => state
                        .store
                        .get_plugin(&params.id)
                        .await
                        .map_err(|error| RpcFailure::application(error.to_string()))?,
                }
            } else {
                record
            };
            serde_json::to_value(plugin_info(state, record).await?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "plugin.activate" => {
            let params: PluginActivateParams = parse_params(params)?;
            let selected = state
                .store
                .list_plugin_versions(&params.id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?
                .into_iter()
                .find(|version| {
                    version.version == params.version && version.revision == params.revision
                })
                .ok_or_else(|| {
                    RpcFailure::invalid_params(format!(
                        "plugin version is not installed: {}@{}#{}",
                        params.id, params.version, params.revision
                    ))
                })?;
            let package = LoadedPlugin::load(&selected.root_path, PluginLoadPolicy::Development)
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            if package.manifest.id != params.id
                || package.manifest.version != params.version
                || package.revision != params.revision
            {
                return Err(RpcFailure::application(
                    "installed plugin package no longer matches its immutable registry entry",
                ));
            }
            ensure_plugin_release_not_revoked(
                &state.store,
                &params.id,
                &params.version,
                &params.revision,
            )
            .await?;
            let record = state
                .store
                .activate_plugin_version(&params.id, &params.version, &params.revision)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let record = reconcile_plugin_components(state, record).await?;
            serde_json::to_value(plugin_info(state, record).await?)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "plugin.uninstall" => {
            let params: PluginReadParams = parse_params(params)?;
            let record = state
                .store
                .get_plugin(&params.id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let mut disabled = record.clone();
            disabled.enabled = false;
            reconcile_plugin_components(state, disabled).await?;
            let versions = match state.store.delete_plugin(&params.id).await {
                Ok(versions) => versions,
                Err(error) => {
                    let _ = reconcile_plugin_components(state, record).await;
                    return Err(RpcFailure::application(error.to_string()));
                }
            };
            let mut removed_versions = 0_u64;
            let mut cleanup_errors = Vec::new();
            for version in versions {
                match state.plugins.store().remove_installed_version(
                    &version.plugin_id,
                    &version.version,
                    &version.revision,
                ) {
                    Ok(true) => removed_versions = removed_versions.saturating_add(1),
                    Ok(false) => cleanup_errors.push(format!(
                        "package directory was already absent: {}@{}#{}",
                        version.plugin_id, version.version, version.revision
                    )),
                    Err(error) => cleanup_errors.push(error.to_string()),
                }
            }
            serde_json::to_value(PluginUninstallResult {
                id: params.id,
                deleted: true,
                removed_versions,
                cleanup_errors,
            })
            .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "plugin.market.source.list" => {
            let _: PluginListParams = parse_params(params)?;
            let sources = state
                .store
                .list_plugin_market_sources()
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?
                .into_iter()
                .map(plugin_market_source_info)
                .collect::<Vec<_>>();
            serde_json::to_value(sources)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "plugin.market.source.add" => {
            let params: PluginMarketSourceAddParams = parse_params(params)?;
            if params.id.len() < 2
                || params.id.len() > 128
                || (!params.id.as_bytes()[0].is_ascii_lowercase()
                    && !params.id.as_bytes()[0].is_ascii_digit())
                || !params.id.bytes().all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'.' | b'_' | b'-')
                })
            {
                return Err(RpcFailure::invalid_params(
                    "invalid plugin market source ID",
                ));
            }
            if params.name.trim().is_empty()
                || params.name.len() > 160
                || params.key_id.trim().is_empty()
                || params.key_id.len() > 160
                || params.url.len() > 2_048
                || eden_agent_market::validate_market_url(&params.url).is_err()
            {
                return Err(RpcFailure::invalid_params(
                    "invalid plugin market source metadata",
                ));
            }
            let source = state
                .store
                .upsert_plugin_market_source(
                    &params.id,
                    &params.name,
                    &params.url,
                    &params.key_id,
                    params.enabled,
                )
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            serde_json::to_value(plugin_market_source_info(source))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "plugin.market.source.remove" => {
            let params: PluginMarketSourceParams = parse_params(params)?;
            let deleted = state
                .store
                .delete_plugin_market_source(&params.id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            Ok(json!({"deleted":deleted}))
        }
        "plugin.market.source.refresh" => {
            let params: PluginMarketSourceParams = parse_params(params)?;
            let source = state
                .store
                .get_plugin_market_source(&params.id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let source = refresh_market_source(state, source).await?;
            serde_json::to_value(plugin_market_source_info(source))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "plugin.market.list" => {
            let params: PluginMarketListParams = parse_params(params)?;
            let sources = state
                .store
                .list_plugin_market_sources()
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            let mut releases = Vec::new();
            for source in sources.into_iter().filter(|source| {
                source.enabled && params.source_id.as_ref().is_none_or(|id| id == &source.id)
            }) {
                let index = cached_market_index(state, &source)?;
                for plugin in &index.envelope.payload.plugins {
                    for release in &plugin.versions {
                        let revocation = index.envelope.payload.revocations.iter().find(|item| {
                            item.plugin_id == plugin.id
                                && item.version == release.version
                                && item.revision == release.revision
                        });
                        releases.push(PluginMarketReleaseInfo {
                            source_id: source.id.clone(),
                            plugin_id: plugin.id.clone(),
                            name: plugin.name.clone(),
                            description: plugin.description.clone(),
                            version: release.version.clone(),
                            revision: release.revision.clone(),
                            revoked: revocation.is_some(),
                            revocation_reason: revocation.map(|item| item.reason.clone()),
                        });
                    }
                }
            }
            releases.sort_by(|left, right| {
                left.plugin_id
                    .cmp(&right.plugin_id)
                    .then_with(|| right.version.cmp(&left.version))
                    .then_with(|| left.source_id.cmp(&right.source_id))
            });
            serde_json::to_value(releases)
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        "plugin.market.inspect" => {
            let params: PluginMarketInspectParams = parse_params(params)?;
            let source = state
                .store
                .get_plugin_market_source(&params.source_id)
                .await
                .map_err(|error| RpcFailure::application(error.to_string()))?;
            if !source.enabled {
                return Err(RpcFailure::application("plugin market source is disabled"));
            }
            let index = cached_market_index(state, &source)?;
            let preview = state
                .marketplace
                .prepare_preview(
                    &state.plugins,
                    "rpc-local",
                    &source.id,
                    &index,
                    &params.plugin_id,
                    &params.version,
                )
                .await
                .map_err(RpcFailure::application)?;
            serde_json::to_value(plugin_preview_info(preview))
                .map_err(|error| RpcFailure::application(error.to_string()))
        }
        _ => Err(RpcFailure {
            code: -32601,
            message: "method not found".to_owned(),
        }),
    }
}
