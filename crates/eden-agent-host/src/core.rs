use eden_agent_core::ToolFailure;
use reqwest::{Client, Method, Url};
use serde_json::Value;
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct CoreClient {
    pub(crate) client: Client,
    pub(crate) base: Url,
    pub(crate) token: Arc<str>,
}

impl CoreClient {
    pub(crate) fn new(client: Client, base: &str, token: &str) -> Result<Self, String> {
        let base = Url::parse(base).map_err(|error| error.to_string())?;
        if !matches!(base.scheme(), "http" | "https") {
            return Err("Mon Core URL must use HTTP(S)".to_owned());
        }
        Ok(Self {
            client,
            base,
            token: Arc::from(token),
        })
    }

    pub(crate) async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, ToolFailure> {
        let url = self.api_url(path)?;
        self.request_url(method, url, body).await
    }

    pub(crate) async fn request_url(
        &self,
        method: Method,
        url: Url,
        body: Option<Value>,
    ) -> Result<Value, ToolFailure> {
        let mut request = self
            .client
            .request(method, url)
            .header(reqwest::header::AUTHORIZATION, self.authorization());
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| ToolFailure::new("core_unavailable", error.to_string()))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| ToolFailure::new("core_read_failed", error.to_string()))?;
        if !status.is_success() {
            return Err(ToolFailure::new(
                "core_request_failed",
                format!(
                    "Mon Core returned {status}: {}",
                    String::from_utf8_lossy(&bytes)
                ),
            ));
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| ToolFailure::new("core_invalid_json", error.to_string()))
    }

    pub(crate) fn authorization(&self) -> String {
        if self.token.starts_with("Token ") || self.token.starts_with("Bearer ") {
            self.token.to_string()
        } else {
            format!("Token {}", self.token)
        }
    }

    pub(crate) fn api_url(&self, path: &str) -> Result<Url, ToolFailure> {
        if !path.starts_with("/api/") || path.contains("..") {
            return Err(ToolFailure::new(
                "invalid_core_path",
                "Mon Core path must be an absolute /api/ path",
            ));
        }
        self.base
            .join(path.trim_start_matches('/'))
            .map_err(|error| ToolFailure::new("invalid_core_url", error.to_string()))
    }

    pub(crate) fn realtime_stt_url(&self) -> Result<Url, String> {
        let mut url = self
            .base
            .join("ws/stt/realtime/")
            .map_err(|error| error.to_string())?;
        url.set_scheme(if self.base.scheme() == "https" {
            "wss"
        } else {
            "ws"
        })
        .map_err(|()| "unable to construct Mon Core realtime STT URL".to_owned())?;
        let token = self
            .token
            .strip_prefix("Token ")
            .or_else(|| self.token.strip_prefix("Bearer "))
            .unwrap_or(self.token.as_ref());
        url.query_pairs_mut().append_pair("token", token);
        Ok(url)
    }

    pub(crate) async fn fetch_audio(&self, source: &str) -> Result<(String, Vec<u8>), String> {
        let url = self.base.join(source).map_err(|error| error.to_string())?;
        if url.scheme() != self.base.scheme()
            || url.host_str() != self.base.host_str()
            || url.port_or_known_default() != self.base.port_or_known_default()
            || !url.path().starts_with("/media/")
        {
            return Err(
                "Mon Core audio URL is outside the configured Core media origin".to_owned(),
            );
        }
        let response = self
            .client
            .get(url)
            .header(reqwest::header::AUTHORIZATION, self.authorization())
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("Mon Core audio request returned {status}"));
        }
        let mime = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("application/octet-stream")
            .split(';')
            .next()
            .unwrap_or("application/octet-stream")
            .trim()
            .to_owned();
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        Ok((mime, bytes.to_vec()))
    }
}
