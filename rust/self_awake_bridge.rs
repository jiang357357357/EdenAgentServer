use super::*;
use hmac::{Hmac, Mac};
use std::sync::{Mutex, OnceLock};

const RUN_PATH: &str = "/internal/self-awake/run";
const STATUS_PATH: &str = "/internal/self-awake/status";

fn identity() -> Result<(String, String)> {
    let secret = std::env::var("MON_SERVICE_SHARED_SECRET").unwrap_or_default();
    let user = std::env::var("MON_SERVICE_USER_ID").unwrap_or_default();
    anyhow::ensure!(!secret.is_empty() && !user.is_empty(), "self-awake service identity is not configured");
    Ok((secret, user))
}

fn signature(secret: &str, parts: &[&str]) -> Result<Vec<u8>> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())?;
    mac.update(parts.join("\n").as_bytes());
    Ok(mac.finalize().into_bytes().to_vec())
}

fn authorize(headers: &HeaderMap, body: &[u8], path: &str, secret: &str) -> Result<()> {
    let header = |name| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("");
    anyhow::ensure!(header("x-mon-service-id") == "monos" && header("x-mon-service-scope") == "self_awake:submit", "invalid service scope");
    let ts = header("x-mon-service-timestamp");
    let timestamp: i64 = ts.parse()?;
    let now = chrono::Utc::now().timestamp();
    anyhow::ensure!(now.abs_diff(timestamp) <= 300, "expired service signature");
    let nonce = header("x-mon-service-nonce");
    anyhow::ensure!(!nonce.is_empty() && nonce.len() <= 128, "invalid nonce");
    let hash = format!("{:x}", Sha256::digest(body));
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())?;
    mac.update(["monos", "self_awake:submit", ts, nonce, "POST", path, &hash].join("\n").as_bytes());
    let raw = header("x-mon-service-signature");
    anyhow::ensure!(raw.len() == 64 && raw.is_ascii(), "invalid signature");
    let bytes = (0..64).step_by(2).map(|i| u8::from_str_radix(&raw[i..i+2],16)).collect::<Result<Vec<_>,_>>()?;
    mac.verify_slice(&bytes).map_err(|_| anyhow::anyhow!("invalid signature"))?;
    static NONCES: OnceLock<Mutex<HashMap<String,i64>>> = OnceLock::new();
    let mut nonces = NONCES.get_or_init(Default::default).lock().map_err(|_| anyhow::anyhow!("nonce lock unavailable"))?;
    nonces.retain(|_,expires| *expires >= now);
    anyhow::ensure!(!nonces.contains_key(nonce), "replayed nonce");
    nonces.insert(nonce.to_owned(), now + 600);
    Ok(())
}

pub(crate) async fn core_identity() -> Result<(reqwest::Client,String,String,String)> {
    let (secret,user) = identity()?;
    let base = std::env::var("MON_CORE_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:40011".into()).trim_end_matches('/').to_owned();
    let client = reqwest::Client::builder().timeout(Duration::from_secs(30)).build()?;
    let path = "/api/internal/service-token/";
    let body = serde_json::to_vec(&json!({"audience":"monagent","requested_scope":"self_awake:user_context"}))?;
    let ts = chrono::Utc::now().timestamp().to_string();
    let nonce = Uuid::new_v4().simple().to_string();
    let hash = format!("{:x}",Sha256::digest(&body));
    let sig = signature(&secret,&["monagent","core:service_token",&ts,&nonce,"POST",path,&hash])?.iter().map(|b|format!("{b:02x}")).collect::<String>();
    let data: Value = client.post(format!("{base}{path}"))
        .header("x-mon-service-id","monagent").header("x-mon-service-scope","core:service_token")
        .header("x-mon-service-timestamp",ts).header("x-mon-service-nonce",nonce).header("x-mon-service-signature",sig)
        .header("Content-Type","application/json").body(body).send().await?.error_for_status()?.json().await?;
    anyhow::ensure!(data["user_id"].to_string().trim_matches('"') == user, "service user mismatch");
    let token = data["token"].as_str().context("Core token missing")?.to_owned();
    Ok((client,base,token,user))
}

fn participant_from_detail(detail: Value) -> Result<Value> {
    let character = &detail["character"];
    anyhow::ensure!(!detail["id"].is_null() && !character["id"].is_null(), "current duty assistant has no character");
    Ok(json!({"assistantId":detail["id"],"assistantName":detail["name"],
        "characterId":character["id"],"characterName":character["name"],
        "signature":character["signature"],"profile":detail,"position":0}))
}

async fn current_participant(client: &reqwest::Client, base: &str, token: &str) -> Result<Value> {
    // Core owns the current-duty selection and its default fallback. A paged
    // assistant list or the old session participant is not that selection.
    let detail: Value = client.get(format!("{base}/api/assistants/current/"))
        .header("Authorization", format!("Token {token}"))
        .send().await?.error_for_status()?.json().await?;
    participant_from_detail(detail)
}

async fn refresh_duty_participant(store: &Store, client: &reqwest::Client, base: &str, token: &str, session_id: SessionId, job_id: Uuid) -> Result<Value> {
    let session = store.get_session(session_id).await?;
    store.ensure_assistant_handoff_ready(session_id).await?;
    let run = store.get_self_awake_run_by_job(job_id).await?;
    // Once a turn has begun its retries keep the original author. New pending
    // wakes always resolve current duty, even when reusing an old session.
    let participant = if run.request["author"]["assistantId"].is_null() {
        current_participant(client, base, token).await?
    } else { run.request["author"].clone() };
    if session.participants != vec![participant.clone()] {
        store.set_session_participants(session_id, vec![participant.clone()]).await?;
    }
    Ok(participant)
}

pub(crate) async fn prepare_job(store: &Store, core_models: &CoreModelClient, models: &DynamicModelProvider, host: &HostServices, core_sync: &CoreSyncService, session_id: SessionId, job_id: Uuid) -> Result<()> {
    let (client,base,token,user) = core_identity().await?;
    let session = store.get_session(session_id).await?;
    anyhow::ensure!(session.environment["selfAwakeUserId"].as_str() == Some(&user), "self-awake session owner mismatch");
    let participant = refresh_duty_participant(store, &client, &base, &token, session_id, job_id).await?;
    let assistant = &participant["assistantId"];
    core_models.catalog_for(&base,&token,models,Some(&session_id.to_string()),Some(assistant)).await?;
    core_models.configure_assistant_for_session(&base,&token,assistant,&session_id.to_string(),models).await?;
    bind_job_credentials(store, host, core_sync, session_id, &base, &token, &user).await
}

async fn bind_job_credentials(store: &Store, host: &HostServices, core_sync: &CoreSyncService, session_id: SessionId, base: &str, token: &str, user: &str) -> Result<()> {
    let session = store.get_session(session_id).await?;
    anyhow::ensure!(session.is_background() && session.environment["selfAwakeUserId"].as_str() == Some(user), "self-awake session owner mismatch");
    // Refresh both consumers on every wake/retry, without installing a global
    // user credential. Model configuration alone does not bind business tools.
    core_sync.bind_session(session_id, base, token).await?;
    host.bind_core_credentials(Some(&session_id.to_string()), base, token).await.map_err(anyhow::Error::msg)?;
    Ok(())
}

pub(crate) async fn submit(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    handle(state,headers,body,false).await
}
pub(crate) async fn status(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    handle(state,headers,body,true).await
}
async fn handle(state: AppState, headers: HeaderMap, body: Bytes, status: bool) -> Response {
    if state.runtime_origin != RuntimeOrigin::Mon { return StatusCode::NOT_FOUND.into_response(); }
    let (secret,user) = match identity() {Ok(v)=>v,Err(_)=>return (StatusCode::SERVICE_UNAVAILABLE,"self-awake service identity missing").into_response()};
    if authorize(&headers,&body,if status {STATUS_PATH}else{RUN_PATH},&secret).is_err() {return StatusCode::UNAUTHORIZED.into_response();}
    let payload: Value = match serde_json::from_slice(&body) {Ok(v)=>v,Err(_)=>return StatusCode::BAD_REQUEST.into_response()};
    if payload["user_id"].to_string().trim_matches('"') != user {return StatusCode::FORBIDDEN.into_response();}
    match if status {read_status(&state,&payload,&user).await} else {enqueue(&state,payload,&user).await} {
        Ok(v)=>Json(v).into_response(),
        Err(error)=>{warn!(%error,"self-awake bridge request failed");(StatusCode::BAD_REQUEST,Json(json!({"error":error.to_string()}))).into_response()}
    }
}
async fn read_status(state: &AppState,payload:&Value,user:&str)->Result<Value> {
    let job_id = payload["job_id"].as_str().context("job_id missing")?.parse()?;
    let job = state.store.get_job(job_id).await?;
    anyhow::ensure!(job.kind=="self_awake" && job.payload["userId"].as_str()==Some(user),"job owner mismatch");
    let run = state.store.get_self_awake_run_by_job(job_id).await?;
    let status = if job.state=="failed" {"failed"} else {&run.status};
    Ok(json!({"id":run.id,"status":status,"decision_payload":run.decision,"error":run.last_error.or(job.last_error),"updated_at":chrono::Utc::now().to_rfc3339()}))
}
async fn enqueue(state:&AppState,payload:Value,user:&str)->Result<Value> {
    anyhow::ensure!(payload["schema_version"]=="self-awake.v1","unsupported self-awake schema");
    let key=payload["idempotency_key"].as_str().filter(|s|!s.is_empty() && s.len()<=256).context("idempotency_key missing")?;
    let event=payload["event_id"].as_str().filter(|s|!s.is_empty()).context("event_id missing")?;
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    let _guard=LOCK.get_or_init(||tokio::sync::Mutex::new(())).lock().await;
    let config_key=format!("self_awake.session.{user}");
    let session=if let Some(id)=state.store.get_config(&config_key).await?.and_then(|v|v.as_str().map(str::to_owned)) {
        state.store.get_session(id.parse()?).await?
    }else{
        let (client,base,token,_)=core_identity().await?;
        let participant=current_participant(&client,&base,&token).await?;
        let session=state.store.create_session_with_runtime_origin("后台自醒",vec![participant],json!({"sessionPurpose":"self_awake","selfAwakeUserId":user,"timezone":"Asia/Shanghai","locale":"zh-CN"}),store_origin(RuntimeOrigin::Mon)).await?;
        state.store.set_config(&config_key,json!(session.id)).await?;
        session
    };
    anyhow::ensure!(session.environment["selfAwakeUserId"].as_str()==Some(user),"session owner mismatch");
    let job=state.store.schedule_job("self_awake",Some(session.id),chrono::Utc::now().timestamp_millis(),json!({"schemaVersion":"self-awake.v1","scheduler":"monos","eventId":event,"userId":user,"trigger":payload["context"],"prompt":"按当前角色的意愿与处境决定本轮行动，按需使用工具，最后记录经历并安排下次醒来。"}),&format!("self-awake:{user}:{key}")).await?;
    Ok(json!({"accepted":true,"async_run_id":job.id,"job_id":job.id,"event_id":event,"idempotency_key":key,"status":"queued"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn headers(secret:&str,path:&str,body:&[u8],timestamp:i64)->HeaderMap {
        let ts=timestamp.to_string();
        let nonce=Uuid::new_v4().to_string();
        let hash=format!("{:x}",Sha256::digest(body));
        let sig=signature(secret,&["monos","self_awake:submit",&ts,&nonce,"POST",path,&hash]).unwrap().iter().map(|b|format!("{b:02x}")).collect::<String>();
        let mut h=HeaderMap::new();
        for (k,v) in [("x-mon-service-id","monos"),("x-mon-service-scope","self_awake:submit"),("x-mon-service-timestamp",&ts),("x-mon-service-nonce",&nonce),("x-mon-service-signature",&sig)] {h.insert(header::HeaderName::from_bytes(k.as_bytes()).unwrap(),v.parse().unwrap());}
        h
    }
    #[tokio::test]
    async fn duty_changes_refresh_new_wakes_but_preserve_started_authors() {
        use std::sync::atomic::AtomicU64;
        let current = Arc::new(AtomicU64::new(21));
        let selected = current.clone();
        let router = axum::Router::new().route("/api/assistants/current/", axum::routing::get(move || {
            let id = selected.load(Ordering::SeqCst);
            async move {
                if id == 0 { (StatusCode::SERVICE_UNAVAILABLE, Json(json!({}))) }
                else { (StatusCode::OK, Json(json!({"id":id,"name":format!("assistant-{id}"),"character":{"id":id,"name":format!("character-{id}"),"personality":"current profile"}}))) }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
        let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap();
        let store = Store::in_memory().await.unwrap();
        let old = participant_from_detail(json!({"id":18,"name":"old","character":{"id":18,"name":"old character"}})).unwrap();
        let session = store.create_session_with_runtime_origin("background", vec![old.clone()],json!({"sessionPurpose":"self_awake"}),store_origin(RuntimeOrigin::Mon)).await.unwrap();
        let prior = store.schedule_job("self_awake",Some(session.id),0,json!({}),"old").await.unwrap();
        let prior_run = store.start_self_awake_run(&prior,"self-awake.v1","old",json!({"author":old}),json!({"assistantId":"18","characterId":"18"})).await.unwrap();
        store.complete_self_awake_run(&prior_run,json!({}),Some(json!({"title":"old diary","content":"old author content"})),None,None).await.unwrap();
        let job = store.schedule_job("self_awake",Some(session.id),0,json!({}),"new").await.unwrap();
        let participant = refresh_duty_participant(&store,&client,&base,"test",session.id,job.id).await.unwrap();
        assert_eq!(participant["assistantId"],21);
        assert_eq!(store.get_session(session.id).await.unwrap().participants[0]["characterId"],21);
        assert_eq!(store.list_self_awake_diaries_for_run(prior_run.id).await.unwrap()[0].assistant_id,"18");
        store.start_self_awake_run(&job,"self-awake.v1","new",json!({"author":participant}),json!({"assistantId":"21"})).await.unwrap();
        current.store(22,Ordering::SeqCst);
        assert_eq!(refresh_duty_participant(&store,&client,&base,"test",session.id,job.id).await.unwrap()["assistantId"],21);
        let next = store.schedule_job("self_awake",Some(session.id),0,json!({}),"next").await.unwrap();
        assert_eq!(refresh_duty_participant(&store,&client,&base,"test",session.id,next.id).await.unwrap()["assistantId"],22);
        current.store(0,Ordering::SeqCst);
        let unavailable = store.schedule_job("self_awake",Some(session.id),0,json!({}),"unavailable").await.unwrap();
        assert!(refresh_duty_participant(&store,&client,&base,"test",session.id,unavailable.id).await.is_err());
        assert_eq!(store.get_session(session.id).await.unwrap().participants[0]["assistantId"],22);
        server.abort();
    }

    #[tokio::test]
    async fn self_awake_credentials_reach_tools_and_delivery_without_cross_session_leak() {
        use eden_agent_core::{event_channel, ToolCall, ToolCallContext};
        let seen = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
        let requests = seen.clone();
        let router = axum::Router::new().fallback(move |headers: HeaderMap| {
            let requests = requests.clone();
            async move {
                requests.lock().await.push(headers.get("authorization").unwrap().to_str().unwrap().to_owned());
                Json(json!({"id":2,"data":{"bots":[],"permissions":{}}}))
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap(); });
        let store = Store::in_memory().await.unwrap();
        let session = store.create_session_with_runtime_origin("background",vec![],json!({"sessionPurpose":"self_awake","selfAwakeUserId":"2"}),store_origin(RuntimeOrigin::Mon)).await.unwrap();
        let other = store.create_session_with_runtime_origin("other",vec![],json!({"sessionPurpose":"self_awake","selfAwakeUserId":"3"}),store_origin(RuntimeOrigin::Mon)).await.unwrap();
        let host = HostServices::new(store.clone(),None,None).unwrap();
        let sync = CoreSyncService::new(store.clone()).unwrap();
        let tool = host.tools().into_iter().find(|tool| tool.definition().name == "qq_bot_targets").unwrap();
        for token in ["first-credential","refreshed-credential"] {
            bind_job_credentials(&store,&host,&sync,session.id,&base,token,"2").await.unwrap();
            let identity = store.get_core_session_identity(session.id).await.unwrap().unwrap();
            assert_eq!(identity.principal_key,"user:2");
            let (events,_receiver) = event_channel(8);
            tool.execute(&ToolCall{id:"qq".into(),name:"qq_bot_targets".into(),arguments:json!({})},ToolCallContext{
                cancellation: CancellationToken::new(),events,session_id:Some(session.id.to_string()),metadata:json!({})
            }).await.unwrap();
            assert_eq!(seen.lock().await.last().unwrap(), &format!("Token {token}"));
        }
        let before = seen.lock().await.len();
        assert!(bind_job_credentials(&store,&host,&sync,other.id,&base,"wrong","2").await.is_err());
        assert!(store.get_core_session_identity(other.id).await.unwrap().is_none());
        let (events,_receiver) = event_channel(8);
        let failure = tool.execute(&ToolCall{id:"qq-other".into(),name:"qq_bot_targets".into(),arguments:json!({})},ToolCallContext{
            cancellation: CancellationToken::new(),events,session_id:Some(other.id.to_string()),metadata:json!({})
        }).await.unwrap_err();
        assert_eq!(failure.info.code,"core_unconfigured");
        assert_eq!(seen.lock().await.len(),before);
        server.abort();
    }

    #[tokio::test]
    async fn desktop_window_state_survives_receipt_and_recovers_without_false_acknowledgement() {
        let store=Store::in_memory().await.unwrap();
        let session=store.create_session_with_runtime_origin("background",vec![],json!({"sessionPurpose":"self_awake"}),store_origin(RuntimeOrigin::Mon)).await.unwrap();
        let job=store.schedule_job("self_awake",Some(session.id),0,json!({}),"desktop-test").await.unwrap();
        let run=store.start_self_awake_run(&job,"self-awake.v1","test",json!({}),json!({})).await.unwrap();
        store.complete_self_awake_run(&run,json!({}),None,Some(json!({"channel":"desktop","message":"test"})),None).await.unwrap();
        store.record_self_awake_desktop_state(run.id,"open").await.unwrap();
        store.update_self_awake_notification(run.id,"delivered",Some(json!({"deliveredChannel":"desktop"})),None).await.unwrap();
        let value=store.get_self_awake_notification(run.id).await.unwrap().unwrap();
        assert_eq!(value["result"]["desktopWindow"]["state"],"open");
        store.recover_self_awake_desktop_states().await.unwrap();
        assert_eq!(store.get_self_awake_notification(run.id).await.unwrap().unwrap()["result"]["desktopWindow"]["state"],"unknown");
        store.record_self_awake_desktop_state(run.id,"closed").await.unwrap();
        // A late retry must neither clear the acknowledgement nor reopen it.
        store.update_self_awake_notification(run.id,"pending",None,Some("retry")).await.unwrap();
        let value=store.get_self_awake_notification(run.id).await.unwrap().unwrap();
        assert_eq!(value["state"],"delivered");
        assert_eq!(value["result"]["desktopWindow"]["state"],"closed");
        assert!(value["result"]["desktopWindow"]["userRead"].is_null());
    }

    #[tokio::test]
    async fn desktop_tool_records_link_to_wake_and_recover_without_reopening() {
        let store=Store::in_memory().await.unwrap();
        let session=store.create_session("background").await.unwrap();
        let job=store.schedule_job("self_awake",Some(session.id),0,json!({}),"tool-test").await.unwrap();
        let run=store.start_self_awake_run(&job,"self-awake.v1","test",json!({}),json!({})).await.unwrap();
        let (record,created)=store.reserve_desktop_reminder(session.id,"turn","title","message").await.unwrap();
        assert!(created);
        let id=record["id"].as_str().unwrap();
        store.record_desktop_reminder_state(id,"open").await.unwrap();
        assert_eq!(store.desktop_reminders_for_run(run.id).await.unwrap()[0]["state"],"open");
        store.recover_self_awake_desktop_states().await.unwrap();
        let (record,created)=store.reserve_desktop_reminder(session.id,"retry-operation","title","message").await.unwrap();
        assert!(!created);
        assert_eq!(record["state"],"unknown");
        store.record_desktop_reminder_state(id,"closed").await.unwrap();
        assert_eq!(store.desktop_reminders_for_run(run.id).await.unwrap()[0]["state"],"closed");
        let history=store.self_awake_contact_history(session.id,10).await.unwrap();
        assert_eq!(history[0]["source"],"show_desktop_reminder");
        assert_eq!(history[0]["state"],"closed");
    }

    #[test]
    fn service_signature_binds_body_path_time_and_nonce() {
        let body=b"{}";let now=chrono::Utc::now().timestamp();
        let h=headers("test",RUN_PATH,body,now);
        assert!(authorize(&h,b"{\"changed\":true}",RUN_PATH,"test").is_err());
        assert!(authorize(&h,body,STATUS_PATH,"test").is_err());
        assert!(authorize(&h,body,RUN_PATH,"wrong").is_err());
        assert!(authorize(&h,body,RUN_PATH,"test").is_ok());
        assert!(authorize(&h,body,RUN_PATH,"test").is_err());
        let stale=headers("test",RUN_PATH,body,now-301);
        assert!(authorize(&stale,body,RUN_PATH,"test").is_err());
        assert!(authorize(&HeaderMap::new(),body,RUN_PATH,"test").is_err());
    }
}

/// Read the scheduler-owned plan, rather than inferring it from a past decision.
/// This path is configured by the host and is never supplied by RPC clients.
pub(crate) async fn schedule(state: &AppState) -> Option<eden_agent_api::SelfAwakeScheduleInfo> {
    if state.runtime_origin != RuntimeOrigin::Mon { return None; }
    let path = std::env::var("MONOS_SELF_AWAKE_STATE_PATH").ok()?;
    let bytes = tokio::fs::read(path).await.ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    Some(schedule_info(&value))
}

fn schedule_info(value: &Value) -> eden_agent_api::SelfAwakeScheduleInfo {
    let active = matches!(value["last_agent_async_status"].as_str(), Some("pending" | "queued" | "running"));
    let next = value["next_wake_at"].as_str()
        .filter(|v| chrono::DateTime::parse_from_rfc3339(v).is_ok()).map(str::to_owned);
    let status = if value["enabled"] == false { "disabled" }
        else if active { "running" } else if next.is_some() { "scheduled" } else { "unscheduled" };
    eden_agent_api::SelfAwakeScheduleInfo {
        status: status.into(),
        next_wake_at: if status == "scheduled" { next } else { None },
        reason: value["next_wake_reason"].as_str().unwrap_or("").into(),
    }
}
