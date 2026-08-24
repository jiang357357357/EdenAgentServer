use crate::*;

pub(crate) fn env_text(name: &str, fallback: &str) -> String {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_owned())
}

pub(crate) fn env_number<T>(name: &str, fallback: T) -> T
where
    T: std::str::FromStr,
{
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

pub(crate) fn env_boolean(name: &str, fallback: bool) -> bool {
    std::env::var(name).ok().map_or(fallback, |value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

pub(crate) fn default_gsv_tts_config() -> GsvTtsConfig {
    GsvTtsConfig {
        provider: env_text("EDEN_AGENT_TTS_PROVIDER", "gsv"),
        service_url: env_text("EDEN_AGENT_TTS_SERVICE_URL", "http://127.0.0.1:40302"),
        version: env_text("EDEN_AGENT_TTS_VERSION", "v2ProPlus"),
        world: env_text("EDEN_AGENT_TTS_WORLD", "Default"),
        role: env_text("EDEN_AGENT_TTS_ROLE", "阿罗娜"),
        role_id: env_text("EDEN_AGENT_TTS_ROLE_ID", ""),
        emotion: env_text("EDEN_AGENT_TTS_EMOTION", "平常"),
        text_language: env_text("EDEN_AGENT_TTS_TEXT_LANGUAGE", "中文"),
        speed: env_number::<f64>("EDEN_AGENT_TTS_SPEED", 1.0).clamp(0.5, 2.0),
        timeout_seconds: env_number::<u32>("EDEN_AGENT_TTS_TIMEOUT_SECONDS", 60).clamp(5, 300),
        top_k: env_number::<u32>("EDEN_AGENT_TTS_TOP_K", 20).clamp(1, 100),
        top_p: env_number::<f64>("EDEN_AGENT_TTS_TOP_P", 0.6).clamp(0.0, 1.0),
        temperature: env_number::<f64>("EDEN_AGENT_TTS_TEMPERATURE", 0.6).clamp(0.0, 2.0),
        sample_steps: env_number::<u32>("EDEN_AGENT_TTS_SAMPLE_STEPS", 8).clamp(1, 100),
        pause_seconds: env_number::<f64>("EDEN_AGENT_TTS_PAUSE_SECONDS", 0.3).clamp(0.0, 5.0),
        cut_method: env_text("EDEN_AGENT_TTS_CUT_METHOD", "凑四句一切"),
        super_resolution: env_boolean("EDEN_AGENT_TTS_SUPER_RESOLUTION", false),
        reference_free: env_boolean("EDEN_AGENT_TTS_REFERENCE_FREE", false),
        freeze: env_boolean("EDEN_AGENT_TTS_FREEZE", false),
    }
}

pub(crate) fn default_gsv_stt_config() -> GsvSttConfig {
    GsvSttConfig {
        provider: env_text("EDEN_AGENT_STT_PROVIDER", "gsv"),
        service_url: env_text("EDEN_AGENT_STT_SERVICE_URL", "http://127.0.0.1:40302"),
        language: env_text("EDEN_AGENT_STT_LANGUAGE", "zh"),
        model_type: env_text("EDEN_AGENT_STT_MODEL_TYPE", "funasr"),
        model_size: env_text("EDEN_AGENT_STT_MODEL_SIZE", "large"),
        precision: env_text("EDEN_AGENT_STT_PRECISION", "float32"),
        timeout_seconds: env_number::<u32>("EDEN_AGENT_STT_TIMEOUT_SECONDS", 60).clamp(1, 300),
        retry_count: env_number::<u32>("EDEN_AGENT_STT_RETRY_COUNT", 3).clamp(0, 10),
        end_silence_ms: env_number::<u32>("EDEN_AGENT_STT_END_SILENCE_MS", 1200).clamp(300, 5000),
        session_end_silence_ms: env_number::<u32>("EDEN_AGENT_STT_SESSION_END_SILENCE_MS", 3000)
            .clamp(1000, 15000),
        auto_finish: env_boolean("EDEN_AGENT_STT_AUTO_FINISH", true),
        auto_send: env_boolean("EDEN_AGENT_STT_AUTO_SEND", false),
        min_speech_duration_ms: env_number::<u32>("EDEN_AGENT_STT_MIN_SPEECH_DURATION_MS", 250)
            .clamp(100, 2000),
        speech_noise_threshold: env_number::<f64>("EDEN_AGENT_STT_SPEECH_NOISE_THRESHOLD", 0.6)
            .clamp(0.1, 1.0),
        preroll_ms: env_number::<u32>("EDEN_AGENT_STT_PREROLL_MS", 1200).clamp(0, 3000),
        chunk_ms: env_number::<u32>("EDEN_AGENT_STT_CHUNK_MS", 200).clamp(100, 1000),
    }
}

pub(crate) fn normalize_gsv_url(value: &str, label: &str) -> Result<String, RpcFailure> {
    let value = value.trim().trim_end_matches('/').to_owned();
    let parsed = reqwest::Url::parse(&value)
        .map_err(|_| RpcFailure::invalid_params(format!("{label}格式不正确")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(RpcFailure::invalid_params(format!(
            "{label}只支持 HTTP 或 HTTPS"
        )));
    }
    Ok(value)
}

pub(crate) fn finite_range(
    value: f64,
    minimum: f64,
    maximum: f64,
    label: &str,
) -> Result<f64, RpcFailure> {
    if value.is_finite() && (minimum..=maximum).contains(&value) {
        return Ok(value);
    }
    Err(RpcFailure::invalid_params(format!(
        "{label}必须在 {minimum} 到 {maximum} 之间"
    )))
}

pub(crate) fn normalize_gsv_tts_config(
    mut config: GsvTtsConfig,
) -> Result<GsvTtsConfig, RpcFailure> {
    config.provider = config.provider.trim().to_ascii_lowercase();
    if config.provider != "gsv" {
        return Err(RpcFailure::invalid_params("当前仅支持 GSV TTS 提供商"));
    }
    config.service_url = normalize_gsv_url(&config.service_url, "GSV 服务地址")?;
    config.version = config.version.trim().to_owned();
    config.world = config.world.trim().to_owned();
    config.role = config.role.trim().to_owned();
    config.role_id = config.role_id.trim().to_owned();
    config.emotion = config.emotion.trim().to_owned();
    config.text_language = config.text_language.trim().to_owned();
    config.cut_method = config.cut_method.trim().to_owned();
    config.speed = finite_range(config.speed, 0.5, 2.0, "合成语速")?;
    config.top_p = finite_range(config.top_p, 0.0, 1.0, "Top P")?;
    config.temperature = finite_range(config.temperature, 0.0, 2.0, "Temperature")?;
    config.pause_seconds = finite_range(config.pause_seconds, 0.0, 5.0, "句间停顿")?;
    if !(5..=300).contains(&config.timeout_seconds)
        || !(1..=100).contains(&config.top_k)
        || !(1..=100).contains(&config.sample_steps)
    {
        return Err(RpcFailure::invalid_params("GSV TTS 数值参数超出允许范围"));
    }
    Ok(config)
}

pub(crate) fn normalize_gsv_stt_config(
    mut config: GsvSttConfig,
) -> Result<GsvSttConfig, RpcFailure> {
    config.provider = config.provider.trim().to_ascii_lowercase();
    if config.provider != "gsv" {
        return Err(RpcFailure::invalid_params("当前仅支持 GSV STT 提供商"));
    }
    config.service_url = normalize_gsv_url(&config.service_url, "GSV 转录服务地址")?;
    config.language = config.language.trim().to_owned();
    config.model_type = config.model_type.trim().to_owned();
    config.model_size = config.model_size.trim().to_owned();
    config.precision = config.precision.trim().to_owned();
    config.speech_noise_threshold =
        finite_range(config.speech_noise_threshold, 0.1, 1.0, "语音噪声阈值")?;
    if !(1..=300).contains(&config.timeout_seconds)
        || config.retry_count > 10
        || !(300..=5000).contains(&config.end_silence_ms)
        || !(1000..=15000).contains(&config.session_end_silence_ms)
        || !(100..=2000).contains(&config.min_speech_duration_ms)
        || config.preroll_ms > 3000
        || !(100..=1000).contains(&config.chunk_ms)
    {
        return Err(RpcFailure::invalid_params("GSV STT 数值参数超出允许范围"));
    }
    Ok(config)
}

pub(crate) fn require_gsv_tts_selection(config: &GsvTtsConfig) -> Result<(), RpcFailure> {
    if config.version.is_empty()
        || config.world.is_empty()
        || config.role.is_empty()
        || config.role_id.is_empty()
        || config.emotion.is_empty()
    {
        return Err(RpcFailure::invalid_params(
            "请依次选择 GSV 版本、世界、角色和情感",
        ));
    }
    Ok(())
}

pub(crate) async fn initialize_voice_config(store: &Store) -> Result<()> {
    if store.get_config(GSV_TTS_CONFIG_KEY).await?.is_none() {
        let config = normalize_gsv_tts_config(default_gsv_tts_config())
            .map_err(|error| anyhow::anyhow!(error.message))?;
        store
            .set_config(GSV_TTS_CONFIG_KEY, serde_json::to_value(config)?)
            .await?;
    }
    if store.get_config(GSV_STT_CONFIG_KEY).await?.is_none() {
        let config = normalize_gsv_stt_config(default_gsv_stt_config())
            .map_err(|error| anyhow::anyhow!(error.message))?;
        store
            .set_config(GSV_STT_CONFIG_KEY, serde_json::to_value(config)?)
            .await?;
    }
    Ok(())
}

pub(crate) async fn read_voice_runtime_config(
    state: &AppState,
) -> Result<VoiceRuntimeConfig, RpcFailure> {
    let tts = state
        .store
        .get_config(GSV_TTS_CONFIG_KEY)
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?
        .ok_or_else(|| RpcFailure::application("GSV TTS 配置尚未初始化"))?;
    let stt = state
        .store
        .get_config(GSV_STT_CONFIG_KEY)
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?
        .ok_or_else(|| RpcFailure::application("GSV STT 配置尚未初始化"))?;
    Ok(VoiceRuntimeConfig {
        tts: normalize_gsv_tts_config(
            serde_json::from_value(tts)
                .map_err(|error| RpcFailure::application(format!("GSV TTS 配置损坏：{error}")))?,
        )?,
        stt: normalize_gsv_stt_config(
            serde_json::from_value(stt)
                .map_err(|error| RpcFailure::application(format!("GSV STT 配置损坏：{error}")))?,
        )?,
    })
}

#[derive(Clone, Debug)]
pub(crate) struct LocalGsvTtsConfig {
    pub(super) service_url: String,
    pub(super) version: String,
    pub(super) world: String,
    pub(super) role: String,
    pub(super) role_id: Option<String>,
    pub(super) emotion: String,
    pub(super) text_language: String,
    pub(super) speed: f64,
    pub(super) timeout: Duration,
    pub(super) top_k: u32,
    pub(super) top_p: f64,
    pub(super) temperature: f64,
    pub(super) sample_steps: u32,
    pub(super) pause_seconds: f64,
    pub(super) cut_method: String,
    pub(super) super_resolution: bool,
    pub(super) reference_free: bool,
    pub(super) freeze: bool,
}

impl LocalGsvTtsConfig {
    pub(super) fn from_config(config: &GsvTtsConfig) -> Result<Self, RpcFailure> {
        let config = normalize_gsv_tts_config(config.clone())?;
        Ok(Self {
            service_url: config.service_url,
            version: config.version,
            world: config.world,
            role: config.role,
            role_id: (!config.role_id.is_empty()).then_some(config.role_id),
            emotion: config.emotion,
            text_language: config.text_language,
            speed: config.speed,
            timeout: Duration::from_secs(u64::from(config.timeout_seconds)),
            top_k: config.top_k,
            top_p: config.top_p,
            temperature: config.temperature,
            sample_steps: config.sample_steps,
            pause_seconds: config.pause_seconds,
            cut_method: config.cut_method,
            super_resolution: config.super_resolution,
            reference_free: config.reference_free,
            freeze: config.freeze,
        })
    }
}

#[derive(Clone, Debug)]
pub(crate) struct LocalGsvSttConfig {
    pub(super) service_url: String,
    pub(super) language: String,
    pub(super) model_type: String,
    pub(super) model_size: String,
    pub(super) precision: String,
    pub(super) timeout: Duration,
    pub(super) retry_count: u32,
    pub(super) end_silence_ms: u32,
    pub(super) session_end_silence_ms: u32,
    pub(super) auto_finish: bool,
    pub(super) auto_send: bool,
    pub(super) min_speech_duration_ms: u32,
    pub(super) speech_noise_threshold: f64,
    pub(super) preroll_ms: u32,
    pub(super) chunk_ms: u32,
}

impl LocalGsvSttConfig {
    pub(super) fn from_config(config: &GsvSttConfig) -> Result<Self, String> {
        let config = normalize_gsv_stt_config(config.clone()).map_err(|error| error.message)?;
        Ok(Self {
            service_url: config.service_url,
            language: config.language,
            model_type: config.model_type,
            model_size: config.model_size,
            precision: config.precision,
            timeout: Duration::from_secs(u64::from(config.timeout_seconds)),
            retry_count: config.retry_count,
            end_silence_ms: config.end_silence_ms,
            session_end_silence_ms: config.session_end_silence_ms,
            auto_finish: config.auto_finish,
            auto_send: config.auto_send,
            min_speech_duration_ms: config.min_speech_duration_ms,
            speech_noise_threshold: config.speech_noise_threshold,
            preroll_ms: config.preroll_ms,
            chunk_ms: config.chunk_ms,
        })
    }

    pub(super) fn upstream_url(&self) -> Result<String, String> {
        let mut parsed = reqwest::Url::parse(&self.service_url)
            .map_err(|_| "GSV 转录服务地址格式不正确".to_owned())?;
        let websocket_scheme = if parsed.scheme() == "https" {
            "wss"
        } else {
            "ws"
        };
        parsed
            .set_scheme(websocket_scheme)
            .map_err(|_| "无法构造 GSV 实时转录地址".to_owned())?;
        parsed.set_path("/ws/asr/final");
        parsed.set_query(None);
        parsed.set_fragment(None);
        Ok(parsed.to_string())
    }
}
