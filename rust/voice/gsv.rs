use crate::*;

pub(crate) fn gsv_language_code(language: &str) -> &str {
    match language {
        "中文" => "zh",
        "英文" => "en",
        "日文" => "ja",
        "粤语" => "yue",
        "韩文" => "ko",
        "粤英混合" | "多语种混合(粤语)" => "auto_yue",
        "中英混合" | "日英混合" | "韩英混合" | "多语种混合" => "auto",
        value if !value.trim().is_empty() => value,
        _ => "zh",
    }
}

pub(crate) fn elapsed_millis(started: Instant) -> u32 {
    u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX)
}

pub(crate) fn gsv_options(payload: &Value, key: &str) -> Vec<GsvOption> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| match item {
            Value::String(value) if !value.trim().is_empty() => Some(GsvOption {
                id: String::new(),
                label: value.trim().to_owned(),
                value: value.trim().to_owned(),
            }),
            Value::Object(object) => {
                let value = object
                    .get("name")
                    .or_else(|| object.get("value"))
                    .or_else(|| object.get("label"))
                    .and_then(Value::as_str)?
                    .trim()
                    .to_owned();
                if value.is_empty() {
                    return None;
                }
                let id = object.get("id").map_or_else(String::new, |id| match id {
                    Value::String(value) => value.clone(),
                    Value::Number(value) => value.to_string(),
                    _ => String::new(),
                });
                let label = object
                    .get("label")
                    .or_else(|| object.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or(&value)
                    .to_owned();
                Some(GsvOption { id, label, value })
            }
            _ => None,
        })
        .collect()
}

pub(crate) async fn gsv_json(
    client: &reqwest::Client,
    service_url: &str,
    path: &str,
    query: &[(&str, &str)],
) -> Result<Value, RpcFailure> {
    let response = client
        .get(format!("{service_url}{path}"))
        .query(query)
        .send()
        .await
        .map_err(|error| RpcFailure::application(format!("无法连接 GSV 服务：{error}")))?;
    let status = response.status();
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| RpcFailure::application(format!("GSV 服务返回了无效数据：{error}")))?;
    if !status.is_success() {
        return Err(RpcFailure::application(format!(
            "GSV 服务返回 HTTP {status}: {}",
            payload
                .get("detail")
                .or_else(|| payload.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("未知错误")
        )));
    }
    Ok(payload)
}

pub(crate) async fn discover_gsv(
    params: GsvDiscoveryParams,
) -> Result<GsvDiscoveryResult, RpcFailure> {
    let config = normalize_gsv_tts_config(params.config)?;
    let started = Instant::now();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(u64::from(
            config.timeout_seconds.min(12),
        )))
        .build()
        .map_err(|error| RpcFailure::application(format!("初始化 GSV 客户端失败：{error}")))?;
    let mut versions = Vec::new();
    let mut worlds = Vec::new();
    let mut roles = Vec::new();
    let mut emotions = Vec::new();
    let mut version = config.version.clone();
    let mut world = config.world.clone();
    let mut selected_role = (!config.role_id.is_empty()).then(|| GsvOption {
        id: config.role_id.clone(),
        label: config.role.clone(),
        value: config.role.clone(),
    });

    if matches!(
        params.stage,
        GsvDiscoveryStage::All | GsvDiscoveryStage::Catalog
    ) {
        let payload = gsv_json(
            &client,
            &config.service_url,
            "/api/models/versions/from-enum/",
            &[],
        )
        .await?;
        versions = gsv_options(&payload, "versions");
        if !versions.iter().any(|option| option.value == version) {
            version = versions
                .first()
                .map(|option| option.value.clone())
                .unwrap_or(version);
        }
    }
    if matches!(
        params.stage,
        GsvDiscoveryStage::All | GsvDiscoveryStage::Catalog | GsvDiscoveryStage::Worlds
    ) && !version.is_empty()
    {
        let payload = gsv_json(
            &client,
            &config.service_url,
            "/api/world/list/",
            &[("version", version.as_str())],
        )
        .await?;
        worlds = gsv_options(&payload, "worlds");
        if !worlds.iter().any(|option| option.value == world) {
            world = worlds
                .first()
                .map(|option| option.value.clone())
                .unwrap_or(world);
        }
    }
    if (matches!(
        params.stage,
        GsvDiscoveryStage::All | GsvDiscoveryStage::Roles
    ) || (params.stage == GsvDiscoveryStage::Emotions && selected_role.is_none()))
        && !version.is_empty()
        && !world.is_empty()
    {
        let payload = gsv_json(
            &client,
            &config.service_url,
            "/api/role/list/",
            &[
                ("version", version.as_str()),
                ("world_name", world.as_str()),
            ],
        )
        .await?;
        roles = gsv_options(&payload, "roles");
        selected_role = roles
            .iter()
            .find(|option| option.id == config.role_id)
            .or_else(|| roles.iter().find(|option| option.value == config.role))
            .or_else(|| roles.first())
            .cloned();
    }
    if params.stage == GsvDiscoveryStage::All || params.stage == GsvDiscoveryStage::Emotions {
        if let Some(role) = selected_role.as_ref().filter(|role| !role.id.is_empty()) {
            let payload = gsv_json(
                &client,
                &config.service_url,
                "/api/role/emotions/",
                &[("role_id", role.id.as_str())],
            )
            .await?;
            emotions = gsv_options(&payload, "emotions");
        }
    }

    Ok(GsvDiscoveryResult {
        ok: true,
        latency_ms: elapsed_millis(started),
        versions,
        worlds,
        roles,
        emotions,
        selected_role_id: selected_role.map(|role| role.id).unwrap_or_default(),
    })
}

pub(crate) async fn test_gsv_stt(
    config: GsvSttConfig,
) -> Result<GsvConnectionTestResult, RpcFailure> {
    let config = normalize_gsv_stt_config(config)?;
    let started = Instant::now();
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(u64::from(
            config.timeout_seconds.min(12),
        )))
        .build()
        .map_err(|error| RpcFailure::application(format!("初始化 GSV 转录客户端失败：{error}")))?;
    let response = client
        .get(format!("{}/health", config.service_url))
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| RpcFailure::application(format!("无法连接 GSV 转录服务：{error}")))?;
    if !response.status().is_success() {
        return Err(RpcFailure::application(format!(
            "GSV 转录服务返回 HTTP {}",
            response.status()
        )));
    }
    Ok(GsvConnectionTestResult {
        ok: true,
        latency_ms: elapsed_millis(started),
    })
}

pub(crate) async fn local_gsv_role_id(
    client: &reqwest::Client,
    config: &LocalGsvTtsConfig,
) -> Result<String, RpcFailure> {
    if let Some(role_id) = config.role_id.as_ref() {
        return Ok(role_id.clone());
    }
    let response = client
        .get(format!("{}/api/role/list/", config.service_url))
        .query(&[("version", &config.version), ("world_name", &config.world)])
        .send()
        .await
        .map_err(|error| RpcFailure::application(format!("无法连接 GSV 服务：{error}")))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|error| RpcFailure::application(format!("GSV 角色列表响应无效：{error}")))?;
    if !status.is_success() {
        return Err(RpcFailure::application(format!(
            "GSV 角色列表返回 HTTP {status}: {}",
            payload
                .get("detail")
                .or_else(|| payload.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("未知错误")
        )));
    }
    payload
        .get("roles")
        .and_then(Value::as_array)
        .and_then(|roles| {
            roles.iter().find_map(|role| {
                let name = role.get("name")?.as_str()?;
                if name != config.role {
                    return None;
                }
                role.get("id").and_then(|id| match id {
                    Value::String(value) => Some(value.clone()),
                    Value::Number(value) => Some(value.to_string()),
                    _ => None,
                })
            })
        })
        .ok_or_else(|| {
            RpcFailure::application(format!(
                "GSV 未找到角色“{}”（版本：{}，世界：{}）",
                config.role, config.version, config.world
            ))
        })
}

pub(crate) struct SynthesizedGsvAudio {
    pub(crate) blob_id: eden_agent_core::BlobId,
    pub(crate) mime: String,
    pub(crate) duration_ms: Option<i64>,
    pub(crate) size_bytes: i64,
    pub(crate) role_id: String,
}

pub(crate) async fn synthesize_gsv_audio(
    state: &AppState,
    persisted: &GsvTtsConfig,
    text: &str,
) -> Result<SynthesizedGsvAudio, RpcFailure> {
    let config = LocalGsvTtsConfig::from_config(persisted)?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(config.timeout)
        .build()
        .map_err(|error| RpcFailure::application(format!("初始化 GSV 客户端失败：{error}")))?;
    let role_id = local_gsv_role_id(&client, &config).await?;
    let response = client
        .post(format!("{}/api/synthesis/role-emotion", config.service_url))
        .json(&json!({
            "role_id": role_id,
            "emotion": config.emotion,
            "text": text,
            "text_language": gsv_language_code(&config.text_language),
            "version": config.version,
            "speed": config.speed,
            "top_k": config.top_k,
            "top_p": config.top_p,
            "temperature": config.temperature,
            "sample_steps": config.sample_steps,
            "how_to_cut": config.cut_method,
            "pause_second": config.pause_seconds,
            "return_base64": true,
            "if_sr": config.super_resolution,
            "ref_free": config.reference_free,
            "if_freeze": config.freeze,
        }))
        .send()
        .await
        .map_err(|error| RpcFailure::application(format!("GSV 语音合成请求失败：{error}")))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("audio/wav")
        .split(';')
        .next()
        .unwrap_or("audio/wav")
        .trim()
        .to_owned();
    let (mime, audio, duration_ms) = if content_type == "application/json" {
        let payload: Value = response
            .json()
            .await
            .map_err(|error| RpcFailure::application(format!("GSV 合成响应无效：{error}")))?;
        if !status.is_success() || payload.get("success").and_then(Value::as_bool) == Some(false) {
            return Err(RpcFailure::application(
                payload
                    .get("detail")
                    .or_else(|| payload.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("GSV 语音合成失败")
                    .to_owned(),
            ));
        }
        let encoded = payload
            .get("audio_data")
            .and_then(Value::as_str)
            .ok_or_else(|| RpcFailure::application("GSV 合成成功但没有返回音频数据"))?;
        let encoded = encoded.rsplit_once(',').map_or(encoded, |(_, data)| data);
        let bytes = BASE64
            .decode(encoded)
            .map_err(|error| RpcFailure::application(format!("GSV 音频解码失败：{error}")))?;
        let duration_ms = payload
            .get("duration")
            .and_then(Value::as_f64)
            .map(|seconds| (seconds * 1000.0).round() as i64);
        ("audio/wav".to_owned(), bytes, duration_ms)
    } else {
        let bytes = response
            .bytes()
            .await
            .map_err(|error| RpcFailure::application(format!("读取 GSV 音频失败：{error}")))?
            .to_vec();
        if !status.is_success() {
            return Err(RpcFailure::application(format!(
                "GSV 语音合成返回 HTTP {status}"
            )));
        }
        (content_type, bytes, None)
    };
    if audio.is_empty() {
        return Err(RpcFailure::application("GSV 返回了空音频数据"));
    }
    let size_bytes = i64::try_from(audio.len()).unwrap_or(i64::MAX);
    let blob = state
        .blobs
        .put(mime.clone(), &audio)
        .await
        .map_err(|error| RpcFailure::application(error.to_string()))?;
    Ok(SynthesizedGsvAudio {
        blob_id: blob.id,
        mime,
        duration_ms,
        size_bytes,
        role_id,
    })
}

pub(crate) async fn synthesize_local_gsv(
    state: &AppState,
    params: &VoiceTtsSynthesizeParams,
) -> Result<VoiceTtsSynthesizeResult, RpcFailure> {
    let persisted = read_voice_runtime_config(state).await?.tts;
    let audio = synthesize_gsv_audio(state, &persisted, &params.text).await?;
    Ok(VoiceTtsSynthesizeResult {
        success: true,
        audio_url: None,
        audio_blob_id: Some(audio.blob_id),
        text: Some(params.text.clone()),
        cached: Some(false),
        cache_key: None,
        audio_format: Some(
            audio
                .mime
                .strip_prefix("audio/")
                .unwrap_or("wav")
                .to_owned(),
        ),
        duration_ms: audio.duration_ms,
        size_bytes: Some(audio.size_bytes),
        speech_segment_id: None,
        segment_group_id: Some(params.segment_group_id.clone()),
        group_index: Some(params.group_index),
        sequence: Some(params.sequence),
        error_message: None,
    })
}
