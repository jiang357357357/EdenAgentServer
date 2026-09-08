use async_trait::async_trait;
use eden_agent_core::{Tool,ToolCall,ToolCallContext,ToolDefinition,ToolExecutionMode,ToolFailure,ToolOutput,PermissionRequest};
use eden_agent_domain::SessionId;
use eden_agent_store::Store;
use serde_json::{Value,json};

pub(crate) struct DesktopReminderTool { pub store: Store, pub read: bool }

#[async_trait]
impl Tool for DesktopReminderTool {
    fn definition(&self)->ToolDefinition {
        let mut d=ToolDefinition::direct(
            if self.read {"get_desktop_reminder"} else {"show_desktop_reminder"},
            if self.read {"查询当前会话的提醒窗口状态。关闭不代表已阅读。"} else {"立即打开独立桌面提醒窗口，用户关闭前不自动消失。返回提醒 ID，不等待关闭。每轮最多打开一个窗口，重复调用返回原记录。无需 Core、QQ 或邮件凭据。"});
        d.parameters=if self.read {
            json!({"type":"object","properties":{"reminderId":{"type":"string"}},"required":["reminderId"],"additionalProperties":false})
        } else {
            d.execution_mode=ToolExecutionMode::Sequential;
            json!({"type":"object","properties":{"title":{"type":"string","minLength":1,"maxLength":200},"message":{"type":"string","minLength":1,"maxLength":12000}},"required":["title","message"],"additionalProperties":false})
        };
        d
    }

    fn permission_request(&self,_:&Value)->Option<PermissionRequest> {
        (!self.read).then(||PermissionRequest{permission:"mon.write".into(),patterns:vec!["desktop.reminder".into()],always:vec![]})
    }

    async fn execute(&self,call:&ToolCall,context:ToolCallContext)->Result<ToolOutput,ToolFailure> {
        let session:SessionId=context.session_id.as_deref().and_then(|s|s.parse().ok())
            .ok_or_else(||ToolFailure::new("missing_session","desktop reminder requires a session"))?;
        let text=|key:&str,max:usize|->Result<&str,ToolFailure>{
            call.arguments[key].as_str().filter(|s|!s.trim().is_empty() && s.chars().count()<=max)
                .ok_or_else(||ToolFailure::new("invalid_argument",format!("invalid {key}")))
        };
        if self.read {
            let value=self.store.get_desktop_reminder(session,text("reminderId",100)?).await.map_err(failure)?
                .ok_or_else(||ToolFailure::new("not_found","reminder not found in this session"))?;
            return Ok(crate::output(value));
        }
        if context.cancellation.is_cancelled() {return Err(ToolFailure::new("cancelled","cancelled before opening window"));}
        let operation=context.metadata["operationId"].as_str().filter(|s|!s.is_empty())
            .ok_or_else(||ToolFailure::new("missing_operation","desktop reminder requires an operation"))?;
        let (record,created)=self.store.reserve_desktop_reminder(session,operation,text("title",200)?,text("message",12000)?).await.map_err(failure)?;
        let id=record["id"].as_str().unwrap();
        if created {
            let payload=json!({"reminderId":id,"title":record["title"],"message":record["message"]});
            if let Err(error)=crate::contact_delivery::desktop_popup(&payload,Some(self.store.clone())).await {
                self.store.record_desktop_reminder_state(id,"failed").await.map_err(failure)?;
                return Err(ToolFailure::new("desktop_window_failed",error));
            }
        } else if record["state"]=="failed" {
            return Err(ToolFailure::new("desktop_window_failed","this turn's window failed; no duplicate retry"));
        }
        Ok(crate::output(self.store.get_desktop_reminder(session,id).await.map_err(failure)?.unwrap()))
    }
}
fn failure(error:impl std::fmt::Display)->ToolFailure { ToolFailure::new("desktop_reminder_store",error.to_string()) }

#[cfg(test)]
mod tests {
    use super::*;
    use eden_agent_core::event_channel;
    use tokio_util::sync::CancellationToken;
    fn context(session:SessionId)->ToolCallContext {
        let (events,_)=event_channel(16);
        ToolCallContext{session_id:Some(session.to_string()),metadata:json!({"operationId":"turn-1"}),events,cancellation:CancellationToken::new()}
    }
    #[tokio::test]
    async fn registered_tool_deduplicates_and_status_is_session_scoped_without_core() {
        let store=Store::in_memory().await.unwrap();
        let session=store.create_session("one").await.unwrap();
        let other=store.create_session("two").await.unwrap();
        let host=crate::HostServices::new(store.clone(),None,None).unwrap();
        let tools=host.tools();
        let show=tools.iter().find(|t|t.definition().name=="show_desktop_reminder").unwrap();
        let get=tools.iter().find(|t|t.definition().name=="get_desktop_reminder").unwrap();
        assert!(show.permission_request(&json!({})).is_some());
        assert!(get.permission_request(&json!({})).is_none());
        let (record,created)=store.reserve_desktop_reminder(session.id,"turn-1","first","original").await.unwrap();
        assert!(created);
        let id=record["id"].as_str().unwrap();
        store.record_desktop_reminder_state(id,"closed").await.unwrap();
        let result=show.execute(&ToolCall{id:"show".into(),name:"show_desktop_reminder".into(),arguments:json!({"title":"different","message":"do not reopen"})},context(session.id)).await.unwrap();
        assert_eq!(result.details["id"],id);
        assert_eq!(result.details["state"],"closed");
        assert_eq!(result.details["message"],"original");
        let call=ToolCall{id:"status".into(),name:"get_desktop_reminder".into(),arguments:json!({"reminderId":id})};
        assert_eq!(get.execute(&call,context(session.id)).await.unwrap().details["state"],"closed");
        assert_eq!(get.execute(&call,context(other.id)).await.unwrap_err().info.code,"not_found");
        let malformed=ToolCall{id:"bad".into(),name:"show_desktop_reminder".into(),arguments:json!({"title":"test","message":""})};
        assert_eq!(show.execute(&malformed,context(session.id)).await.unwrap_err().info.code,"invalid_argument");
    }
}
