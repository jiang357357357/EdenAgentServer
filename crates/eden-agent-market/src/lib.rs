//! Signed marketplace indexes and digest-pinned plugin package downloads.

use eden_agent_plugins::{ManagedInstallPreview, PluginInstaller, PluginTrustStore};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Cursor,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const MAX_INDEX_BYTES: usize = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: usize = 72 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ARCHIVE_FILES: usize = 520;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarketIndexEnvelope {
    pub schema_version: u32,
    pub key_id: String,
    pub payload: MarketIndexPayload,
    pub signature: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarketIndexPayload {
    pub generated_at: i64,
    pub expires_at: i64,
    #[serde(default)]
    pub plugins: Vec<MarketPlugin>,
    #[serde(default)]
    pub revocations: Vec<MarketRevocation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarketPlugin {
    pub id: String,
    pub name: String,
    pub description: String,
    pub versions: Vec<MarketPluginVersion>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarketPluginVersion {
    pub version: String,
    pub revision: String,
    pub url: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarketRevocation {
    pub plugin_id: String,
    pub version: String,
    pub revision: String,
    pub reason: String,
}

#[derive(Clone, Debug)]
pub struct VerifiedMarketIndex {
    pub envelope: MarketIndexEnvelope,
    pub revision: String,
}

#[derive(Clone)]
pub struct MarketplaceClient {
    client: Client,
    cache_root: Arc<PathBuf>,
}

impl MarketplaceClient {
    pub fn new(cache_root: impl AsRef<Path>) -> Result<Self, String> {
        fs::create_dir_all(cache_root.as_ref()).map_err(|error| error.to_string())?;
        let cache_root =
            fs::canonicalize(cache_root.as_ref()).map_err(|error| error.to_string())?;
        let client = Client::builder()
            .timeout(Duration::from_secs(45))
            .user_agent("Eden Agent-Plugin-Market/1")
            // Redirects would let an otherwise-valid HTTPS URL downgrade to an
            // untrusted HTTP or non-loopback target after our URL validation.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            client,
            cache_root: Arc::new(cache_root),
        })
    }

    pub async fn fetch_index(
        &self,
        url: &str,
        expected_key_id: &str,
        trust: &PluginTrustStore,
    ) -> Result<VerifiedMarketIndex, String> {
        validate_market_url(url)?;
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!("market index returned HTTP {}", response.status()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_INDEX_BYTES as u64)
        {
            return Err("market index exceeds 4 MiB".to_owned());
        }
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        if bytes.len() > MAX_INDEX_BYTES {
            return Err("market index exceeds 4 MiB".to_owned());
        }
        let envelope: MarketIndexEnvelope = serde_json::from_slice(&bytes)
            .map_err(|error| format!("invalid market index: {error}"))?;
        verify_index(envelope, expected_key_id, trust)
    }

    pub async fn prepare_preview(
        &self,
        installer: &PluginInstaller,
        owner: &str,
        source_id: &str,
        index: &VerifiedMarketIndex,
        plugin_id: &str,
        version: &str,
    ) -> Result<ManagedInstallPreview, String> {
        let (plugin, release) = find_release(index, plugin_id, version)?;
        if let Some(revocation) = index.envelope.payload.revocations.iter().find(|item| {
            item.plugin_id == plugin_id
                && item.version == release.version
                && item.revision == release.revision
        }) {
            return Err(format!("plugin release is revoked: {}", revocation.reason));
        }
        validate_market_url(&release.url)?;
        validate_sha256(&release.sha256)?;
        let package_root = self.download_and_extract(release).await?;
        let source_uri = format!(
            "market:{source_id}/{plugin_id}@{}#{}",
            release.version, release.revision
        );
        let preview = installer
            .inspect_with_provenance_for(owner, package_root, "market", &source_uri)
            .map_err(|error| error.to_string())?;
        if preview.preview.plugin.manifest.id != plugin.id
            || preview.preview.plugin.manifest.version != release.version
            || preview.preview.plugin.revision != release.revision
            || !preview.preview.plugin.trust.verified()
        {
            return Err("downloaded plugin does not match its signed market release".to_owned());
        }
        Ok(preview)
    }

    async fn download_and_extract(&self, release: &MarketPluginVersion) -> Result<PathBuf, String> {
        let destination = self.cache_root.join(&release.sha256).join("package");
        if destination.join("plugin.json").is_file() {
            return Ok(destination);
        }
        let response = self
            .client
            .get(&release.url)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if !response.status().is_success() {
            return Err(format!(
                "plugin download returned HTTP {}",
                response.status()
            ));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_ARCHIVE_BYTES as u64)
        {
            return Err("plugin archive exceeds compressed size limit".to_owned());
        }
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        if bytes.len() > MAX_ARCHIVE_BYTES {
            return Err("plugin archive exceeds compressed size limit".to_owned());
        }
        let actual = hex_digest(&bytes);
        if !actual.eq_ignore_ascii_case(&release.sha256) {
            return Err(format!(
                "plugin archive digest mismatch: expected {}, found {actual}",
                release.sha256
            ));
        }
        let parent = destination
            .parent()
            .ok_or_else(|| "invalid market cache path".to_owned())?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let staging = tempfile::Builder::new()
            .prefix(".market-stage-")
            .tempdir_in(&*self.cache_root)
            .map_err(|error| error.to_string())?;
        let extracted = staging.path().join("package");
        fs::create_dir(&extracted).map_err(|error| error.to_string())?;
        extract_zip(&bytes, &extracted)?;
        if !extracted.join("plugin.json").is_file() {
            return Err("plugin archive must contain plugin.json at its root".to_owned());
        }
        if destination.exists() {
            return Ok(destination);
        }
        if let Err(error) = fs::rename(&extracted, &destination)
            && !destination.join("plugin.json").is_file()
        {
            return Err(error.to_string());
        }
        Ok(destination)
    }
}

pub fn verify_index(
    envelope: MarketIndexEnvelope,
    expected_key_id: &str,
    trust: &PluginTrustStore,
) -> Result<VerifiedMarketIndex, String> {
    if envelope.schema_version != 1 || envelope.key_id != expected_key_id {
        return Err(
            "market index schema or signing key does not match the configured source".to_owned(),
        );
    }
    let now = epoch_millis();
    if envelope.payload.generated_at > now.saturating_add(300_000)
        || envelope.payload.expires_at <= now
        || envelope.payload.expires_at <= envelope.payload.generated_at
    {
        return Err("market index is expired or has invalid validity timestamps".to_owned());
    }
    validate_index_entries(&envelope.payload)?;
    let payload = serde_json::to_vec(&envelope.payload).map_err(|error| error.to_string())?;
    if !trust
        .verify(&envelope.key_id, &payload, &envelope.signature)
        .map_err(|error| error.to_string())?
    {
        return Err(format!(
            "market signing key is not trusted: {}",
            envelope.key_id
        ));
    }
    Ok(VerifiedMarketIndex {
        revision: hex_digest(&payload),
        envelope,
    })
}

pub fn find_release<'a>(
    index: &'a VerifiedMarketIndex,
    plugin_id: &str,
    version: &str,
) -> Result<(&'a MarketPlugin, &'a MarketPluginVersion), String> {
    let plugin = index
        .envelope
        .payload
        .plugins
        .iter()
        .find(|plugin| plugin.id == plugin_id)
        .ok_or_else(|| format!("plugin is not present in market: {plugin_id}"))?;
    let release = plugin
        .versions
        .iter()
        .find(|release| release.version == version)
        .ok_or_else(|| format!("plugin version is not present in market: {plugin_id}@{version}"))?;
    Ok((plugin, release))
}

fn validate_index_entries(payload: &MarketIndexPayload) -> Result<(), String> {
    if payload.plugins.len() > 10_000 || payload.revocations.len() > 20_000 {
        return Err("market index exceeds entry count limits".to_owned());
    }
    let id = regex::Regex::new(r"^[a-z0-9][a-z0-9._-]{1,127}$").expect("ID regex");
    let version = regex::Regex::new(r"^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$").expect("version regex");
    let mut ids = std::collections::HashSet::new();
    for plugin in &payload.plugins {
        if !id.is_match(&plugin.id)
            || !ids.insert(&plugin.id)
            || plugin.versions.is_empty()
            || plugin.versions.len() > 256
            || plugin.name.trim().is_empty()
            || plugin.name.chars().count() > 160
            || plugin.description.chars().count() > 4_000
        {
            return Err(format!("invalid or duplicate market plugin: {}", plugin.id));
        }
        let mut versions = std::collections::HashSet::new();
        for release in &plugin.versions {
            if !version.is_match(&release.version) || !versions.insert(&release.version) {
                return Err(format!(
                    "invalid or duplicate release: {}@{}",
                    plugin.id, release.version
                ));
            }
            validate_sha256(&release.sha256)?;
            validate_sha256(&release.revision)?;
            if release.url.len() > 2_048 {
                return Err("market release URL exceeds 2048 bytes".to_owned());
            }
            validate_market_url(&release.url)?;
        }
    }
    let mut revocations = std::collections::HashSet::new();
    for revocation in &payload.revocations {
        if !id.is_match(&revocation.plugin_id)
            || !version.is_match(&revocation.version)
            || validate_sha256(&revocation.revision).is_err()
            || revocation.reason.trim().is_empty()
            || revocation.reason.chars().count() > 1_000
            || !revocations.insert((
                revocation.plugin_id.as_str(),
                revocation.version.as_str(),
                revocation.revision.as_str(),
            ))
        {
            return Err(format!(
                "invalid or duplicate market revocation: {}@{}#{}",
                revocation.plugin_id, revocation.version, revocation.revision
            ));
        }
    }
    Ok(())
}

pub fn validate_market_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "invalid market URL".to_owned())?;
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err("market URLs cannot contain credentials or fragments".to_owned());
    }
    match (parsed.scheme(), parsed.host_str()) {
        ("https", Some(_)) => Ok(()),
        ("http", Some("127.0.0.1" | "localhost")) if parsed.port().is_some() => Ok(()),
        _ => Err("market URLs must use HTTPS or loopback HTTP with an explicit port".to_owned()),
    }
}

fn validate_sha256(value: &str) -> Result<(), String> {
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(())
        .ok_or_else(|| format!("invalid SHA-256 value: {value}"))
}

fn extract_zip(bytes: &[u8], destination: &Path) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
    if archive.len() > MAX_ARCHIVE_FILES {
        return Err("plugin archive exceeds file count limit".to_owned());
    }
    let mut total = 0_u64;
    let mut paths = HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let path = entry
            .enclosed_name()
            .ok_or_else(|| "plugin archive path escapes package root".to_owned())?;
        if path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err("plugin archive contains an unsafe path".to_owned());
        }
        if !paths.insert(path.to_path_buf()) {
            return Err("plugin archive contains duplicate paths".to_owned());
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("plugin archive contains a symbolic link".to_owned());
        }
        total = total.saturating_add(entry.size());
        if total > MAX_EXTRACTED_BYTES {
            return Err("plugin archive exceeds extracted size limit".to_owned());
        }
        let target = destination.join(path);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|error| error.to_string())?;
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let mut output = fs::File::create(target).map_err(|error| error.to_string())?;
            std::io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
            #[cfg(unix)]
            if let Some(mode) = entry.unix_mode() {
                use std::os::unix::fs::PermissionsExt;
                // Preserve only executable bits. Cache files remain owner-writable
                // and cannot acquire setuid/setgid or archive-controlled write ACLs.
                output
                    .set_permissions(fs::Permissions::from_mode(0o600 | (mode & 0o111)))
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn epoch_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
    use ed25519_dalek::{Signer, SigningKey};
    use std::io::Write;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use zip::{ZipWriter, write::SimpleFileOptions};

    #[tokio::test]
    async fn signed_index_downloads_a_digest_pinned_trusted_plugin() {
        let signing = SigningKey::from_bytes(&[19_u8; 32]);
        let storage = tempfile::tempdir().expect("storage");
        let installer = PluginInstaller::open(storage.path()).expect("installer");
        fs::write(
            installer.store().trust_store().root().join("market.pub"),
            BASE64.encode(signing.verifying_key().to_bytes()),
        )
        .expect("trust key");

        let manifest = serde_json::to_vec(&serde_json::json!({
            "schemaVersion":1,
            "id":"mon.market-test",
            "name":"Market Test",
            "description":"signed market package",
            "version":"1.0.0",
            "components":{"skills":[{"id":"market-skill","path":"skills/market/SKILL.md"}]}
        }))
        .expect("manifest");
        let skill = b"---\nname: market-skill\ndescription: market test\n---\n";
        let manifest_digest = hex_digest(&manifest);
        let skill_digest = hex_digest(skill);
        let checksums = serde_json::to_vec(&serde_json::json!({
            "plugin.json":manifest_digest,
            "skills/market/SKILL.md":skill_digest
        }))
        .expect("checksums");
        let mut aggregate = Sha256::new();
        aggregate.update(b"plugin.json");
        aggregate.update(manifest_digest.as_bytes());
        aggregate.update(b"skills/market/SKILL.md");
        aggregate.update(skill_digest.as_bytes());
        let integrity_digest = format!("{:x}", aggregate.finalize());
        let signature = serde_json::to_vec(&serde_json::json!({
            "keyId":"market",
            "algorithm":"ed25519",
            "signature":BASE64.encode(signing.sign(integrity_digest.as_bytes()).to_bytes())
        }))
        .expect("plugin signature");
        let mut revision = Sha256::new();
        revision.update(&manifest);
        revision.update(integrity_digest.as_bytes());
        let revision = format!("{:x}", revision.finalize());

        let cursor = Cursor::new(Vec::new());
        let mut zip = ZipWriter::new(cursor);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in [
            ("plugin.json", manifest.as_slice()),
            ("checksums.json", checksums.as_slice()),
            ("signature.json", signature.as_slice()),
            ("skills/market/SKILL.md", skill.as_slice()),
        ] {
            zip.start_file(name, options).expect("zip file");
            zip.write_all(content).expect("zip content");
        }
        let archive = zip.finish().expect("zip finish").into_inner();
        let archive_digest = hex_digest(&archive);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let package_url = format!("http://127.0.0.1:{}/plugin.zip", address.port());
        let now = epoch_millis();
        let payload = MarketIndexPayload {
            generated_at: now - 1_000,
            expires_at: now + 60_000,
            plugins: vec![MarketPlugin {
                id: "mon.market-test".to_owned(),
                name: "Market Test".to_owned(),
                description: "signed market package".to_owned(),
                versions: vec![MarketPluginVersion {
                    version: "1.0.0".to_owned(),
                    revision: revision.clone(),
                    url: package_url,
                    sha256: archive_digest,
                }],
            }],
            revocations: Vec::new(),
        };
        let payload_bytes = serde_json::to_vec(&payload).expect("payload");
        let index = serde_json::to_vec(&MarketIndexEnvelope {
            schema_version: 1,
            key_id: "market".to_owned(),
            payload,
            signature: BASE64.encode(signing.sign(&payload_bytes).to_bytes()),
        })
        .expect("index");
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = listener.accept().await.expect("accept");
                let mut request = vec![0_u8; 2048];
                let read = socket.read(&mut request).await.expect("request");
                let request = String::from_utf8_lossy(&request[..read]);
                let body = if request.starts_with("GET /index.json ") {
                    &index
                } else if request.starts_with("GET /plugin.zip ") {
                    &archive
                } else {
                    panic!("unexpected request: {request}")
                };
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .expect("headers");
                socket.write_all(body).await.expect("body");
            }
        });

        let cache = tempfile::tempdir().expect("cache");
        let client = MarketplaceClient::new(cache.path()).expect("market client");
        let verified = client
            .fetch_index(
                &format!("http://127.0.0.1:{}/index.json", address.port()),
                "market",
                installer.store().trust_store(),
            )
            .await
            .expect("verified index");
        let preview = client
            .prepare_preview(
                &installer,
                "test",
                "official",
                &verified,
                "mon.market-test",
                "1.0.0",
            )
            .await
            .expect("preview");
        assert_eq!(preview.preview.plugin.revision, revision);
        assert_eq!(preview.preview.source_type, "market");
        assert!(preview.preview.plugin.trust.verified());
        server.await.expect("server");
    }

    #[test]
    fn rejects_expired_and_untrusted_indexes() {
        let trust_root = tempfile::tempdir().expect("trust");
        let trust = PluginTrustStore::open(trust_root.path()).expect("trust store");
        let envelope = MarketIndexEnvelope {
            schema_version: 1,
            key_id: "missing".to_owned(),
            payload: MarketIndexPayload {
                generated_at: 1,
                expires_at: 2,
                plugins: Vec::new(),
                revocations: Vec::new(),
            },
            signature: BASE64.encode([0_u8; 64]),
        };
        assert!(verify_index(envelope, "missing", &trust).is_err());
    }

    #[test]
    fn remote_urls_reject_prefix_tricks_credentials_and_non_loopback_http() {
        assert!(validate_market_url("https://plugins.example/index.json").is_ok());
        assert!(validate_market_url("http://127.0.0.1:40123/index.json").is_ok());
        assert!(validate_market_url("http://localhost:40123/index.json").is_ok());
        assert!(validate_market_url("http://localhost.evil:40123/index.json").is_err());
        assert!(validate_market_url("https://user:secret@plugins.example/index.json").is_err());
        assert!(validate_market_url("https://plugins.example/index.json#old").is_err());
        assert!(validate_market_url("http://10.0.0.2:40123/index.json").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn archive_extraction_preserves_only_safe_executable_bits() {
        use std::os::unix::fs::PermissionsExt;

        let cursor = Cursor::new(Vec::new());
        let mut archive = ZipWriter::new(cursor);
        archive
            .start_file(
                "worker",
                SimpleFileOptions::default().unix_permissions(0o6755),
            )
            .expect("worker entry");
        archive.write_all(b"worker").expect("worker content");
        let bytes = archive.finish().expect("archive").into_inner();
        let destination = tempfile::tempdir().expect("destination");
        extract_zip(&bytes, destination.path()).expect("extract");
        assert_eq!(
            fs::metadata(destination.path().join("worker"))
                .expect("worker metadata")
                .permissions()
                .mode()
                & 0o7777,
            0o711
        );
    }
}
