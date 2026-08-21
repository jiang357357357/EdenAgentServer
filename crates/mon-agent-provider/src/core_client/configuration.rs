use mon_agent_core::ModelError;
use serde_json::{Value, json};

use crate::dynamic::DynamicModelProvider;
use crate::support::id_text;

use super::CoreModelClient;
use super::model::{empty_value, ids_equal, resolve_core_model, result_array};

impl CoreModelClient {
    pub async fn configure_entity_for_session(
        &self,
        core_base_url: &str,
        core_token: &str,
        ai_entity_id: &Value,
        session_id: &str,
        runtime: &DynamicModelProvider,
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
        let label = detail
            .get("ai_name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| detail.get("ai_model").and_then(Value::as_str))
            .unwrap_or("model");
        runtime
            .configure_resolved_for(Some(session_id), resolve_core_model(&detail, label)?)
            .await
    }

    pub async fn configure_vision_entity_for_session(
        &self,
        core_base_url: &str,
        core_token: &str,
        ai_entity_id: &Value,
        session_id: &str,
        runtime: &DynamicModelProvider,
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
        let label = detail
            .get("ai_name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| detail.get("ai_model").and_then(Value::as_str))
            .unwrap_or("vision model");
        runtime
            .configure_resolved_vision_for(session_id, resolve_core_model(&detail, label)?)
            .await
    }

    pub async fn configure_entity_for_actor_session(
        &self,
        core_base_url: &str,
        core_token: &str,
        ai_entity_id: &Value,
        session_id: &str,
        assistant_id: &str,
        runtime: &DynamicModelProvider,
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
        let label = detail
            .get("ai_name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| detail.get("ai_model").and_then(Value::as_str))
            .unwrap_or("model");
        runtime
            .configure_resolved_for_actor(
                session_id,
                assistant_id,
                resolve_core_model(&detail, label)?,
            )
            .await
    }

    pub async fn configure_vision_entity_for_actor_session(
        &self,
        core_base_url: &str,
        core_token: &str,
        ai_entity_id: &Value,
        session_id: &str,
        assistant_id: &str,
        runtime: &DynamicModelProvider,
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
        let label = detail
            .get("ai_name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| detail.get("ai_model").and_then(Value::as_str))
            .unwrap_or("vision model");
        runtime
            .configure_resolved_vision_for_actor(
                session_id,
                assistant_id,
                resolve_core_model(&detail, label)?,
            )
            .await
    }

    pub async fn configure_assistant_for_session(
        &self,
        core_base_url: &str,
        core_token: &str,
        assistant_id: &Value,
        session_id: &str,
        runtime: &DynamicModelProvider,
    ) -> Result<Value, ModelError> {
        let assistant = self
            .request(
                core_base_url,
                core_token,
                reqwest::Method::GET,
                &format!("/api/assistants/{}/", id_text(assistant_id)),
                None,
            )
            .await?;
        let character = assistant
            .get("character")
            .filter(|value| value.is_object())
            .ok_or_else(|| {
                ModelError::new("core_character_missing", "assistant has no bound character")
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
        let preferred = character
            .get("ai_talk_entity_id")
            .filter(|value| !empty_value(value))
            .or_else(|| {
                settings
                    .get("default_model")
                    .filter(|value| !empty_value(value))
            });
        let main = preferred
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
            .ok_or_else(|| {
                ModelError::new("core_model_missing", "assistant has no active model")
            })?;
        let main_id = main
            .get("id")
            .ok_or_else(|| ModelError::new("core_model_invalid", "AI entity has no ID"))?;
        let main_detail = self
            .request(
                core_base_url,
                core_token,
                reqwest::Method::GET,
                &format!("/api/ai/entities/{}/", id_text(main_id)),
                None,
            )
            .await?;
        let main_label = main_detail
            .get("ai_name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| main_detail.get("ai_model").and_then(Value::as_str))
            .unwrap_or("model");
        let main_info = runtime
            .configure_resolved_for_actor(
                session_id,
                &id_text(assistant_id),
                resolve_core_model(&main_detail, main_label)?,
            )
            .await?;

        let bound_vision = character
            .get("vision_ai_entity_id")
            .filter(|value| !empty_value(value))
            .or_else(|| {
                character
                    .get("vision_ai_entity")
                    .and_then(|value| value.get("id"))
                    .filter(|value| !empty_value(value))
            });
        let vision = bound_vision
            .and_then(|id| {
                entities
                    .iter()
                    .find(|entity| ids_equal(entity.get("id"), Some(id)))
            })
            .filter(|entity| {
                entity.get("status").and_then(Value::as_str) == Some("active")
                    && entity.get("is_multimodal").and_then(Value::as_bool) == Some(true)
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
        let vision_info = if let Some(vision_id) = vision.and_then(|entity| entity.get("id")) {
            let detail = self
                .request(
                    core_base_url,
                    core_token,
                    reqwest::Method::GET,
                    &format!("/api/ai/entities/{}/", id_text(vision_id)),
                    None,
                )
                .await?;
            let label = detail
                .get("ai_name")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .or_else(|| detail.get("ai_model").and_then(Value::as_str))
                .unwrap_or("vision model");
            Some(
                runtime
                    .configure_resolved_vision_for_actor(
                        session_id,
                        &id_text(assistant_id),
                        resolve_core_model(&detail, label)?,
                    )
                    .await?,
            )
        } else {
            None
        };
        Ok(json!({
            "assistantId":assistant_id,
            "characterId":character.get("id"),
            "main":main_info,
            "vision":vision_info,
        }))
    }
}
