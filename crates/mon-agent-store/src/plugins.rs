use super::{Store, StoreError, now_ms};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, sqlite::SqliteRow};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub active_version: String,
    pub active_revision: String,
    pub enabled: bool,
    pub trust_state: String,
    pub source_type: String,
    pub source_uri: String,
    pub manifest: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginVersionRecord {
    pub plugin_id: String,
    pub version: String,
    pub revision: String,
    pub root_path: String,
    pub trust_state: String,
    pub source_type: String,
    pub source_uri: String,
    pub manifest: Value,
    pub installed_at: i64,
}

#[derive(Clone, Debug)]
pub struct PluginInstallRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub revision: String,
    pub root_path: String,
    pub trust_state: String,
    pub source_type: String,
    pub source_uri: String,
    pub manifest: Value,
    pub enabled: bool,
    pub activate: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPermissionGrantRecord {
    pub plugin_id: String,
    pub capability: String,
    pub resource: String,
    pub access: String,
    pub decision: String,
    pub manifest_revision: String,
    pub decided_at: i64,
}

#[derive(Clone, Debug)]
pub struct PluginPermissionGrantInput {
    pub capability: String,
    pub resource: String,
    pub access: String,
    pub decision: String,
}

#[derive(Clone, Debug)]
pub struct PluginMarketSourceRecord {
    pub id: String,
    pub name: String,
    pub url: String,
    pub key_id: String,
    pub enabled: bool,
    pub index: Option<Value>,
    pub index_revision: Option<String>,
    pub last_refreshed_at: Option<i64>,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug)]
pub struct PluginMarketRevocationInput {
    pub plugin_id: String,
    pub version: String,
    pub revision: String,
    pub reason: String,
}

#[derive(Clone, Debug)]
pub struct PluginMarketRevocationRecord {
    pub source_id: String,
    pub plugin_id: String,
    pub version: String,
    pub revision: String,
    pub reason: String,
    pub revoked_at: i64,
}

impl Store {
    pub async fn upsert_plugin_market_source(
        &self,
        id: &str,
        name: &str,
        url: &str,
        key_id: &str,
        enabled: bool,
    ) -> Result<PluginMarketSourceRecord, StoreError> {
        let now = now_ms();
        sqlx::query(
            "INSERT INTO plugin_market_sources(
                id,name,url,key_id,enabled,created_at,updated_at
             ) VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,url=excluded.url,key_id=excluded.key_id,
                enabled=excluded.enabled,index_json=NULL,index_revision=NULL,
                last_refreshed_at=NULL,last_error=NULL,updated_at=excluded.updated_at",
        )
        .bind(id)
        .bind(name)
        .bind(url)
        .bind(key_id)
        .bind(enabled)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await?;
        self.get_plugin_market_source(id).await
    }

    pub async fn get_plugin_market_source(
        &self,
        id: &str,
    ) -> Result<PluginMarketSourceRecord, StoreError> {
        let row = sqlx::query("SELECT * FROM plugin_market_sources WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| {
                StoreError::InvalidValue(format!("plugin market source not found: {id}"))
            })?;
        plugin_market_source_from_row(row)
    }

    pub async fn list_plugin_market_sources(
        &self,
    ) -> Result<Vec<PluginMarketSourceRecord>, StoreError> {
        sqlx::query("SELECT * FROM plugin_market_sources ORDER BY id")
            .fetch_all(&self.pool)
            .await?
            .into_iter()
            .map(plugin_market_source_from_row)
            .collect()
    }

    pub async fn cache_plugin_market_index(
        &self,
        id: &str,
        index: Option<&Value>,
        revision: Option<&str>,
        error: Option<&str>,
    ) -> Result<PluginMarketSourceRecord, StoreError> {
        let now = now_ms();
        let index_json = index.map(serde_json::to_string).transpose()?;
        let result = sqlx::query(
            "UPDATE plugin_market_sources SET index_json=COALESCE(?,index_json),
             index_revision=COALESCE(?,index_revision),
             last_refreshed_at=?,last_error=?,updated_at=? WHERE id=?",
        )
        .bind(index_json)
        .bind(revision)
        .bind(now)
        .bind(error)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StoreError::InvalidValue(format!(
                "plugin market source not found: {id}"
            )));
        }
        self.get_plugin_market_source(id).await
    }

    pub async fn delete_plugin_market_source(&self, id: &str) -> Result<bool, StoreError> {
        Ok(sqlx::query("DELETE FROM plugin_market_sources WHERE id=?")
            .bind(id)
            .execute(&self.pool)
            .await?
            .rows_affected()
            != 0)
    }

    pub async fn replace_plugin_market_revocations(
        &self,
        source_id: &str,
        revocations: Vec<PluginMarketRevocationInput>,
    ) -> Result<(), StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let exists = sqlx::query("SELECT 1 FROM plugin_market_sources WHERE id=?")
            .bind(source_id)
            .fetch_optional(&mut *transaction)
            .await?
            .is_some();
        if !exists {
            return Err(StoreError::InvalidValue(format!(
                "plugin market source not found: {source_id}"
            )));
        }
        sqlx::query("DELETE FROM plugin_market_revocations WHERE source_id=?")
            .bind(source_id)
            .execute(&mut *transaction)
            .await?;
        let now = now_ms();
        for revocation in revocations {
            sqlx::query(
                "INSERT INTO plugin_market_revocations(
                    source_id,plugin_id,version,revision,reason,revoked_at
                 ) VALUES (?,?,?,?,?,?)",
            )
            .bind(source_id)
            .bind(revocation.plugin_id)
            .bind(revocation.version)
            .bind(revocation.revision)
            .bind(revocation.reason)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn cache_plugin_market_snapshot(
        &self,
        source_id: &str,
        index: &Value,
        revision: &str,
        revocations: Vec<PluginMarketRevocationInput>,
    ) -> Result<PluginMarketSourceRecord, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let now = now_ms();
        let result = sqlx::query(
            "UPDATE plugin_market_sources SET index_json=?,index_revision=?,
             last_refreshed_at=?,last_error=NULL,updated_at=? WHERE id=?",
        )
        .bind(serde_json::to_string(index)?)
        .bind(revision)
        .bind(now)
        .bind(now)
        .bind(source_id)
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StoreError::InvalidValue(format!(
                "plugin market source not found: {source_id}"
            )));
        }
        sqlx::query("DELETE FROM plugin_market_revocations WHERE source_id=?")
            .bind(source_id)
            .execute(&mut *transaction)
            .await?;
        for revocation in revocations {
            sqlx::query(
                "INSERT INTO plugin_market_revocations(
                    source_id,plugin_id,version,revision,reason,revoked_at
                 ) VALUES (?,?,?,?,?,?)",
            )
            .bind(source_id)
            .bind(revocation.plugin_id)
            .bind(revocation.version)
            .bind(revocation.revision)
            .bind(revocation.reason)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        self.get_plugin_market_source(source_id).await
    }

    pub async fn get_plugin_market_revocation(
        &self,
        plugin_id: &str,
        version: &str,
        revision: &str,
    ) -> Result<Option<PluginMarketRevocationRecord>, StoreError> {
        sqlx::query(
            "SELECT * FROM plugin_market_revocations
             WHERE plugin_id=? AND version=? AND revision=?
             ORDER BY source_id LIMIT 1",
        )
        .bind(plugin_id)
        .bind(version)
        .bind(revision)
        .fetch_optional(&self.pool)
        .await?
        .map(|row| {
            Ok(PluginMarketRevocationRecord {
                source_id: row.try_get("source_id")?,
                plugin_id: row.try_get("plugin_id")?,
                version: row.try_get("version")?,
                revision: row.try_get("revision")?,
                reason: row.try_get("reason")?,
                revoked_at: row.try_get("revoked_at")?,
            })
        })
        .transpose()
    }

    pub async fn record_plugin_install(
        &self,
        input: PluginInstallRecord,
    ) -> Result<PluginRecord, StoreError> {
        let now = now_ms();
        let manifest_json = serde_json::to_string(&input.manifest)?;
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        sqlx::query(
            "INSERT INTO plugins(
                id, name, description, active_version, active_revision, enabled,
                trust_state, source_type, source_uri, manifest_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                description=excluded.description,
                updated_at=excluded.updated_at",
        )
        .bind(&input.id)
        .bind(&input.name)
        .bind(&input.description)
        .bind(&input.version)
        .bind(&input.revision)
        .bind(input.enabled)
        .bind(&input.trust_state)
        .bind(&input.source_type)
        .bind(&input.source_uri)
        .bind(&manifest_json)
        .bind(now)
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO plugin_versions(
                plugin_id, version, revision, root_path, trust_state,
                source_type, source_uri, manifest_json, installed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(plugin_id, version, revision) DO NOTHING",
        )
        .bind(&input.id)
        .bind(&input.version)
        .bind(&input.revision)
        .bind(&input.root_path)
        .bind(&input.trust_state)
        .bind(&input.source_type)
        .bind(&input.source_uri)
        .bind(&manifest_json)
        .bind(now)
        .execute(&mut *transaction)
        .await?;
        if input.activate {
            sqlx::query(
                "UPDATE plugins SET
                    active_version=?, active_revision=?, enabled=?, trust_state=?,
                    source_type=?, source_uri=?, manifest_json=?, updated_at=?
                 WHERE id=?",
            )
            .bind(&input.version)
            .bind(&input.revision)
            .bind(input.enabled)
            .bind(&input.trust_state)
            .bind(&input.source_type)
            .bind(&input.source_uri)
            .bind(&manifest_json)
            .bind(now)
            .bind(&input.id)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        self.get_plugin(&input.id).await
    }

    pub async fn list_plugins(&self) -> Result<Vec<PluginRecord>, StoreError> {
        let rows = sqlx::query("SELECT * FROM plugins ORDER BY id")
            .fetch_all(&self.pool)
            .await?;
        rows.into_iter().map(plugin_from_row).collect()
    }

    pub async fn get_plugin(&self, id: &str) -> Result<PluginRecord, StoreError> {
        let row = sqlx::query("SELECT * FROM plugins WHERE id=?")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| StoreError::PluginNotFound(id.to_owned()))?;
        plugin_from_row(row)
    }

    pub async fn list_plugin_versions(
        &self,
        id: &str,
    ) -> Result<Vec<PluginVersionRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT * FROM plugin_versions
             WHERE plugin_id=? ORDER BY installed_at DESC, version DESC, revision",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(plugin_version_from_row).collect()
    }

    pub async fn set_plugin_enabled(
        &self,
        id: &str,
        enabled: bool,
    ) -> Result<PluginRecord, StoreError> {
        let result = sqlx::query("UPDATE plugins SET enabled=?, updated_at=? WHERE id=?")
            .bind(enabled)
            .bind(now_ms())
            .bind(id)
            .execute(&self.pool)
            .await?;
        if result.rows_affected() == 0 {
            return Err(StoreError::PluginNotFound(id.to_owned()));
        }
        self.get_plugin(id).await
    }

    pub async fn activate_plugin_version(
        &self,
        id: &str,
        version: &str,
        revision: &str,
    ) -> Result<PluginRecord, StoreError> {
        let row = sqlx::query(
            "SELECT * FROM plugin_versions
             WHERE plugin_id=? AND version=? AND revision=?",
        )
        .bind(id)
        .bind(version)
        .bind(revision)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| {
            StoreError::InvalidValue(format!(
                "plugin version is not installed: {id}@{version}#{revision}"
            ))
        })?;
        let selected = plugin_version_from_row(row)?;
        let manifest_json = serde_json::to_string(&selected.manifest)?;
        let result = sqlx::query(
            "UPDATE plugins SET
                active_version=?, active_revision=?, trust_state=?, source_type=?,
                source_uri=?, manifest_json=?, updated_at=?
             WHERE id=?",
        )
        .bind(&selected.version)
        .bind(&selected.revision)
        .bind(&selected.trust_state)
        .bind(&selected.source_type)
        .bind(&selected.source_uri)
        .bind(manifest_json)
        .bind(now_ms())
        .bind(id)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(StoreError::PluginNotFound(id.to_owned()));
        }
        self.get_plugin(id).await
    }

    pub async fn delete_plugin(&self, id: &str) -> Result<Vec<PluginVersionRecord>, StoreError> {
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let rows = sqlx::query(
            "SELECT * FROM plugin_versions
             WHERE plugin_id=? ORDER BY installed_at, version, revision",
        )
        .bind(id)
        .fetch_all(&mut *transaction)
        .await?;
        if rows.is_empty() {
            let exists = sqlx::query("SELECT 1 FROM plugins WHERE id=?")
                .bind(id)
                .fetch_optional(&mut *transaction)
                .await?
                .is_some();
            if !exists {
                return Err(StoreError::PluginNotFound(id.to_owned()));
            }
        }
        let versions = rows
            .into_iter()
            .map(plugin_version_from_row)
            .collect::<Result<Vec<_>, _>>()?;
        sqlx::query("DELETE FROM plugins WHERE id=?")
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(versions)
    }

    pub async fn replace_plugin_permission_grants(
        &self,
        id: &str,
        manifest_revision: &str,
        grants: Vec<PluginPermissionGrantInput>,
    ) -> Result<Vec<PluginPermissionGrantRecord>, StoreError> {
        if let Some(grant) = grants
            .iter()
            .find(|grant| !matches!(grant.decision.as_str(), "allowed" | "denied"))
        {
            return Err(StoreError::InvalidValue(format!(
                "invalid plugin permission decision: {}",
                grant.decision
            )));
        }
        let now = now_ms();
        let mut transaction = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let active_revision: Option<String> =
            sqlx::query_scalar("SELECT active_revision FROM plugins WHERE id=?")
                .bind(id)
                .fetch_optional(&mut *transaction)
                .await?;
        let active_revision =
            active_revision.ok_or_else(|| StoreError::PluginNotFound(id.to_owned()))?;
        if active_revision != manifest_revision {
            return Err(StoreError::InvalidValue(format!(
                "permission review revision does not match active plugin revision: expected {active_revision}, found {manifest_revision}"
            )));
        }
        sqlx::query("DELETE FROM plugin_permission_grants WHERE plugin_id=?")
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        for grant in grants {
            sqlx::query(
                "INSERT INTO plugin_permission_grants(
                    plugin_id, capability, resource, access, decision,
                    manifest_revision, decided_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(id)
            .bind(grant.capability)
            .bind(grant.resource)
            .bind(grant.access)
            .bind(grant.decision)
            .bind(manifest_revision)
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        self.list_plugin_permission_grants(id).await
    }

    pub async fn list_plugin_permission_grants(
        &self,
        id: &str,
    ) -> Result<Vec<PluginPermissionGrantRecord>, StoreError> {
        let rows = sqlx::query(
            "SELECT * FROM plugin_permission_grants
             WHERE plugin_id=? ORDER BY capability, resource, access",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(PluginPermissionGrantRecord {
                    plugin_id: row.try_get("plugin_id")?,
                    capability: row.try_get("capability")?,
                    resource: row.try_get("resource")?,
                    access: row.try_get("access")?,
                    decision: row.try_get("decision")?,
                    manifest_revision: row.try_get("manifest_revision")?,
                    decided_at: row.try_get("decided_at")?,
                })
            })
            .collect()
    }
}

fn plugin_market_source_from_row(row: SqliteRow) -> Result<PluginMarketSourceRecord, StoreError> {
    let index = row
        .try_get::<Option<String>, _>("index_json")?
        .map(|value| serde_json::from_str(&value))
        .transpose()?;
    Ok(PluginMarketSourceRecord {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        url: row.try_get("url")?,
        key_id: row.try_get("key_id")?,
        enabled: row.try_get("enabled")?,
        index,
        index_revision: row.try_get("index_revision")?,
        last_refreshed_at: row.try_get("last_refreshed_at")?,
        last_error: row.try_get("last_error")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn plugin_from_row(row: SqliteRow) -> Result<PluginRecord, StoreError> {
    Ok(PluginRecord {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        description: row.try_get("description")?,
        active_version: row.try_get("active_version")?,
        active_revision: row.try_get("active_revision")?,
        enabled: row.try_get("enabled")?,
        trust_state: row.try_get("trust_state")?,
        source_type: row.try_get("source_type")?,
        source_uri: row.try_get("source_uri")?,
        manifest: serde_json::from_str(&row.try_get::<String, _>("manifest_json")?)?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn plugin_version_from_row(row: SqliteRow) -> Result<PluginVersionRecord, StoreError> {
    Ok(PluginVersionRecord {
        plugin_id: row.try_get("plugin_id")?,
        version: row.try_get("version")?,
        revision: row.try_get("revision")?,
        root_path: row.try_get("root_path")?,
        trust_state: row.try_get("trust_state")?,
        source_type: row.try_get("source_type")?,
        source_uri: row.try_get("source_uri")?,
        manifest: serde_json::from_str(&row.try_get::<String, _>("manifest_json")?)?,
        installed_at: row.try_get("installed_at")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn install(version: &str, revision: &str, activate: bool) -> PluginInstallRecord {
        PluginInstallRecord {
            id: "mon.test".to_owned(),
            name: "Test Plugin".to_owned(),
            description: "test".to_owned(),
            version: version.to_owned(),
            revision: revision.to_owned(),
            root_path: format!("/plugins/mon.test/{version}/{revision}"),
            trust_state: "development_unverified".to_owned(),
            source_type: "local".to_owned(),
            source_uri: "/source/test".to_owned(),
            manifest: json!({"version":version}),
            enabled: true,
            activate,
        }
    }

    #[tokio::test]
    async fn plugin_versions_are_immutable_and_activation_is_explicit() {
        let store = Store::in_memory().await.expect("store");
        let first = store
            .record_plugin_install(install("1.0.0", "rev-1", true))
            .await
            .expect("first install");
        assert_eq!(first.active_version, "1.0.0");
        store
            .record_plugin_install(install("1.1.0", "rev-2", false))
            .await
            .expect("second install");
        assert_eq!(
            store
                .get_plugin("mon.test")
                .await
                .expect("plugin")
                .active_revision,
            "rev-1"
        );
        assert_eq!(
            store
                .list_plugin_versions("mon.test")
                .await
                .expect("versions")
                .len(),
            2
        );

        let active = store
            .activate_plugin_version("mon.test", "1.1.0", "rev-2")
            .await
            .expect("activate");
        assert_eq!(active.active_revision, "rev-2");
        assert!(
            !store
                .set_plugin_enabled("mon.test", false)
                .await
                .expect("disable")
                .enabled
        );
        let grants = store
            .replace_plugin_permission_grants(
                "mon.test",
                "rev-2",
                vec![PluginPermissionGrantInput {
                    capability: "filesystem.read".to_owned(),
                    resource: "settings.root".to_owned(),
                    access: "read".to_owned(),
                    decision: "allowed".to_owned(),
                }],
            )
            .await
            .expect("permissions");
        assert_eq!(grants.len(), 1);
        assert_eq!(grants[0].manifest_revision, "rev-2");
        assert!(
            store
                .replace_plugin_permission_grants("mon.test", "rev-1", Vec::new())
                .await
                .is_err()
        );
        let removed = store.delete_plugin("mon.test").await.expect("delete");
        assert_eq!(removed.len(), 2);
        assert!(matches!(
            store.get_plugin("mon.test").await,
            Err(StoreError::PluginNotFound(_))
        ));
    }

    #[tokio::test]
    async fn market_sources_cache_indexes_and_replace_revocations_atomically() {
        let store = Store::in_memory().await.expect("store");
        store
            .upsert_plugin_market_source(
                "official",
                "Official",
                "https://plugins.example/index.json",
                "release",
                true,
            )
            .await
            .expect("source");
        let index = json!({"schemaVersion":1});
        let source = store
            .cache_plugin_market_snapshot(
                "official",
                &index,
                "index-rev",
                vec![PluginMarketRevocationInput {
                    plugin_id: "mon.revoked".to_owned(),
                    version: "1.0.0".to_owned(),
                    revision: "a".repeat(64),
                    reason: "compromised".to_owned(),
                }],
            )
            .await
            .expect("cache");
        assert_eq!(source.index, Some(index));
        store
            .cache_plugin_market_index("official", None, None, Some("temporary network error"))
            .await
            .expect("cache error");
        assert_eq!(
            store
                .get_plugin_market_source("official")
                .await
                .expect("source")
                .index_revision
                .as_deref(),
            Some("index-rev")
        );
        let revocation = store
            .get_plugin_market_revocation("mon.revoked", "1.0.0", &"a".repeat(64))
            .await
            .expect("read")
            .expect("revoked");
        assert_eq!(revocation.reason, "compromised");
        store
            .replace_plugin_market_revocations("official", Vec::new())
            .await
            .expect("clear revocations");
        assert!(
            store
                .get_plugin_market_revocation("mon.revoked", "1.0.0", &"a".repeat(64))
                .await
                .expect("read")
                .is_none()
        );
        assert!(
            store
                .delete_plugin_market_source("official")
                .await
                .expect("delete")
        );
    }
}
