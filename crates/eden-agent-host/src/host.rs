use crate::{
    core::CoreClient,
    core_tools, tools,
    web::{WebRuntime, WebTool},
};
use eden_agent_blob::BlobService;
use eden_agent_core::Tool;
use eden_agent_store::Store;
use reqwest::{Client, Method};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration as StdDuration};
use tokio::sync::RwLock;

#[derive(Clone)]
pub struct HostServices {
    pub(crate) store: Store,
    pub(crate) web: Client,
    pub(crate) web_runtime: Arc<WebRuntime>,
    core: Arc<RwLock<CoreBindings>>,
    pub(crate) blobs: Option<BlobService>,
}

#[derive(Default)]
struct CoreBindings {
    default: Option<CoreClient>,
    sessions: HashMap<String, CoreClient>,
}

impl HostServices {
    pub fn new(
        store: Store,
        core_base_url: Option<&str>,
        core_token: Option<&str>,
    ) -> Result<Self, String> {
        let web = Client::builder()
            .timeout(StdDuration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("Eden Agent/1.8")
            .build()
            .map_err(|error| error.to_string())?;
        let default = match (core_base_url, core_token) {
            (Some(base), Some(token)) if !base.trim().is_empty() && !token.trim().is_empty() => {
                Some(CoreClient::new(web.clone(), base, token)?)
            }
            _ => None,
        };
        Ok(Self {
            store,
            web,
            web_runtime: Arc::new(WebRuntime::new()),
            core: Arc::new(RwLock::new(CoreBindings {
                default,
                sessions: HashMap::new(),
            })),
            blobs: None,
        })
    }

    /// Install a short-lived Core credential after the desktop/web client has
    /// authenticated. Credentials remain in memory and session bindings take
    /// precedence over the process default.
    pub async fn bind_core_credentials(
        &self,
        session_id: Option<&str>,
        core_base_url: &str,
        core_token: &str,
    ) -> Result<(), String> {
        let client = CoreClient::new(self.web.clone(), core_base_url, core_token)?;
        let mut bindings = self.core.write().await;
        if let Some(session_id) = session_id.map(str::trim).filter(|value| !value.is_empty()) {
            bindings.sessions.insert(session_id.to_owned(), client);
        } else {
            bindings.default = Some(client);
        }
        Ok(())
    }

    pub async fn unbind_session_core_credentials(&self, session_id: &str) {
        self.core.write().await.sessions.remove(session_id);
    }

    pub async fn synthesize_speech(&self, session_id: &str, body: Value) -> Result<Value, String> {
        let client = self
            .core_client(Some(session_id))
            .await
            .ok_or_else(|| "Mon Core credentials are unavailable for this session".to_owned())?;
        client
            .request(Method::POST, "/api/tts/configs/synthesize/", Some(body))
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn list_speech_segments(
        &self,
        session_id: &str,
        message_id: Option<&str>,
    ) -> Result<Value, String> {
        let client = self
            .core_client(Some(session_id))
            .await
            .ok_or_else(|| "Mon Core credentials are unavailable for this session".to_owned())?;
        let mut url = client
            .api_url("/api/tts/configs/message-segments/")
            .map_err(|error| error.to_string())?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("external_session_id", session_id);
            if let Some(message_id) = message_id.filter(|value| !value.trim().is_empty()) {
                query.append_pair("external_message_id", message_id);
            }
        }
        client
            .request_url(Method::GET, url, None)
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn realtime_stt_url(&self, session_id: &str) -> Result<String, String> {
        let client = self
            .core_client(Some(session_id))
            .await
            .ok_or_else(|| "Mon Core credentials are unavailable for this session".to_owned())?;
        client.realtime_stt_url().map(|url| url.to_string())
    }

    pub async fn fetch_core_audio(
        &self,
        session_id: &str,
        source: &str,
    ) -> Result<(String, Vec<u8>), String> {
        let client = self
            .core_client(Some(session_id))
            .await
            .ok_or_else(|| "Mon Core credentials are unavailable for this session".to_owned())?;
        client.fetch_audio(source).await
    }

    pub(crate) async fn core_client(&self, session_id: Option<&str>) -> Option<CoreClient> {
        let bindings = self.core.read().await;
        session_id
            .and_then(|session_id| bindings.sessions.get(session_id))
            .or(bindings.default.as_ref())
            .cloned()
    }

    #[must_use]
    pub fn with_blob_service(mut self, blobs: BlobService) -> Self {
        self.blobs = Some(blobs);
        self
    }

    pub fn tools(&self) -> Vec<Arc<dyn Tool>> {
        let mut registered = tools::tools(self.clone());
        registered.push(Arc::new(WebTool(self.clone())));
        registered.extend(core_tools::tools(self.clone()));
        registered
    }
}
