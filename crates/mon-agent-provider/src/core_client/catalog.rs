use mon_agent_core::ModelError;
use serde_json::{Value, json};

use crate::dynamic::DynamicModelProvider;
use crate::support::id_text;

use super::CoreModelClient;
use super::model::{empty_value, ids_equal, model_option, resolve_core_model, result_array};

impl CoreModelClient {
    pub async fn catalog(
        &self,
        core_base_url: &str,
        core_token: &str,
        runtime: &DynamicModelProvider,
    ) -> Result<Value, ModelError> {
        self.catalog_for(core_base_url, core_token, runtime, None, None)
            .await
    }

    pub async fn catalog_for(
        &self,
        core_base_url: &str,
        core_token: &str,
        runtime: &DynamicModelProvider,
        session_id: Option<&str>,
        assistant_id: Option<&Value>,
    ) -> Result<Value, ModelError> {
        let assistant_path = assistant_id.map_or_else(
            || "/api/assistants/current/".to_owned(),
            |assistant_id| format!("/api/assistants/{}/", id_text(assistant_id)),
        );
        let assistant = self
            .request(
                core_base_url,
                core_token,
                reqwest::Method::GET,
                &assistant_path,
                None,
            )
            .await?;
        let character = assistant
            .get("character")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or_else(|| {
                ModelError::new(
                    "core_character_missing",
                    "current assistant has no bound character",
                )
            })?;
        let settings = self
            .request(
                core_base_url,
                core_token,
                reqwest::Method::GET,
                "/api/agent/settings/my/",
                None,
            )
            .await?;
        let vendors_value = self
            .request(
                core_base_url,
                core_token,
                reqwest::Method::GET,
                "/api/core/vendors/ai/",
                None,
            )
            .await
            .unwrap_or_else(|_| json!({"vendors":{}}));
        let vendors = vendors_value
            .get("vendors")
            .cloned()
            .unwrap_or(vendors_value);
        let entities_value = self
            .request(
                core_base_url,
                core_token,
                reqwest::Method::GET,
                "/api/ai/entities/",
                None,
            )
            .await?;
        let entities = result_array(&entities_value);
        let bound_id = character
            .get("ai_talk_entity_id")
            .filter(|value| !value.is_null());
        let settings_id = settings
            .get("default_model")
            .filter(|value| !empty_value(value));
        let preferred_id = bound_id.or(settings_id);
        let current_entity = preferred_id
            .and_then(|id| {
                entities
                    .iter()
                    .find(|entity| ids_equal(entity.get("id"), Some(id)))
            })
            .or_else(|| {
                entities.iter().find(|entity| {
                    entity.get("status").and_then(Value::as_str) == Some("active")
                        && entity.get("is_choice_default").and_then(Value::as_bool) == Some(true)
                })
            })
            .or_else(|| {
                entities.iter().find(|entity| {
                    entity.get("status").and_then(Value::as_str) == Some("active")
                        && entity.get("is_vision_default").and_then(Value::as_bool) != Some(true)
                })
            })
            .or_else(|| {
                entities
                    .iter()
                    .find(|entity| entity.get("status").and_then(Value::as_str) == Some("active"))
            });
        let current_id = current_entity.and_then(|entity| entity.get("id"));
        let options = entities
            .iter()
            .map(|entity| model_option(entity, current_id, &vendors))
            .collect::<Vec<_>>();
        let current = options
            .iter()
            .find(|option| option.get("selected").and_then(Value::as_bool) == Some(true))
            .cloned();

        if let Some(entity_id) = current_id {
            let detail = self
                .request(
                    core_base_url,
                    core_token,
                    reqwest::Method::GET,
                    &format!("/api/ai/entities/{}/", id_text(entity_id)),
                    None,
                )
                .await?;
            let label = current
                .as_ref()
                .and_then(|value| value.get("label"))
                .and_then(Value::as_str)
                .unwrap_or_else(|| {
                    detail
                        .get("ai_model")
                        .and_then(Value::as_str)
                        .unwrap_or("model")
                });
            runtime
                .configure_resolved_for(session_id, resolve_core_model(&detail, label)?)
                .await?;
        } else {
            runtime
                .clear_for(session_id, "no active Core AI configuration is available")
                .await;
        }

        let bound_vision_id = character
            .get("vision_ai_entity_id")
            .filter(|value| !empty_value(value))
            .or_else(|| {
                character
                    .get("vision_ai_entity")
                    .and_then(|value| value.get("id"))
                    .filter(|value| !empty_value(value))
            });
        let vision_entity = bound_vision_id
            .and_then(|id| {
                entities.iter().find(|entity| {
                    ids_equal(entity.get("id"), Some(id))
                        && entity.get("status").and_then(Value::as_str) == Some("active")
                        && entity.get("is_multimodal").and_then(Value::as_bool) == Some(true)
                })
            })
            .or_else(|| {
                entities.iter().find(|entity| {
                    entity.get("status").and_then(Value::as_str) == Some("active")
                        && entity.get("is_vision_default").and_then(Value::as_bool) == Some(true)
                        && entity.get("is_multimodal").and_then(Value::as_bool) == Some(true)
                })
            })
            .or_else(|| {
                entities.iter().find(|entity| {
                    entity.get("status").and_then(Value::as_str) == Some("active")
                        && entity.get("is_multimodal").and_then(Value::as_bool) == Some(true)
                })
            });
        let vision = vision_entity.map(|entity| model_option(entity, None, &vendors));
        if let Some(session_id) = session_id {
            if let Some(vision_entity_id) = vision_entity.and_then(|entity| entity.get("id")) {
                let detail = self
                    .request(
                        core_base_url,
                        core_token,
                        reqwest::Method::GET,
                        &format!("/api/ai/entities/{}/", id_text(vision_entity_id)),
                        None,
                    )
                    .await?;
                let label = vision
                    .as_ref()
                    .and_then(|value| value.get("label"))
                    .and_then(Value::as_str)
                    .unwrap_or("vision model");
                runtime
                    .configure_resolved_vision_for(session_id, resolve_core_model(&detail, label)?)
                    .await?;
            } else {
                runtime.clear_vision_for(session_id).await;
            }
        }

        Ok(json!({
            "source":"core",
            "serviceType":"ai",
            "vendors":vendors,
            "assistant":{"id":assistant.get("id"),"name":assistant.get("name").and_then(Value::as_str).unwrap_or("")},
            "character":{"id":character.get("id"),"name":character.get("name").and_then(Value::as_str).unwrap_or("")},
            "current":current,
            "vision":vision,
            "selectionSource":if bound_id.is_some() {"character"} else {"input"},
            "options":options,
        }))
    }

    pub async fn select(
        &self,
        core_base_url: &str,
        core_token: &str,
        ai_entity_id: &Value,
        runtime: &DynamicModelProvider,
    ) -> Result<Value, ModelError> {
        self.select_for(core_base_url, core_token, ai_entity_id, runtime, None, None)
            .await
    }

    pub async fn select_for(
        &self,
        core_base_url: &str,
        core_token: &str,
        ai_entity_id: &Value,
        runtime: &DynamicModelProvider,
        session_id: Option<&str>,
        assistant_id: Option<&Value>,
    ) -> Result<Value, ModelError> {
        let detail = self
            .request(
                core_base_url,
                core_token,
                reqwest::Method::GET,
                &format!("/api/ai/entities/{}/", id_text(ai_entity_id)),
                None,
            )
            .await?;
        if detail.get("status").and_then(Value::as_str) != Some("active") {
            return Err(ModelError::new(
                "core_model_inactive",
                "selected AI configuration is not active",
            ));
        }
        let assistant_path = assistant_id.map_or_else(
            || "/api/assistants/current/".to_owned(),
            |assistant_id| format!("/api/assistants/{}/", id_text(assistant_id)),
        );
        let assistant = self
            .request(
                core_base_url,
                core_token,
                reqwest::Method::GET,
                &assistant_path,
                None,
            )
            .await?;
        let character = assistant
            .get("character")
            .filter(|value| value.is_object())
            .ok_or_else(|| {
                ModelError::new(
                    "core_character_missing",
                    "current assistant has no bound character",
                )
            })?;
        let character_id = character.get("id").ok_or_else(|| {
            ModelError::new("core_character_missing", "current character has no ID")
        })?;
        if character
            .get("ai_talk_entity_id")
            .is_some_and(|value| !value.is_null())
        {
            self.request(
                core_base_url,
                core_token,
                reqwest::Method::PATCH,
                &format!("/api/characters/{}/", id_text(character_id)),
                Some(json!({"ai_talk_entity_id":ai_entity_id})),
            )
            .await?;
        } else {
            self.request(
                core_base_url,
                core_token,
                reqwest::Method::PATCH,
                "/api/agent/settings/my/",
                Some(json!({"default_model":id_text(ai_entity_id)})),
            )
            .await?;
        }
        self.catalog_for(core_base_url, core_token, runtime, session_id, assistant_id)
            .await
    }
}
