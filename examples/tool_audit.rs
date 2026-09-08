//! Opt-in smoke audit. Uses an isolated directory and Core read-only calls.
//! Never points the Store at a real user database or sends external messages.
use eden_agent_core::{Tool,ToolDefinition,ToolCall,ToolCallContext,event_channel};
use eden_agent_core::SessionId;
use eden_agent_host::HostServices;
use eden_agent_store::Store;
use eden_agent_tools::{NativeToolConfig,ProcessSandbox,create_native_tool,NATIVE_TOOL_NAMES};
use serde_json::{Value,json};
use std::{sync::Arc,path::PathBuf,time::Duration};
use tokio_util::sync::CancellationToken;

struct Audit { tools:Vec<Arc<dyn Tool>>,session:SessionId,assistant:Value,character:Value,report:Vec<Value>,count:u64 }
impl Audit {
 async fn call(&mut self,name:&str,args:Value)->Value {
    self.count+=1;
    let Some(tool)=self.tools.iter().find(|t|t.definition().name==name) else {
        self.report.push(json!({"tool":name,"status":"unregistered"}));return Value::Null;
    };
    let (events,mut receiver)=event_channel(1024);
    let drain=tokio::spawn(async move {while receiver.recv().await.is_some(){}});
    let result=tokio::time::timeout(Duration::from_secs(45),tool.execute(&ToolCall{id:format!("audit-{}",self.count),name:name.into(),arguments:args},ToolCallContext{
        session_id:Some(self.session.to_string()),metadata:json!({"operationId":format!("audit-{}",self.count),"primaryAssistantId":self.assistant,"primaryCharacterId":self.character,"agentPath":"/root"}),events,cancellation:CancellationToken::new()
    })).await;
    drain.abort();
    match result {
        Ok(Ok(output))=>{
            let value=output.details;
            let success=value.get("success").and_then(Value::as_bool)!=Some(false);
            self.report.push(json!({"tool":name,"status":if success{"passed"}else{"returned_failure"},"ready":value.get("ready")}));
            value
        },
        Ok(Err(error))=>{self.report.push(json!({"tool":name,"status":"failed","code":error.info.code,"message":error.message.chars().take(300).collect::<String>()}));Value::Null},
        Err(_)=>{self.report.push(json!({"tool":name,"status":"timeout"}));Value::Null}
    }
 }
}
#[tokio::main]
async fn main()->Result<(),Box<dyn std::error::Error>> {
 let root=PathBuf::from(std::env::var("EDEN_TOOL_AUDIT_DIR")?);
 std::fs::create_dir_all(&root)?;
 // A marker and fresh subdirectory make accidental production DB use impossible.
 let work=root.join(format!("smoke-{}",uuid::Uuid::new_v4()));
 std::fs::create_dir(&work)?;
 std::process::Command::new("git").args(["init","--quiet"]).current_dir(&work).status()?;
 let store=Store::open(work.join("audit.sqlite3")).await?;
 let participant:Value=serde_json::from_str(&std::env::var("EDEN_TOOL_AUDIT_PARTICIPANT").unwrap_or("{}".into()))?;
 let assistant=participant["assistantId"].clone();
 let character=participant["characterId"].clone();
 let session=store.create_session_with_participants("Tool smoke audit",vec![participant]).await?;
 let host=HostServices::new(store.clone(),None,None)?;
 if let (Ok(base),Ok(token))=(std::env::var("EDEN_TOOL_AUDIT_CORE_BASE"),std::env::var("EDEN_TOOL_AUDIT_CORE_TOKEN")) {
    host.bind_core_credentials(Some(&session.id.to_string()),&base,&token).await?;
 }
 let mut tools=host.tools();
 let skills=eden_agent_skills::SkillCatalog::discover(&[],work.join("skills"))?;
 tools.extend(skills.tools());
 let mut connector_config=eden_agent_connectors::ConnectorServiceConfig::default();
 connector_config.package_root=work.join("connector-packages");
 connector_config.connector_data_root=work.join("connector-data");
 let connectors=eden_agent_connectors::ConnectorService::with_config(store,connector_config)?;
 tools.extend(connectors.tools());
 let config=NativeToolConfig::new(&work).with_process_sandbox(ProcessSandbox::Direct);
 for name in NATIVE_TOOL_NAMES { if let Some(tool)=create_native_tool(ToolDefinition::direct(*name,*name),config.clone()){ tools.push(tool); } }
 let mut audit=Audit{tools,session:session.id,assistant,character,report:vec![],count:0};
 if std::env::var_os("EDEN_TOOL_AUDIT_EXTENSIONS").is_some() {
    audit.call("create_skill",json!({"name":"audit-only","description":"Isolated smoke fixture","instructions":"Return a brief test marker.","scope":"user"})).await;
    audit.call("list_skills",json!({})).await;
    audit.call("load_skill",json!({"name":"audit-only"})).await;
    let preview=audit.call("update_skill",json!({"action":"preview","name":"audit-only","instructions":"Return the updated test marker."})).await;
    let id=preview.get("previewId").or(preview.get("preview_id")).cloned().unwrap_or(Value::Null);
    audit.call("update_skill",json!({"action":"apply","previewId":id})).await;
    audit.call("list_connectors",json!({})).await;
    std::fs::write(root.join("extension-calls.json"),serde_json::to_vec_pretty(&audit.report)?)?;
    println!("{}",serde_json::to_string(&audit.report)?);
    return Ok(());
 }
 if std::env::var_os("EDEN_TOOL_AUDIT_WINDOW").is_some() {
    let shown=audit.call("show_desktop_reminder",json!({"title":"Eden Agent · 工具调用测试","message":"这次由 show_desktop_reminder 工具直接打开。\n请保留约 20 秒，再点击“知道了”或关闭按钮。"})).await;
    let id=shown["id"].clone();
    println!("Desktop tool invoked; waiting for window closure");
    let mut last=Value::Null;
    for _ in 0..24 {
        last=audit.call("get_desktop_reminder",json!({"reminderId":id})).await;
        if last["state"]=="closed" || last.is_null() {break;}
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    std::fs::write(root.join("window-calls.json"),serde_json::to_vec_pretty(&json!({"calls":audit.report,"finalState":last["state"]}))?)?;
    println!("Desktop test final state: {}",last["state"]);
    return Ok(());
 }

 audit.call("write",json!({"path":"audit.txt","content":"alpha\nbeta\n"})).await;
 audit.call("read",json!({"path":"audit.txt"})).await;
 audit.call("edit",json!({"path":"audit.txt","oldText":"alpha","newText":"gamma"})).await;
 audit.call("apply_patch",json!({"patch":"*** Begin Patch\n*** Add File: patched.txt\n+tool-audit\n*** End Patch"})).await;
 audit.call("ls",json!({"path":"."})).await;
 audit.call("find",json!({"path":".","pattern":"*.txt"})).await;
 audit.call("grep",json!({"path":".","pattern":"gamma","glob":"*.txt"})).await;
 audit.call("get_diff",json!({})).await;
 audit.call("bash",json!({"command":"printf 'eden-tool-audit-ok'","yield_time_ms":1000})).await;
 let shell=audit.call("bash",json!({"command":"sleep 2; printf 'background-ok'","yield_time_ms":1})).await;
 if let Some(id)=shell.get("session_id").or(shell.get("sessionId")) {
    audit.call("write_stdin",json!({"session_id":id,"chars":"","yield_time_ms":3000})).await;
 }
 let memo=audit.call("create_memo",json!({"title":"test note","content":"isolated"})).await;
 let id=memo["id"].clone();
 audit.call("list_memos",json!({})).await;
 audit.call("complete_memo",json!({"id":id})).await;
 audit.call("archive_memo",json!({"id":id})).await;
 let memo=audit.call("create_reminder",json!({"title":"test reminder","remindAt":chrono::Utc::now().timestamp_millis()-1000})).await;
 let id=memo["id"].clone();
 audit.call("list_due_memos",json!({})).await;
 audit.call("snooze_memo",json!({"id":id,"minutes":5})).await;
 audit.call("mark_memo_triggered",json!({"id":id})).await;
 audit.call("dispatch_due_memos",json!({})).await;
 audit.call("get_next_memo_wake",json!({})).await;
 let memory=audit.call("remember_memory",json!({"content":"tool audit temporary fact","kind":"fact"})).await;
 let id=memory["id"].clone();
 audit.call("search_memories",json!({"query":"temporary"})).await;
 audit.call("update_memory",json!({"id":id,"content":"updated audit fact"})).await;
 audit.call("forget_memory",json!({"id":id})).await;
 audit.call("get_calendar_context",json!({})).await;
 audit.call("get_self_awake_state",json!({})).await;
 audit.call("set_self_awake_timer",json!({"afterMinutes":5,"reason":"isolated tool audit"})).await;
 for name in ["list_assistants","list_self_awake_diaries","external_email_status","qq_bot_list","qq_bot_targets","read_qq_messages","list_character_actions","list_character_stickers"] {
    audit.call(name,json!({})).await;
 }
 audit.call("get_weather",json!({"latitude":39.9,"longitude":116.4,"days":1})).await;
 audit.call("web",json!({"action":"open","url":"https://example.com","max_chars":2000})).await;
 std::fs::write(root.join("actual-calls.json"),serde_json::to_vec_pretty(&audit.report)?)?;
 println!("{}",serde_json::to_string(&audit.report)?);
 Ok(())
}
