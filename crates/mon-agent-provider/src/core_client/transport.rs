use mon_agent_core::ModelError;
use reqwest::StatusCode;
use serde_json::{Value, json};

use super::CoreModelClient;

impl CoreModelClient {
    pub(super) async fn request(
        &self,
        core_base_url: &str,
        core_token: &str,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, ModelError> {
        if core_token.trim().is_empty() {
            return Err(ModelError::new(
                "core_authentication",
                "Core token is missing",
            ));
        }
        let normalized_base = format!("{}/", core_base_url.trim().trim_end_matches('/'));
        let base = reqwest::Url::parse(&normalized_base)
            .map_err(|error| ModelError::new("core_url", error.to_string()))?;
        if !matches!(base.scheme(), "http" | "https") {
            return Err(ModelError::new("core_url", "Core URL must use HTTP(S)"));
        }
        let url = base
            .join(path.trim_start_matches('/'))
            .map_err(|error| ModelError::new("core_url", error.to_string()))?;
        let mut request = self.client.request(method, url).header(
            reqwest::header::AUTHORIZATION,
            format!("Token {}", core_token.trim()),
        );
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| ModelError::new("core_unavailable", error.to_string()))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| ModelError::new("core_response", error.to_string()))?;
        let value = serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| {
            json!({"detail":String::from_utf8_lossy(&bytes).chars().take(500).collect::<String>()})
        });
        if !status.is_success() {
            let message = value
                .get("detail")
                .or_else(|| value.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("MonCore request failed");
            return Err(ModelError::new(
                if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
                    "core_authentication"
                } else {
                    "core_request"
                },
                format!("{status}: {message}"),
            ));
        }
        Ok(value)
    }
}
