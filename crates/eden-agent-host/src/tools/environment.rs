use crate::{HostServices, support::structured_output};
use async_trait::async_trait;
use eden_agent_core::{Tool, ToolCall, ToolCallContext, ToolDefinition, ToolFailure, ToolOutput};
use eden_agent_domain::SessionId;
use reqwest::{Client, Url};
use serde_json::{Value, json};
use std::sync::Arc;

struct EnvironmentTool {
    host: HostServices,
    weather: bool,
}

#[async_trait]
impl Tool for EnvironmentTool {
    fn definition(&self) -> ToolDefinition {
        if self.weather {
            let mut value = ToolDefinition::direct(
                "get_weather",
                "查询城市或经纬度的当前天气与最多七天预报；参数为空时使用会话环境地点",
            );
            value.parameters = json!({
                "type":"object",
                "properties":{
                    "city":{"type":"string"},
                    "location":{"type":"string","description":"city 的兼容别名"},
                    "country":{"type":"string"},
                    "latitude":{"type":"number","minimum":-90,"maximum":90},
                    "longitude":{"type":"number","minimum":-180,"maximum":180},
                    "days":{"type":"integer","minimum":1,"maximum":7}
                }
            });
            value
        } else {
            let mut value = ToolDefinition::direct(
                "get_calendar_context",
                "查询本地日期、星期、周末、农历、当天节日与近期节日；不包含年度法定调休表",
            );
            value.parameters = json!({
                "type":"object",
                "properties":{
                    "date":{"type":"string","description":"ISO 日期；为空时按会话时区使用今天"},
                    "timezone":{"type":"string"},
                    "locale":{"type":"string"},
                    "nearbyDays":{"type":"integer","minimum":1,"maximum":90}
                }
            });
            value
        }
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let environment = match context
            .session_id
            .as_deref()
            .and_then(|value| value.parse::<SessionId>().ok())
        {
            Some(session_id) => self
                .host
                .store
                .get_session(session_id)
                .await
                .map(|session| session.environment)
                .unwrap_or_else(|_| json!({})),
            None => json!({}),
        };
        if !self.weather {
            let (summary, value) =
                eden_agent_environment::calendar_context(&call.arguments, &environment)
                    .map_err(|error| ToolFailure::new("invalid_calendar", error))?;
            return Ok(structured_output(summary, value));
        }
        let (summary, value) = weather_context(
            &self.host.web,
            &call.arguments,
            &environment,
            &context.cancellation,
        )
        .await?;
        Ok(structured_output(summary, value))
    }
}

pub(crate) async fn weather_context(
    client: &Client,
    arguments: &Value,
    environment: &Value,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<(String, Value), ToolFailure> {
    let environment_location = environment
        .get("location")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let explicit_city =
        argument_text(arguments, "city").or_else(|| argument_text(arguments, "location"));
    let city = explicit_city
        .clone()
        .or_else(|| argument_text(&environment_location, "city"))
        .or_else(|| argument_text(&environment_location, "district"))
        .unwrap_or_default();
    let country = argument_text(arguments, "country")
        .or_else(|| argument_text(&environment_location, "country"))
        .unwrap_or_default();
    let explicit_latitude = arguments.get("latitude").and_then(Value::as_f64);
    let explicit_longitude = arguments.get("longitude").and_then(Value::as_f64);
    if explicit_latitude.is_some() != explicit_longitude.is_some() {
        return Err(ToolFailure::new(
            "incomplete_coordinates",
            "latitude 和 longitude 必须成对提供",
        ));
    }
    let (mut latitude, mut longitude) = if explicit_latitude.is_some() {
        (explicit_latitude, explicit_longitude)
    } else if explicit_city.is_none() {
        (
            environment_location.get("latitude").and_then(Value::as_f64),
            environment_location
                .get("longitude")
                .and_then(Value::as_f64),
        )
    } else {
        (None, None)
    };
    let locale = argument_text(environment, "locale").unwrap_or_else(|| "zh-CN".to_owned());
    let mut timezone = argument_text(environment, "timezone");
    let mut location = json!({
        "name":city,
        "city":city,
        "district":if explicit_city.is_none() { environment_location.get("district").cloned().unwrap_or(Value::Null) } else { Value::Null },
        "region":environment_location.get("region").cloned().unwrap_or(Value::Null),
        "country":country,
        "latitude":latitude,
        "longitude":longitude,
        "timezone":timezone,
    });
    if latitude.is_none() || longitude.is_none() {
        if city.trim().is_empty() {
            return Err(ToolFailure::new(
                "weather_location_required",
                "天气查询需要 city 或经纬度；也可以先在用户环境中保存地点",
            ));
        }
        let mut url = Url::parse("https://geocoding-api.open-meteo.com/v1/search")
            .expect("static Open-Meteo geocoding URL");
        {
            let mut query = url.query_pairs_mut();
            let country_code = country.trim();
            let search_name = if country_code.is_empty()
                || (country_code.len() == 2
                    && country_code
                        .chars()
                        .all(|value| value.is_ascii_alphabetic()))
            {
                city.clone()
            } else {
                format!("{city}, {country_code}")
            };
            query
                .append_pair("name", &search_name)
                .append_pair("count", "1")
                .append_pair(
                    "language",
                    if locale.to_ascii_lowercase().starts_with("zh") {
                        "zh"
                    } else {
                        "en"
                    },
                )
                .append_pair("format", "json");
            if country_code.len() == 2
                && country_code
                    .chars()
                    .all(|value| value.is_ascii_alphabetic())
            {
                query.append_pair("countryCode", &country_code.to_ascii_uppercase());
            }
        }
        let result = request_weather_json(client, url, cancellation).await?;
        let geocoded = result
            .get("results")
            .and_then(Value::as_array)
            .and_then(|results| results.first())
            .filter(|value| value.is_object())
            .ok_or_else(|| {
                ToolFailure::new(
                    "weather_location_not_found",
                    format!("未找到城市天气位置: {city}"),
                )
            })?;
        latitude = geocoded.get("latitude").and_then(Value::as_f64);
        longitude = geocoded.get("longitude").and_then(Value::as_f64);
        timezone = timezone.or_else(|| argument_text(geocoded, "timezone"));
        location = json!({
            "name":geocoded.get("name"),
            "city":geocoded.get("name"),
            "district":"",
            "region":geocoded.get("admin1"),
            "country":geocoded.get("country"),
            "latitude":latitude,
            "longitude":longitude,
            "timezone":timezone,
        });
    }
    let latitude = latitude
        .filter(|value| (-90.0..=90.0).contains(value))
        .ok_or_else(|| {
            ToolFailure::new("invalid_latitude", "天气查询缺少 -90 到 90 之间的有效纬度")
        })?;
    let longitude = longitude
        .filter(|value| (-180.0..=180.0).contains(value))
        .ok_or_else(|| {
            ToolFailure::new(
                "invalid_longitude",
                "天气查询缺少 -180 到 180 之间的有效经度",
            )
        })?;
    location["latitude"] = json!(latitude);
    location["longitude"] = json!(longitude);
    let days = arguments
        .get("days")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(1, 7);
    let mut url = Url::parse("https://api.open-meteo.com/v1/forecast")
        .expect("static Open-Meteo forecast URL");
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("latitude", &format!("{latitude:.6}"))
            .append_pair("longitude", &format!("{longitude:.6}"))
            .append_pair(
                "current",
                "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m",
            )
            .append_pair(
                "daily",
                "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum",
            )
            .append_pair("forecast_days", &days.to_string())
            .append_pair("timezone", timezone.as_deref().unwrap_or("auto"));
    }
    let endpoint = url.to_string();
    let forecast = request_weather_json(client, url, cancellation).await?;
    let context = json!({
        "provider":"open-meteo",
        "location":location,
        "current":forecast.get("current").cloned().unwrap_or_else(||json!({})),
        "daily":forecast.get("daily").cloned().unwrap_or_else(||json!({})),
        "endpoint":endpoint,
    });
    Ok((weather_summary(&context), context))
}

async fn request_weather_json(
    client: &Client,
    url: Url,
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<Value, ToolFailure> {
    let send = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send();
    let response = tokio::select! {
        _ = cancellation.cancelled() => {
            return Err(ToolFailure::new("cancelled", "天气查询已取消"));
        }
        response = send => response,
    }
    .map_err(|error| ToolFailure::new("weather_failed", error.to_string()))?;
    let status = response.status();
    let bytes = tokio::select! {
        _ = cancellation.cancelled() => {
            return Err(ToolFailure::new("cancelled", "天气查询已取消"));
        }
        bytes = response.bytes() => bytes,
    }
    .map_err(|error| ToolFailure::new("weather_failed", error.to_string()))?;
    if !status.is_success() {
        return Err(ToolFailure::new(
            "weather_failed",
            format!(
                "Open-Meteo returned {status}: {}",
                String::from_utf8_lossy(&bytes)
                    .chars()
                    .take(500)
                    .collect::<String>()
            ),
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|error| ToolFailure::new("weather_failed", error.to_string()))
}

pub(crate) fn weather_summary(context: &Value) -> String {
    let empty = Value::Null;
    let location = context.get("location").unwrap_or(&empty);
    let label = ["district", "city", "region", "country"]
        .iter()
        .filter_map(|key| location.get(key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .fold(Vec::<String>::new(), |mut values, value| {
            if !values.iter().any(|existing| existing == value) {
                values.push(value.to_owned());
            }
            values
        })
        .join(" · ");
    let current = context.get("current").unwrap_or(&empty);
    let mut lines = vec![format!(
        "天气：{}",
        if label.is_empty() {
            "未命名位置"
        } else {
            &label
        }
    )];
    lines.push(format!(
        "当前：{}，{}°C，体感 {}°C，湿度 {}%，降水 {}mm，风速 {}km/h",
        weather_code_text(current.get("weather_code")),
        display_value(current.get("temperature_2m")),
        display_value(current.get("apparent_temperature")),
        display_value(current.get("relative_humidity_2m")),
        display_value(current.get("precipitation")),
        display_value(current.get("wind_speed_10m")),
    ));
    if let Some(daily) = context.get("daily").filter(|value| value.is_object()) {
        let dates = daily.get("time").and_then(Value::as_array);
        if let Some(dates) = dates
            && !dates.is_empty()
        {
            lines.push(String::new());
            lines.push("预报：".to_owned());
            for (index, date) in dates.iter().take(7).enumerate() {
                lines.push(format!(
                    "{} {} {}-{}°C 降水 {}mm",
                    display_value(Some(date)),
                    weather_code_text(array_item(daily, "weather_code", index)),
                    display_value(array_item(daily, "temperature_2m_min", index)),
                    display_value(array_item(daily, "temperature_2m_max", index)),
                    display_value(array_item(daily, "precipitation_sum", index)),
                ));
            }
        }
    }
    lines.join("\n")
}

fn array_item<'a>(value: &'a Value, key: &str, index: usize) -> Option<&'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .and_then(|items| items.get(index))
}

fn display_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Number(value)) => value.to_string(),
        Some(value) if !value.is_null() => value.to_string(),
        _ => "-".to_owned(),
    }
}

fn weather_code_text(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_i64) {
        Some(0) => "晴朗",
        Some(1) => "大部晴朗",
        Some(2) => "局部多云",
        Some(3) => "阴",
        Some(45) => "雾",
        Some(48) => "雾凇",
        Some(51 | 53 | 55) => "毛毛雨",
        Some(56 | 57) => "冻毛毛雨",
        Some(61 | 63 | 65) => "雨",
        Some(66 | 67) => "冻雨",
        Some(71 | 73 | 75 | 77) => "雪",
        Some(80..=82) => "阵雨",
        Some(85 | 86) => "阵雪",
        Some(95 | 96 | 99) => "雷暴",
        _ => "未知天气",
    }
}

fn argument_text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(super) fn tools(host: HostServices) -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(EnvironmentTool {
            host: host.clone(),
            weather: false,
        }),
        Arc::new(EnvironmentTool {
            host,
            weather: true,
        }),
    ]
}
