use eden_agent_victoria3::{ControlConfig, Controller, Observer, ObserverConfig};
use serde_json::json;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() -> Result<(), String> {
    let settings = json!({"controlEnabled": true});
    let observer_config = ObserverConfig::from_settings(&settings);
    let control_config = ControlConfig::from_settings(&settings, &observer_config.log_path);
    let (handle, observer) = Observer::new(observer_config);
    let cancellation = CancellationToken::new();
    let (updates, mut observations) = tokio::sync::mpsc::channel(16);
    let observer_cancellation = cancellation.clone();
    let observer_task = tokio::spawn(observer.run(observer_cancellation, updates));
    let drain_task = tokio::spawn(async move { while observations.recv().await.is_some() {} });

    let attached = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if handle.state().await.attached {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .is_ok();
    if !attached {
        cancellation.cancel();
        let _ = observer_task.await;
        let _ = drain_task.await;
        return Err("Victoria 3 debug.log was not available within 10 seconds".to_owned());
    }

    let result = Controller::new(control_config, handle).probe().await;
    cancellation.cancel();
    let _ = observer_task.await;
    let _ = drain_task.await;
    println!(
        "{}",
        serde_json::to_string_pretty(&result?).map_err(|error| error.to_string())?
    );
    Ok(())
}
