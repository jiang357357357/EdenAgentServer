//! Execute the channels explicitly selected by a self-awake decision.
use crate::{CoreClient, core_tools};
use async_trait::async_trait;
use serde_json::{Value, json};
use std::time::Duration;

fn delivery_plan(payload: &Value) -> Result<Vec<String>, Value> {
    let channel = payload.get("channel").and_then(Value::as_str).unwrap_or("auto");
    // Legacy intents retain their old fallback behaviour. New decisions select
    // an explicit channel and may explicitly name alternatives.
    if channel == "auto" { return Ok(vec!["qq".into(), "email".into(), "desktop".into()]); }
    let mut plan = vec![channel.to_owned()];
    if let Some(fallbacks) = payload.get("fallbackChannels") {
        let values = fallbacks.as_array().ok_or_else(|| json!({"error":"fallbackChannels must be an array"}))?;
        for value in values {
            let name = value.as_str().ok_or_else(|| json!({"error":"invalid fallback channel"}))?;
            if !plan.iter().any(|channel| channel == name) { plan.push(name.to_owned()); }
        }
    }
    if plan.iter().any(|channel| !matches!(channel.as_str(), "qq" | "email" | "desktop")) {
        return Err(json!({"error":"choose qq, email or desktop"}));
    }
    Ok(plan)
}

#[async_trait]
trait Sender: Send + Sync {
    async fn send(&self, channel: &str, payload: &Value) -> Result<Value, String>;
}

async fn deliver_using(sender: &dyn Sender, payload: &Value) -> Result<Value, Value> {
    let plan = delivery_plan(payload)?;
    let mut attempts = Vec::new();
    for channel in &plan {
        match sender.send(channel, payload).await {
            Ok(receipt) => {
                attempts.push(json!({"channel":channel,"success":true,"receipt":receipt}));
                return Ok(json!({"success":true,"selectedChannels":plan,"deliveredChannel":channel,"attempts":attempts,
                    "note":"Accepted by the selected channel; this does not prove the user has read it."}));
            }
            Err(error) => attempts.push(json!({"channel":channel,"success":false,"error":error})),
        }
    }
    Err(json!({"success":false,"selectedChannels":plan,"attempts":attempts,"error":"selected contact channels failed"}))
}

struct ConfiguredSender(CoreClient, Option<eden_agent_store::Store>);
#[async_trait]
impl Sender for ConfiguredSender {
    async fn send(&self, channel: &str, payload: &Value) -> Result<Value, String> {
        if channel == "desktop" { return desktop_popup(payload, self.1.clone()).await; }
        let result = core_tools::contact_user(&self.0, &json!({
            "channel":channel,"title":payload["title"],"message":payload["message"],
            "metadata":{"author":payload["author"]},"privateOnly":true,"sourceType":"self_awake","sourceId":payload["runId"],
            "requestId":format!("self-awake:{}",payload["runId"].as_str().unwrap_or("unknown"))
        })).await.map_err(|error| error.to_string())?;
        let receipt=&result["attempts"][0]["result"];
        if [receipt.get("success"),receipt.get("sent"),receipt.pointer("/data/success")].into_iter().flatten().any(|value|value.as_bool()==Some(false)) {
            return Err("channel returned an unsuccessful delivery receipt".into());
        }
        Ok(json!({"accepted":result["success"],"channels":result["deliveredChannels"]}))
    }
}

pub async fn deliver_user_contact(base: &str, token: &str, payload: &Value) -> Result<Value, Value> {
    deliver_user_contact_tracked(base, token, payload, None).await
}

pub async fn deliver_user_contact_tracked(base: &str, token: &str, payload: &Value, store: Option<eden_agent_store::Store>) -> Result<Value, Value> {
    if payload["message"].as_str().is_none_or(|text| text.trim().is_empty()) {
        return Err(json!({"error":"contact message is empty"}));
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build()
        .map_err(|error| json!({"error":error.to_string()}))?;
    let core = CoreClient::new(client, base, token).map_err(|error| json!({"error":error}))?;
    deliver_using(&ConfiguredSender(core, store), payload).await
}

pub(crate) async fn desktop_popup(payload: &Value, store: Option<eden_agent_store::Store>) -> Result<Value, String> {
    use std::process::Stdio;
    let title = payload["title"].as_str().unwrap_or("Eden Agent 提醒");
    let message = payload["message"].as_str().unwrap_or("");
    let run_id = payload["runId"].as_str().and_then(|id| uuid::Uuid::parse_str(id).ok());
    let reminder_id=payload["reminderId"].as_str().map(str::to_owned);
    let mut command;
    #[cfg(target_os = "linux")]
    {
        // Native modal windows have no expiry. Escape rich text in KDialog;
        // message content is always an argument, never shell source.
        let has_kdialog = std::env::var_os("PATH").is_some_and(|path|
            std::env::split_paths(&path).any(|dir| dir.join("kdialog").is_file()));
        if has_kdialog {
            command = tokio::process::Command::new("kdialog");
            let plain = message.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('\n', "<br/>");
            command.args(["--title", title, "--ok-label", "知道了", "--msgbox", &format!("<html>{plain}</html>")]);
        } else {
            command = tokio::process::Command::new("zenity");
            command.args(["--info", "--no-markup", "--title", title, "--text", message, "--ok-label", "知道了", "--width", "480"]);
        }
        if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
            if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
                if let Some(uid) = status.lines().find_map(|line| line.strip_prefix("Uid:").and_then(|v| v.split_whitespace().next())) {
                    let bus = format!("/run/user/{uid}/bus");
                    if std::path::Path::new(&bus).exists() { command.env("DBUS_SESSION_BUS_ADDRESS",format!("unix:path={bus}")); }
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        command = tokio::process::Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", "$w=New-Object -ComObject WScript.Shell; $null=$w.Popup($env:EDEN_CONTACT_BODY,0,$env:EDEN_CONTACT_TITLE,64)"])
            .env("EDEN_CONTACT_TITLE",title).env("EDEN_CONTACT_BODY",message);
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    { let _ = (title, message, store, run_id); return Err("desktop window is unavailable on this platform".into()); }
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error|format!("desktop window unavailable: {error}"))?;
    // Detect immediate launch errors, then release the delivery worker. An
    // unclosed window must not hold a queue lease or trigger duplicate delivery.
    tokio::time::sleep(Duration::from_millis(250)).await;
    if let Some(status) = child.try_wait().map_err(|e|e.to_string())? {
        if !status.success() {
            let output=child.wait_with_output().await.map_err(|e|e.to_string())?;
            return Err(format!("desktop window failed: {}",String::from_utf8_lossy(&output.stderr).chars().take(300).collect::<String>()));
        }
        if let (Some(store),Some(id)) = (&store,&reminder_id) { store.record_desktop_reminder_state(id,"closed").await.map_err(|e|e.to_string())?; }
        if let (Some(store),Some(id)) = (&store,run_id) {
            store.record_self_awake_desktop_state(id,"closed").await.map_err(|e|e.to_string())?;
        }
    } else {
        if let (Some(store),Some(id)) = (&store,&reminder_id) { store.record_desktop_reminder_state(id,"open").await.map_err(|e|e.to_string())?; }
        if let (Some(store),Some(id)) = (&store,run_id) {
            store.record_self_awake_desktop_state(id,"open").await.map_err(|e|e.to_string())?;
        }
        tokio::spawn(async move {
            let state = match child.wait_with_output().await {
                Ok(output) if output.status.success() || output.status.code()==Some(1) => "closed",
                _ => "failed",
            };
            if let (Some(store),Some(id)) = (&store,&reminder_id) { let _=store.record_desktop_reminder_state(id,state).await; }
            if let (Some(store),Some(id)) = (store,run_id) {
                let _ = store.record_self_awake_desktop_state(id,state).await;
            }
        });
    }
    Ok(json!({"accepted":true,"source":"desktop_window","requiresDismissal":true,"userRead":null}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    struct FakeSender { succeed: &'static str, calls: Mutex<Vec<String>> }
    #[async_trait]
    impl Sender for FakeSender {
        async fn send(&self, channel: &str, _: &Value) -> Result<Value,String> {
            self.calls.lock().unwrap().push(channel.into());
            if channel==self.succeed { Ok(json!({"accepted":true})) } else { Err("unavailable".into()) }
        }
    }
    #[tokio::test]
    async fn respects_model_order_and_stops_after_success() {
        let sender=FakeSender{succeed:"desktop",calls:Mutex::new(vec![])};
        let result=deliver_using(&sender,&json!({"channel":"email","fallbackChannels":["desktop","qq"]})).await.unwrap();
        assert_eq!(*sender.calls.lock().unwrap(),vec!["email","desktop"]);
        assert_eq!(result["deliveredChannel"],"desktop");
        assert_eq!(result["attempts"][0]["success"],false);
    }
    #[tokio::test]
    async fn explicit_channel_failure_does_not_invent_fallbacks() {
        let sender=FakeSender{succeed:"email",calls:Mutex::new(vec![])};
        assert!(deliver_using(&sender,&json!({"channel":"qq"})).await.is_err());
        assert_eq!(*sender.calls.lock().unwrap(),vec!["qq"]);
    }
    #[tokio::test]
    #[ignore = "opens a real desktop reminder; run only for an explicitly requested UI test"]
    async fn manual_persistent_desktop_window() {
        let path=std::env::var("EDEN_WINDOW_TEST_DB").expect("explicit test database required");
        let store=eden_agent_store::Store::open(&path).await.unwrap();
        let session=store.create_session("桌面窗口测试").await.unwrap();
        let job=store.schedule_job("self_awake",Some(session.id),0,json!({}),&uuid::Uuid::new_v4().to_string()).await.unwrap();
        let run=store.start_self_awake_run(&job,"self-awake.v1","desktop test",json!({}),json!({})).await.unwrap();
        let payload=json!({"runId":run.id,"channel":"desktop","title":"Eden Agent · 持续提醒窗口测试","message":"老师，这是独立提醒窗口测试。\n它不会自动消失，请点击“知道了”或窗口关闭按钮结束。"});
        store.complete_self_awake_run(&run,json!({}),None,Some(payload.clone()),None).await.unwrap();
        let started=std::time::Instant::now();
        let receipt=deliver_user_contact_tracked("http://127.0.0.1:1","test",&payload,Some(store.clone())).await.unwrap();
        assert!(started.elapsed()<Duration::from_secs(5),"delivery worker blocked by open window");
        store.update_self_awake_notification(run.id,"delivered",Some(receipt),None).await.unwrap();
        println!("Window launched; waiting for explicit dismissal. Run {}",run.id);
        for _ in 0..180 {
            let result=store.get_self_awake_notification(run.id).await.unwrap().unwrap();
            if result["result"]["desktopWindow"]["state"]=="closed" {
                println!("User dismissal recorded; channel remains delivered.");
                return;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        panic!("window remains open; user dismissal was not confirmed within test interval");
    }

    #[test]
    fn rejects_unknown_channels_before_sending() {
        assert!(delivery_plan(&json!({"channel":"shell"})).is_err());
        assert!(delivery_plan(&json!({"channel":"qq","fallbackChannels":["group"]})).is_err());
    }
}
