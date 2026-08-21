use super::*;

#[test]
fn config_debug_never_exposes_api_key() {
    let config = OpenAiCompatibleConfig {
        model: ModelSpec::default(),
        api_key: Arc::from("top-secret"),
        base_url: "http://localhost".to_owned(),
        max_retries: 0,
        request_timeout: Duration::from_secs(1),
    };
    let rendered = format!("{config:?}");
    assert!(!rendered.contains("top-secret"));
    assert!(rendered.contains("[REDACTED]"));
}
