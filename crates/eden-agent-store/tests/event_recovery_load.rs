use eden_agent_store::{SessionRuntimeOrigin, Store};
use serde_json::json;
use std::time::Instant;
use tokio::sync::broadcast::error::TryRecvError;

/// File-backed SQLite load probe; timings are observations, not CI thresholds.
/// Run with: cargo test -p eden-agent-store --test event_recovery_load -- --ignored --nocapture
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "explicit disk-backed concurrency and recovery probe"]
async fn concurrent_streams_survive_subscriber_lag_and_database_reopen() {
    const STREAMS: usize = 8;
    const EVENTS_PER_STREAM: usize = 512;
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("events.db");
    let store = Store::open(&database).await.unwrap();
    store
        .bind_runtime_origin(SessionRuntimeOrigin::Local, false)
        .await
        .unwrap();
    let mut sessions = Vec::new();
    for index in 0..STREAMS {
        let session = store
            .create_session_with_runtime_origin(
                format!("stream-{index}"),
                vec![],
                json!({}),
                SessionRuntimeOrigin::Local,
            )
            .await
            .unwrap();
        sessions.push(session.id);
    }
    let mut slow_subscriber = store.subscribe();
    let started = Instant::now();
    let mut writers = Vec::new();
    for session_id in &sessions {
        let store = store.clone();
        let session_id = *session_id;
        writers.push(tokio::spawn(async move {
            let mut timings = Vec::new();
            for index in 0..EVENTS_PER_STREAM {
                let write_started = Instant::now();
                store
                    .append_event(
                        session_id,
                        None,
                        "agent.message_update",
                        json!({"delta":"x".repeat(256),"index":index}),
                    )
                    .await
                    .unwrap();
                timings.push(write_started.elapsed().as_micros());
            }
            timings
        }));
    }
    let mut timings = Vec::new();
    for writer in writers {
        timings.extend(writer.await.unwrap());
    }
    let elapsed = started.elapsed();
    assert!(matches!(
        slow_subscriber.try_recv(),
        Err(TryRecvError::Lagged(_))
    ));
    // Even a retained live event must already be readable from SQLite.
    let observed = slow_subscriber.try_recv().unwrap();
    let persisted = store
        .list_events(observed.session_id, observed.seq - 1)
        .await
        .unwrap();
    assert_eq!(persisted[0].id, observed.id);
    drop(slow_subscriber);
    drop(store);

    let recovery_started = Instant::now();
    let reopened = Store::open(&database).await.unwrap();
    assert!(
        reopened
            .bind_runtime_origin(SessionRuntimeOrigin::Mon, false)
            .await
            .is_err()
    );
    for session_id in sessions {
        let events = reopened.list_events(session_id, 0).await.unwrap();
        assert_eq!(events.len(), EVENTS_PER_STREAM);
        for (index, event) in events.iter().enumerate() {
            assert_eq!(event.seq, index as i64 + 1);
            assert_eq!(event.payload["index"], json!(index));
        }
        let tail = reopened.list_events(session_id, 400).await.unwrap();
        assert_eq!(tail.len(), EVENTS_PER_STREAM - 400);
        assert_eq!(tail[0].seq, 401);
    }
    timings.sort_unstable();
    eprintln!(
        "streams={STREAMS}, events={}, elapsed={elapsed:?}, events/s={:.0}, write p50={}us p95={}us p99={}us, reopen+replay={:?}",
        timings.len(),
        timings.len() as f64 / elapsed.as_secs_f64(),
        timings[timings.len() / 2],
        timings[timings.len() * 95 / 100],
        timings[timings.len() * 99 / 100],
        recovery_started.elapsed(),
    );
}
