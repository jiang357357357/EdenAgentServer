use super::HostServices;
use async_trait::async_trait;
use eden_agent_core::{
    ContentBlock, PermissionRequest, Tool, ToolCall, ToolCallContext, ToolDefinition, ToolFailure,
    ToolOutput,
};
use futures::future::join_all;
use regex::Regex;
use reqwest::{
    Method, StatusCode, Url,
    header::{ACCEPT, AUTHORIZATION, HeaderMap, HeaderName, HeaderValue, LOCATION},
};
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, HashSet},
    env,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

const SEARCH_CACHE_LIMIT: usize = 128;
const RESOURCE_LIMIT: usize = 128;
const MAX_REDIRECTS: usize = 5;

pub(super) struct WebTool(pub(super) HostServices);

pub(super) struct WebRuntime {
    cache: Mutex<HashMap<String, CacheEntry>>,
    resources: Mutex<HashMap<String, ResourceScope>>,
}

#[derive(Clone)]
struct CacheEntry {
    created_at: Instant,
    value: Value,
}

#[derive(Default)]
struct ResourceScope {
    next_search: u64,
    next_page: u64,
    entries: HashMap<String, WebResource>,
}

#[derive(Clone)]
struct WebResource {
    kind: &'static str,
    url: String,
    title: String,
    body: String,
    created_at: Instant,
}

#[derive(Debug)]
struct FetchResponse {
    final_url: Url,
    status: StatusCode,
    content_type: String,
    bytes: Vec<u8>,
    truncated: bool,
}

impl WebRuntime {
    pub(super) fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            resources: Mutex::new(HashMap::new()),
        }
    }

    async fn cache_get(&self, key: &str) -> Option<Value> {
        let ttl = cache_ttl();
        if ttl.is_zero() {
            return None;
        }
        let mut cache = self.cache.lock().await;
        let entry = cache.get(key)?;
        if entry.created_at.elapsed() > ttl {
            cache.remove(key);
            return None;
        }
        let mut value = entry.value.clone();
        value["cached"] = Value::Bool(true);
        Some(value)
    }

    async fn cache_put(&self, key: String, value: Value) {
        if cache_ttl().is_zero() {
            return;
        }
        let mut cache = self.cache.lock().await;
        cache.insert(
            key,
            CacheEntry {
                created_at: Instant::now(),
                value,
            },
        );
        if cache.len() > SEARCH_CACHE_LIMIT {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.created_at)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest);
            }
        }
    }

    async fn put_resource(
        &self,
        scope: &str,
        kind: &'static str,
        url: String,
        title: String,
        body: String,
    ) -> String {
        let mut resources = self.resources.lock().await;
        let resources = resources.entry(scope.to_owned()).or_default();
        let index = if kind == "search" {
            resources.next_search += 1;
            resources.next_search
        } else {
            resources.next_page += 1;
            resources.next_page
        };
        let ref_id = format!("{kind}_{index}");
        resources.entries.insert(
            ref_id.clone(),
            WebResource {
                kind,
                url,
                title,
                body,
                created_at: Instant::now(),
            },
        );
        while resources.entries.len() > RESOURCE_LIMIT {
            if let Some(oldest) = resources
                .entries
                .iter()
                .min_by_key(|(_, value)| value.created_at)
                .map(|(key, _)| key.clone())
            {
                resources.entries.remove(&oldest);
            }
        }
        ref_id
    }

    async fn get_resource(&self, scope: &str, ref_id: &str) -> Result<WebResource, ToolFailure> {
        self.resources
            .lock()
            .await
            .get(scope)
            .and_then(|resources| resources.entries.get(ref_id))
            .cloned()
            .ok_or_else(|| {
                ToolFailure::new(
                    "web_ref_not_found",
                    format!("web reference {ref_id} does not exist in this session"),
                )
            })
    }
}

#[async_trait]
impl Tool for WebTool {
    fn definition(&self) -> ToolDefinition {
        let mut definition = ToolDefinition::direct(
            "web",
            "Search public web providers, open a URL or session reference, or find text in an opened page",
        );
        definition.parameters = json!({
            "type":"object",
            "required":["action"],
            "properties":{
                "action":{"type":"string","enum":["search","open","find"]},
                "query":{"type":"string"},
                "queries":{"type":"array","items":{"type":"string"},"maxItems":4},
                "provider":{"type":"string","enum":["auto","brave","exa","tavily","searxng","bing","duckduckgo"]},
                "max_results":{"type":"integer","minimum":1,"maximum":10},
                "language":{"type":"string"},
                "time_range":{"type":"string","enum":["day","week","month","year"]},
                "domains":{"type":"array","items":{"type":"string"},"maxItems":20},
                "url":{"type":"string"},
                "ref_id":{"type":"string"},
                "pattern":{"type":"string"},
                "max_chars":{"type":"integer","minimum":2000,"maximum":60000}
            },
            "additionalProperties":false
        });
        definition
    }

    fn permission_request(&self, arguments: &Value) -> Option<PermissionRequest> {
        let mut patterns = Vec::new();
        for field in ["url", "ref_id", "query"] {
            if let Some(value) = arguments.get(field).and_then(Value::as_str) {
                if !value.trim().is_empty() {
                    patterns.push(value.trim().to_owned());
                }
            }
        }
        patterns.extend(
            arguments
                .get("queries")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
        );
        Some(PermissionRequest {
            permission: "network.read".to_owned(),
            patterns,
            always: vec![],
        })
    }

    async fn execute(
        &self,
        call: &ToolCall,
        context: ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        match required_text(&call.arguments, "action")?
            .to_ascii_lowercase()
            .as_str()
        {
            "search" => self.search(&call.arguments, &context).await,
            "open" => self.open(&call.arguments, &context).await,
            "find" => self.find(&call.arguments, &context).await,
            _ => Err(ToolFailure::new(
                "invalid_action",
                "action must be search, open, or find",
            )),
        }
    }
}

impl WebTool {
    async fn search(
        &self,
        arguments: &Value,
        context: &ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let mut queries = Vec::new();
        if let Some(query) = arguments.get("query").and_then(Value::as_str) {
            push_unique(&mut queries, query);
        }
        for query in arguments
            .get("queries")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            push_unique(&mut queries, query);
        }
        queries.truncate(4);
        if queries.is_empty() {
            return Err(ToolFailure::new(
                "invalid_query",
                "query or queries must contain at least one search query",
            ));
        }
        let max_results = integer(arguments, "max_results", 5).clamp(1, 10) as usize;
        let language = optional_text(arguments, "language");
        let time_range = optional_text(arguments, "time_range");
        let domains = normalize_domains(arguments.get("domains"));
        let providers = provider_order(optional_text(arguments, "provider").as_deref())?;
        let deadline = Instant::now() + total_timeout("EDEN_AGENT_SEARCH_TOTAL_TIMEOUT_MS", 30_000);
        let runtime = Arc::clone(&self.0.web_runtime);
        let cancellation = context.cancellation.clone();
        let tasks = queries.iter().cloned().map(|query| {
            let runtime = Arc::clone(&runtime);
            let providers = providers.clone();
            let language = language.clone();
            let time_range = time_range.clone();
            let domains = domains.clone();
            let cancellation = cancellation.clone();
            async move {
                let result = search_one(
                    &runtime,
                    &query,
                    max_results,
                    language.as_deref(),
                    time_range.as_deref(),
                    &domains,
                    &providers,
                    deadline,
                    &cancellation,
                )
                .await;
                (query, result)
            }
        });
        let completed = tokio::select! {
            _ = context.cancellation.cancelled() => return Err(cancelled()),
            result = tokio::time::timeout_at(deadline.into(), join_all(tasks)) => {
                result.map_err(|_| ToolFailure::new("timeout", "web search exceeded its total timeout"))?
            }
        };
        let mut successful = Vec::new();
        let mut errors = Map::new();
        for (query, result) in completed {
            match result {
                Ok(result) => successful.push(result),
                Err(error) => {
                    errors.insert(query, Value::String(error.message));
                }
            }
        }
        if successful.is_empty() {
            return Err(ToolFailure::new(
                "search_unavailable",
                format!("all web searches failed: {}", Value::Object(errors)),
            ));
        }
        let mut merged = merge_search_results(&queries, successful, max_results);
        let scope = resource_scope(context);
        if let Some(results) = merged.get_mut("results").and_then(Value::as_array_mut) {
            for result in results {
                let ref_id = runtime
                    .put_resource(
                        &scope,
                        "search",
                        result
                            .get("url")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                        result
                            .get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                        String::new(),
                    )
                    .await;
                result["ref_id"] = Value::String(ref_id);
            }
        }
        merged["query_errors"] = Value::Object(errors);
        let text = render_search_text(&merged);
        Ok(structured_output(text, merged))
    }

    async fn open(
        &self,
        arguments: &Value,
        context: &ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let scope = resource_scope(context);
        let ref_id = optional_text(arguments, "ref_id");
        let url = if let Some(ref_id) = ref_id.as_deref() {
            self.0.web_runtime.get_resource(&scope, ref_id).await?.url
        } else {
            required_text(arguments, "url")?
        };
        let url =
            Url::parse(&url).map_err(|error| ToolFailure::new("invalid_url", error.to_string()))?;
        let deadline = Instant::now() + total_timeout("EDEN_AGENT_FETCH_TOTAL_TIMEOUT_MS", 30_000);
        let fetched = fetch_public(
            Method::GET,
            url,
            HeaderMap::new(),
            None,
            deadline,
            &context.cancellation,
            fetch_max_bytes(),
        )
        .await?;
        if !fetched.status.is_success() {
            return Err(ToolFailure::new(
                "http_error",
                format!("{} returned HTTP {}", fetched.final_url, fetched.status),
            ));
        }
        let decoded = String::from_utf8_lossy(&fetched.bytes);
        let (title, body) = if fetched.content_type.contains("html") {
            extract_html(&decoded)
        } else if fetched.content_type.starts_with("text/")
            || fetched.content_type.contains("json")
            || fetched.content_type.is_empty()
        {
            (String::new(), decoded.into_owned())
        } else {
            return Err(ToolFailure::new(
                "unsupported_content",
                format!("unsupported public content type: {}", fetched.content_type),
            ));
        };
        let max_chars = integer(arguments, "max_chars", 28_000).clamp(2_000, 60_000) as usize;
        let body = truncate_chars(&body, max_chars);
        let page_ref = self
            .0
            .web_runtime
            .put_resource(
                &scope,
                "page",
                fetched.final_url.to_string(),
                title.clone(),
                body.clone(),
            )
            .await;
        let details = json!({
            "action":"open",
            "ref_id":page_ref,
            "final_url":fetched.final_url.to_string(),
            "title":title,
            "content_type":fetched.content_type,
            "bytes":fetched.bytes.len(),
            "response_truncated":fetched.truncated,
            "max_chars":max_chars
        });
        let text = format!(
            "[{}] {}\n\n{}{}",
            details["ref_id"].as_str().unwrap_or("page"),
            details["final_url"].as_str().unwrap_or(""),
            if title.is_empty() {
                String::new()
            } else {
                format!("Title: {title}\n\n")
            },
            body
        );
        Ok(structured_output(text, details))
    }

    async fn find(
        &self,
        arguments: &Value,
        context: &ToolCallContext,
    ) -> Result<ToolOutput, ToolFailure> {
        let ref_id = required_text(arguments, "ref_id")?;
        let pattern = required_text(arguments, "pattern")?;
        let resource = self
            .0
            .web_runtime
            .get_resource(&resource_scope(context), &ref_id)
            .await?;
        if resource.kind != "page" {
            return Err(ToolFailure::new(
                "invalid_web_ref",
                "find only accepts a page reference returned by open",
            ));
        }
        let matcher = regex::RegexBuilder::new(&regex::escape(&pattern))
            .case_insensitive(true)
            .build()
            .map_err(|error| ToolFailure::new("invalid_pattern", error.to_string()))?;
        let mut matches = Vec::new();
        for found in matcher.find_iter(&resource.body) {
            let start = floor_char_boundary(&resource.body, found.start().saturating_sub(180));
            let end = ceil_char_boundary(
                &resource.body,
                found.end().saturating_add(280).min(resource.body.len()),
            );
            let excerpt = collapse_whitespace(&resource.body[start..end]);
            if !matches.contains(&excerpt) {
                matches.push(excerpt);
            }
            if matches.len() >= 10 {
                break;
            }
        }
        let mut text = format!(
            "Found {} matches for {pattern:?} in [{ref_id}] {}",
            matches.len(),
            resource.title
        );
        for (index, excerpt) in matches.iter().enumerate() {
            text.push_str(&format!("\n\n[{}] {excerpt}", index + 1));
        }
        Ok(structured_output(
            text,
            json!({"action":"find","ref_id":ref_id,"pattern":pattern,"matches":matches}),
        ))
    }
}

#[allow(clippy::too_many_arguments)]
async fn search_one(
    runtime: &WebRuntime,
    query: &str,
    max_results: usize,
    language: Option<&str>,
    time_range: Option<&str>,
    domains: &[String],
    providers: &[String],
    deadline: Instant,
    cancellation: &CancellationToken,
) -> Result<Value, ToolFailure> {
    let key = serde_json::to_string(&json!({
        "query":query,"max_results":max_results,"language":language,
        "time_range":time_range,"domains":domains,"providers":providers
    }))
    .unwrap_or_default();
    if let Some(value) = runtime.cache_get(&key).await {
        return Ok(value);
    }
    let mut attempts = Vec::new();
    for provider in providers {
        if Instant::now() >= deadline {
            return Err(ToolFailure::new(
                "timeout",
                "web search exceeded its total timeout",
            ));
        }
        match provider_search(
            provider,
            query,
            max_results,
            language,
            time_range,
            domains,
            deadline,
            cancellation,
        )
        .await
        {
            Ok(results) if !results.is_empty() => {
                let value = json!({
                    "provider":provider,"query":query,"results":results,
                    "attempts":attempts,"cached":false
                });
                runtime.cache_put(key, value.clone()).await;
                return Ok(value);
            }
            Ok(_) => attempts.push(json!({"provider":provider,"error":"no usable results"})),
            Err(error) => attempts.push(json!({"provider":provider,"error":error.message})),
        }
    }
    Err(ToolFailure::new(
        "search_unavailable",
        format!(
            "all configured search providers failed: {}",
            Value::Array(attempts)
        ),
    ))
}

#[allow(clippy::too_many_arguments)]
async fn provider_search(
    provider: &str,
    query: &str,
    max_results: usize,
    language: Option<&str>,
    time_range: Option<&str>,
    domains: &[String],
    deadline: Instant,
    cancellation: &CancellationToken,
) -> Result<Vec<Value>, ToolFailure> {
    let (method, url, headers, body) =
        provider_request(provider, query, max_results, language, time_range, domains)?;
    let response = fetch_public(
        method,
        url,
        headers,
        body,
        deadline.min(Instant::now() + provider_timeout()),
        cancellation,
        2_000_000,
    )
    .await?;
    if !response.status.is_success() {
        return Err(ToolFailure::new(
            "provider_http_error",
            format!("{provider} returned HTTP {}", response.status),
        ));
    }
    let text = String::from_utf8_lossy(&response.bytes);
    let raw = match provider {
        "bing" => parse_bing_html(&text),
        "duckduckgo" => parse_duck_html(&text),
        _ => {
            let payload: Value = serde_json::from_slice(&response.bytes).map_err(|error| {
                ToolFailure::new("provider_decode_failed", format!("{provider}: {error}"))
            })?;
            provider_json_results(provider, &payload)
        }
    };
    Ok(normalize_results(provider, query, raw, max_results))
}

fn provider_request(
    provider: &str,
    query: &str,
    max_results: usize,
    language: Option<&str>,
    time_range: Option<&str>,
    domains: &[String],
) -> Result<(Method, Url, HeaderMap, Option<Value>), ToolFailure> {
    let mut headers = HeaderMap::new();
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("application/json, text/html;q=0.9"),
    );
    let domain_query = if domains.is_empty() {
        query.to_owned()
    } else {
        format!(
            "{} {}",
            query,
            domains
                .iter()
                .map(|domain| format!("site:{domain}"))
                .collect::<Vec<_>>()
                .join(" OR ")
        )
    };
    match provider {
        "brave" => {
            let key = env_key(&["BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY"])?;
            headers.insert(
                HeaderName::from_static("x-subscription-token"),
                header_value(&key)?,
            );
            let mut url = provider_url(
                &["EDEN_AGENT_BRAVE_SEARCH_URL"],
                Some("https://api.search.brave.com/res/v1/web/search"),
            )?;
            url.query_pairs_mut()
                .append_pair("q", &domain_query)
                .append_pair("count", &max_results.to_string());
            if let Some(language) = language {
                url.query_pairs_mut().append_pair("search_lang", language);
            }
            if let Some(time_range) = time_range {
                let freshness = match time_range {
                    "day" => "pd",
                    "week" => "pw",
                    "month" => "pm",
                    "year" => "py",
                    value => value,
                };
                url.query_pairs_mut().append_pair("freshness", freshness);
            }
            Ok((Method::GET, url, headers, None))
        }
        "exa" => {
            let key = env_key(&["EXA_API_KEY"])?;
            headers.insert(HeaderName::from_static("x-api-key"), header_value(&key)?);
            Ok((
                Method::POST,
                provider_url(
                    &["EDEN_AGENT_EXA_SEARCH_URL"],
                    Some("https://api.exa.ai/search"),
                )?,
                headers,
                Some(json!({
                    "query":query,"numResults":max_results,"type":"auto","useAutoprompt":true,
                    "includeDomains":domains
                })),
            ))
        }
        "tavily" => Ok((
            Method::POST,
            provider_url(
                &["EDEN_AGENT_TAVILY_SEARCH_URL"],
                Some("https://api.tavily.com/search"),
            )?,
            headers,
            Some(json!({
                "api_key":env_key(&["TAVILY_API_KEY"])? ,"query":query,
                "max_results":max_results,"include_domains":domains,"time_range":time_range
            })),
        )),
        "searxng" => {
            let mut url = provider_url(&["EDEN_AGENT_SEARXNG_URL", "SEARXNG_URL"], None)?;
            url.set_path(&format!("{}/search", url.path().trim_end_matches('/')));
            url.query_pairs_mut()
                .append_pair("q", &domain_query)
                .append_pair("format", "json")
                .append_pair("categories", "general");
            if let Some(language) = language {
                url.query_pairs_mut().append_pair("language", language);
            }
            if let Some(time_range) = time_range {
                url.query_pairs_mut().append_pair("time_range", time_range);
            }
            Ok((Method::GET, url, headers, None))
        }
        "bing" => {
            let mut url = provider_url(
                &["EDEN_AGENT_BING_SEARCH_URL"],
                Some("https://www.bing.com/search"),
            )?;
            url.query_pairs_mut()
                .append_pair("q", &domain_query)
                .append_pair("count", &max_results.to_string());
            Ok((Method::GET, url, headers, None))
        }
        "duckduckgo" => {
            let mut url = provider_url(
                &["EDEN_AGENT_DUCKDUCKGO_PROXY"],
                Some("https://html.duckduckgo.com/html/"),
            )?;
            url.query_pairs_mut().append_pair("q", &domain_query);
            Ok((Method::GET, url, headers, None))
        }
        _ => Err(ToolFailure::new(
            "unknown_search_provider",
            format!("unknown search provider: {provider}"),
        )),
    }
}

fn provider_json_results(provider: &str, payload: &Value) -> Vec<Value> {
    match provider {
        "brave" => payload
            .pointer("/web/results")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        _ => payload
            .get("results")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    }
}

fn normalize_results(
    provider: &str,
    query: &str,
    raw: Vec<Value>,
    max_results: usize,
) -> Vec<Value> {
    let query_terms = search_terms(query);
    let mut candidates = raw
        .into_iter()
        .enumerate()
        .filter_map(|(index, value)| {
            let title = first_text(&value, &["title", "name"])?;
            let raw_url = first_text(&value, &["url", "link"])?;
            let mut url = Url::parse(&raw_url).ok()?;
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
                || obvious_blocked_host(url.host_str()?)
            {
                return None;
            }
            url.set_fragment(None);
            let snippet = first_text(&value, &["description", "snippet", "content", "text"])
                .or_else(|| {
                    value
                        .get("highlights")
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                })
                .unwrap_or_default();
            let published_at = first_text(
                &value,
                &["published_at", "publishedDate", "published_date", "date"],
            );
            let relevance = relevance_score(&title, &snippet, &query_terms)
                + value.get("score").and_then(Value::as_f64).unwrap_or(0.0) * 10.0
                - index as f64 * 0.01;
            let item_provider = value
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or(provider);
            Some((
                relevance,
                json!({
                    "title":collapse_whitespace(&strip_tags(&decode_entities(&title))),
                    "url":url.to_string(),
                    "snippet":truncate_chars(&collapse_whitespace(&strip_tags(&decode_entities(&snippet))), 1200),
                    "hostname":url.host_str().unwrap_or(""),
                    "provider":item_provider,
                    "published_at":published_at,
                    "score":value.get("score").cloned().unwrap_or(Value::Null)
                }),
            ))
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .0
            .partial_cmp(&left.0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut seen_urls = HashSet::new();
    let mut seen_titles = HashSet::new();
    let mut host_counts: HashMap<String, usize> = HashMap::new();
    let mut results = Vec::new();
    for (_, mut item) in candidates {
        let url = item["url"]
            .as_str()
            .unwrap_or("")
            .trim_end_matches('/')
            .to_owned();
        let title = search_key(item["title"].as_str().unwrap_or(""));
        let host = item["hostname"].as_str().unwrap_or("").to_owned();
        if !seen_urls.insert(url) || (!title.is_empty() && !seen_titles.insert(title)) {
            continue;
        }
        let count = host_counts.entry(host).or_default();
        if *count >= 2 {
            continue;
        }
        *count += 1;
        let source = format!("source_{}", results.len() + 1);
        item["id"] = Value::String(source.clone());
        item["source_id"] = Value::String(source);
        results.push(item);
        if results.len() >= max_results {
            break;
        }
    }
    results
}

fn merge_search_results(queries: &[String], searches: Vec<Value>, max_results: usize) -> Value {
    let cached = searches.iter().all(|value| value["cached"] == true);
    let providers = searches
        .iter()
        .filter_map(|value| value.get("provider").and_then(Value::as_str))
        .fold(Vec::<String>::new(), |mut values, provider| {
            if !values.iter().any(|value| value == provider) {
                values.push(provider.to_owned());
            }
            values
        });
    let raw = searches
        .iter()
        .flat_map(|value| {
            value
                .get("results")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    let merged_query = queries.join(" | ");
    let mut results = normalize_results("multi", &merged_query, raw, max_results);
    for (index, result) in results.iter_mut().enumerate() {
        let source = format!("source_{}", index + 1);
        result["id"] = Value::String(source.clone());
        result["source_id"] = Value::String(source);
    }
    json!({
        "action":"search",
        "provider":if providers.len() == 1 { providers[0].clone() } else { "multi".to_owned() },
        "providers":providers,"query":merged_query,"queries":queries,"results":results,"cached":cached
    })
}

async fn fetch_public(
    mut method: Method,
    mut url: Url,
    mut headers: HeaderMap,
    mut body: Option<Value>,
    deadline: Instant,
    cancellation: &CancellationToken,
    max_bytes: usize,
) -> Result<FetchResponse, ToolFailure> {
    for redirect in 0..=MAX_REDIRECTS {
        if Instant::now() >= deadline {
            return Err(ToolFailure::new("timeout", "public HTTP request timed out"));
        }
        let (host, address) = resolve_public_target(&url, deadline, cancellation).await?;
        let remaining = deadline.saturating_duration_since(Instant::now());
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(remaining.min(Duration::from_secs(10)))
            .timeout(remaining)
            .user_agent("Eden Agent/1.8")
            .resolve(&host, address)
            .build()
            .map_err(|error| ToolFailure::new("fetch_failed", error.to_string()))?;
        let mut request = client
            .request(method.clone(), url.clone())
            .headers(headers.clone());
        if let Some(payload) = &body {
            request = request.json(payload);
        }
        let response = tokio::select! {
            _ = cancellation.cancelled() => return Err(cancelled()),
            result = request.send() => result.map_err(|error| ToolFailure::new("fetch_failed", error.to_string()))?,
        };
        if response.status().is_redirection() {
            if redirect == MAX_REDIRECTS {
                return Err(ToolFailure::new(
                    "redirect_limit",
                    "too many public HTTP redirects",
                ));
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    ToolFailure::new("invalid_redirect", "redirect has no valid Location")
                })?;
            let next = url
                .join(location)
                .map_err(|error| ToolFailure::new("invalid_redirect", error.to_string()))?;
            if origin(&url) != origin(&next) {
                headers.remove(AUTHORIZATION);
                headers.remove(HeaderName::from_static("x-api-key"));
                headers.remove(HeaderName::from_static("x-subscription-token"));
            }
            if response.status() == StatusCode::SEE_OTHER
                || ((response.status() == StatusCode::MOVED_PERMANENTLY
                    || response.status() == StatusCode::FOUND)
                    && method == Method::POST)
            {
                method = Method::GET;
                body = None;
            }
            url = next;
            continue;
        }
        let status = response.status();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let final_url = response.url().clone();
        let mut response = response;
        let mut bytes = Vec::new();
        let mut truncated = false;
        loop {
            let chunk = tokio::select! {
                _ = cancellation.cancelled() => return Err(cancelled()),
                result = response.chunk() => result.map_err(|error| ToolFailure::new("fetch_failed", error.to_string()))?,
            };
            let Some(chunk) = chunk else { break };
            let remaining = max_bytes.saturating_sub(bytes.len());
            if chunk.len() > remaining {
                bytes.extend_from_slice(&chunk[..remaining]);
                truncated = true;
                break;
            }
            bytes.extend_from_slice(&chunk);
            if bytes.len() >= max_bytes {
                truncated = true;
                break;
            }
        }
        return Ok(FetchResponse {
            final_url,
            status,
            content_type,
            bytes,
            truncated,
        });
    }
    unreachable!("redirect loop always returns")
}

async fn resolve_public_target(
    url: &Url,
    deadline: Instant,
    cancellation: &CancellationToken,
) -> Result<(String, SocketAddr), ToolFailure> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(blocked_url());
    }
    let host = url
        .host_str()
        .ok_or_else(blocked_url)?
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if obvious_blocked_host(&host) {
        return Err(blocked_url());
    }
    let port = url.port_or_known_default().ok_or_else(blocked_url)?;
    let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::select! {
            _ = cancellation.cancelled() => return Err(cancelled()),
            result = tokio::time::timeout_at(deadline.into(), tokio::net::lookup_host((host.as_str(), port))) => {
                result
                    .map_err(|_| ToolFailure::new("timeout", "DNS lookup exceeded the web operation timeout"))?
                    .map_err(|error| ToolFailure::new("dns_failed", error.to_string()))?
                    .collect::<Vec<_>>()
            }
        }
    };
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(blocked_url());
    }
    Ok((host, addresses[0]))
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 224)
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if let Some(ipv4) = ip.to_ipv4_mapped() {
        return is_public_ipv4(ipv4);
    }
    let segments = ip.segments();
    (segments[0] & 0xe000) == 0x2000
        && !(ip.is_unspecified()
            || ip.is_loopback()
            || ip.is_multicast()
            || (segments[0] & 0xfe00) == 0xfc00
            || (segments[0] & 0xffc0) == 0xfe80
            || (segments[0] & 0xffc0) == 0xfec0
            || (segments[0] == 0x2001
                && matches!(segments[1], 0x0000 | 0x0002 | 0x0010..=0x002f | 0x0db8))
            || segments[0] == 0x2002)
}

fn obvious_blocked_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.parse::<IpAddr>().is_ok_and(|ip| !is_public_ip(ip))
}

fn provider_order(requested: Option<&str>) -> Result<Vec<String>, ToolFailure> {
    let configured = requested
        .filter(|value| !value.trim().is_empty() && *value != "auto")
        .map(str::to_owned)
        .or_else(|| env::var("EDEN_AGENT_SEARCH_PROVIDER").ok())
        .unwrap_or_else(|| "auto".to_owned());
    if configured.trim().eq_ignore_ascii_case("auto") {
        let mut order = Vec::new();
        if has_env(&["BRAVE_SEARCH_API_KEY", "BRAVE_API_KEY"]) {
            order.push("brave".to_owned());
        }
        if has_env(&["EXA_API_KEY"]) {
            order.push("exa".to_owned());
        }
        if has_env(&["TAVILY_API_KEY"]) {
            order.push("tavily".to_owned());
        }
        if has_env(&["EDEN_AGENT_SEARXNG_URL", "SEARXNG_URL"]) {
            order.push("searxng".to_owned());
        }
        order.extend(["bing".to_owned(), "duckduckgo".to_owned()]);
        return Ok(order);
    }
    let aliases = [("ddg", "duckduckgo"), ("searx", "searxng")];
    let mut order = Vec::new();
    for value in configured
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let value = aliases
            .iter()
            .find(|(alias, _)| *alias == value)
            .map_or(value, |(_, canonical)| *canonical);
        if !matches!(
            value,
            "brave" | "exa" | "tavily" | "searxng" | "bing" | "duckduckgo"
        ) {
            return Err(ToolFailure::new(
                "unknown_search_provider",
                format!("unknown search provider: {value}"),
            ));
        }
        if !order.iter().any(|existing| existing == value) {
            order.push(value.to_owned());
        }
    }
    if order.is_empty() {
        return Err(ToolFailure::new(
            "unknown_search_provider",
            "no search provider selected",
        ));
    }
    Ok(order)
}

fn parse_duck_html(html: &str) -> Vec<Value> {
    let link = Regex::new(
        r#"(?is)<a[^>]*class=[\"'][^\"']*result__a[^\"']*[\"'][^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>"#,
    )
    .expect("duck regex");
    link.captures_iter(html)
        .filter_map(|capture| {
            let raw_url = decode_entities(capture.get(1)?.as_str());
            let url = normalize_duck_url(&raw_url)?;
            Some(json!({"title":capture.get(2)?.as_str(),"url":url}))
        })
        .collect()
}

fn parse_bing_html(html: &str) -> Vec<Value> {
    let result = Regex::new(
        r#"(?is)<li[^>]*class=[\"'][^\"']*b_algo[^\"']*[\"'][^>]*>.*?<h2[^>]*>\s*<a[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>.*?</li>"#,
    )
    .expect("bing regex");
    result
        .captures_iter(html)
        .filter_map(|capture| {
            Some(json!({"title":capture.get(2)?.as_str(),"url":capture.get(1)?.as_str()}))
        })
        .collect()
}

fn normalize_duck_url(value: &str) -> Option<String> {
    let url = Url::parse(value)
        .or_else(|_| Url::parse(&format!("https://duckduckgo.com{value}")))
        .ok()?;
    if url
        .host_str()
        .is_some_and(|host| host.ends_with("duckduckgo.com"))
    {
        if let Some(target) = url
            .query_pairs()
            .find(|(key, _)| key == "uddg")
            .map(|(_, value)| value.into_owned())
        {
            return Some(target);
        }
    }
    Some(url.to_string())
}

fn extract_html(html: &str) -> (String, String) {
    let title = Regex::new(r"(?is)<title[^>]*>(.*?)</title>")
        .expect("title regex")
        .captures(html)
        .and_then(|capture| capture.get(1))
        .map(|value| collapse_whitespace(&decode_entities(&strip_tags(value.as_str()))))
        .unwrap_or_default();
    let mut body = Regex::new(
        r"(?is)<(?:script|style|noscript|svg|template)[^>]*>.*?</(?:script|style|noscript|svg|template)\s*>",
    )
    .expect("unsafe HTML regex")
    .replace_all(html, " ")
    .into_owned();
    body =
        Regex::new(r"(?i)<br\s*/?>|</(p|div|section|article|header|footer|h[1-6]|li|tr|ul|ol)\s*>")
            .expect("block regex")
            .replace_all(&body, "\n")
            .into_owned();
    body = strip_tags(&body);
    body = decode_entities(&body);
    let lines = body
        .lines()
        .map(collapse_whitespace)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    (title, lines.join("\n\n"))
}

fn strip_tags(value: &str) -> String {
    Regex::new(r"(?is)<[^>]+>")
        .expect("tag regex")
        .replace_all(value, " ")
        .into_owned()
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn first_text(value: &Value, fields: &[&str]) -> Option<String> {
    fields.iter().find_map(|field| {
        value
            .get(*field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    })
}

fn search_terms(query: &str) -> Vec<String> {
    query
        .split(|value: char| !value.is_alphanumeric())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn relevance_score(title: &str, snippet: &str, terms: &[String]) -> f64 {
    let title = title.to_lowercase();
    let snippet = snippet.to_lowercase();
    terms
        .iter()
        .map(|term| {
            if title.contains(term) {
                10.0
            } else if snippet.contains(term) {
                2.0
            } else {
                0.0
            }
        })
        .sum()
}

fn search_key(value: &str) -> String {
    value
        .chars()
        .filter(|value| value.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn normalize_domains(value: Option<&Value>) -> Vec<String> {
    let mut domains = Vec::new();
    for value in value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let value = value.trim().trim_matches('.').to_ascii_lowercase();
        let host = Url::parse(&value)
            .ok()
            .and_then(|url| url.host_str().map(str::to_owned))
            .or_else(|| {
                Url::parse(&format!("http://{value}"))
                    .ok()
                    .and_then(|url| url.host_str().map(str::to_owned))
            })
            .unwrap_or(value);
        if valid_domain(&host) && !domains.contains(&host) {
            domains.push(host);
        }
        if domains.len() >= 20 {
            break;
        }
    }
    domains
}

fn valid_domain(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && !obvious_blocked_host(value)
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .chars()
                    .all(|value| value.is_ascii_alphanumeric() || value == '-')
        })
}

fn render_search_text(result: &Value) -> String {
    let mut text = format!(
        "Web search results for: {}",
        result.get("query").and_then(Value::as_str).unwrap_or("")
    );
    for item in result
        .get("results")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        text.push_str(&format!(
            "\n\n[{}] {}\nURL: {}\nProvider: {}{}",
            item.get("ref_id")
                .and_then(Value::as_str)
                .unwrap_or("source"),
            item.get("title").and_then(Value::as_str).unwrap_or(""),
            item.get("url").and_then(Value::as_str).unwrap_or(""),
            item.get("provider").and_then(Value::as_str).unwrap_or(""),
            item.get("snippet")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(|value| format!("\nSummary: {value}"))
                .unwrap_or_default()
        ));
    }
    text
}

fn structured_output(text: String, details: Value) -> ToolOutput {
    ToolOutput {
        content: vec![ContentBlock::Text { text }],
        structured_content: Some(details.clone()),
        details,
        ..ToolOutput::default()
    }
}

fn resource_scope(context: &ToolCallContext) -> String {
    context
        .session_id
        .clone()
        .or_else(|| {
            context
                .metadata
                .get("operationId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "unbound".to_owned())
}

fn required_text(arguments: &Value, name: &str) -> Result<String, ToolFailure> {
    optional_text(arguments, name).ok_or_else(|| {
        ToolFailure::new(
            "invalid_arguments",
            format!("{name} must be a non-empty string"),
        )
    })
}

fn optional_text(arguments: &Value, name: &str) -> Option<String> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn integer(arguments: &Value, name: &str, default: i64) -> i64 {
    arguments
        .get(name)
        .and_then(Value::as_i64)
        .unwrap_or(default)
}

fn push_unique(values: &mut Vec<String>, value: &str) {
    let value = collapse_whitespace(value);
    if !value.is_empty() && !values.contains(&value) {
        values.push(value);
    }
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(value: &str, maximum: usize) -> String {
    if value.chars().count() <= maximum {
        value.to_owned()
    } else {
        format!(
            "{}\n…[truncated]",
            value.chars().take(maximum).collect::<String>()
        )
    }
}

fn floor_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while index < value.len() && !value.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn total_timeout(name: &str, default_ms: u64) -> Duration {
    Duration::from_millis(env_u64(name, default_ms).clamp(1_000, 120_000))
}

fn provider_timeout() -> Duration {
    Duration::from_millis(env_u64("EDEN_AGENT_SEARCH_TIMEOUT_MS", 10_000).clamp(1_000, 60_000))
}

fn cache_ttl() -> Duration {
    Duration::from_secs(env_u64("EDEN_AGENT_SEARCH_CACHE_TTL_SECONDS", 120).min(3_600))
}

fn fetch_max_bytes() -> usize {
    usize::try_from(env_u64("EDEN_AGENT_FETCH_MAX_BYTES", 1_000_000).clamp(64_000, 8_000_000))
        .unwrap_or(1_000_000)
}

fn env_u64(name: &str, default: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}

fn has_env(names: &[&str]) -> bool {
    names.iter().any(|name| {
        env::var(name)
            .ok()
            .is_some_and(|value| !value.trim().is_empty())
    })
}

fn env_key(names: &[&str]) -> Result<String, ToolFailure> {
    names
        .iter()
        .find_map(|name| env::var(name).ok().filter(|value| !value.trim().is_empty()))
        .ok_or_else(|| {
            ToolFailure::new(
                "provider_not_configured",
                format!("missing configuration: {}", names.join(" or ")),
            )
        })
}

fn provider_url(names: &[&str], default: Option<&str>) -> Result<Url, ToolFailure> {
    let configured = names
        .iter()
        .find_map(|name| env::var(name).ok().filter(|value| !value.trim().is_empty()))
        .or_else(|| default.map(str::to_owned))
        .ok_or_else(|| {
            ToolFailure::new(
                "provider_not_configured",
                format!("missing provider URL: {}", names.join(" or ")),
            )
        })?;
    Url::parse(&configured)
        .map_err(|error| ToolFailure::new("invalid_provider_url", error.to_string()))
}

fn header_value(value: &str) -> Result<HeaderValue, ToolFailure> {
    HeaderValue::from_str(value).map_err(|_| {
        ToolFailure::new(
            "invalid_provider_key",
            "provider key is not a valid header value",
        )
    })
}

fn origin(url: &Url) -> (String, Option<u16>, String) {
    (
        url.scheme().to_owned(),
        url.port_or_known_default(),
        url.host_str().unwrap_or("").to_ascii_lowercase(),
    )
}

fn blocked_url() -> ToolFailure {
    ToolFailure::new(
        "blocked_url",
        "only public HTTP(S) targets are allowed; local, private and special-use networks are blocked",
    )
}

fn cancelled() -> ToolFailure {
    ToolFailure::new("cancelled", "web operation was cancelled")
}

#[cfg(test)]
mod tests {
    use super::*;
    use eden_agent_core::event_channel;

    #[test]
    fn rejects_private_and_special_use_addresses() {
        for value in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "192.0.2.1",
            "198.51.100.1",
            "203.0.113.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
        ] {
            assert!(!is_public_ip(value.parse().expect("IP")), "{value}");
        }
        assert!(is_public_ip("93.184.216.34".parse().expect("public IP")));
        assert!(is_public_ip(
            "2606:4700:4700::1111".parse().expect("public IP")
        ));
    }

    #[test]
    fn structured_results_are_ranked_deduplicated_and_host_limited() {
        let results = normalize_results(
            "test",
            "Eden Agent Rust",
            vec![
                json!({"title":"Loose result","url":"https://one.example/loose"}),
                json!({"title":"Eden Agent Rust guide","url":"https://one.example/guide#part","description":"exact"}),
                json!({"title":"Eden Agent Rust guide","url":"https://mirror.example/duplicate"}),
                json!({"title":"Second","url":"https://one.example/second"}),
                json!({"title":"Third","url":"https://one.example/third"}),
            ],
            10,
        );
        assert_eq!(results[0]["url"], "https://one.example/guide");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["source_id"], "source_1");
    }

    #[test]
    fn html_extraction_removes_active_content_and_keeps_structure() {
        let (title, body) = extract_html(
            "<html><head><title> Test Doc </title><style>bad</style></head><body><h1>Title</h1><script>evil()</script><p>First paragraph.</p><ul><li>Item</li></ul></body></html>",
        );
        assert_eq!(title, "Test Doc");
        assert!(!body.contains("evil"));
        assert!(!body.contains("bad"));
        assert!(body.contains("Title"));
        assert!(body.contains("First paragraph."));
    }

    #[tokio::test]
    async fn references_are_session_scoped_and_bounded() {
        let runtime = WebRuntime::new();
        let first = runtime
            .put_resource(
                "session-a",
                "page",
                "https://example.com".to_owned(),
                "Example".to_owned(),
                "body".to_owned(),
            )
            .await;
        assert_eq!(first, "page_1");
        assert!(runtime.get_resource("session-a", &first).await.is_ok());
        assert!(runtime.get_resource("session-b", &first).await.is_err());
    }

    #[tokio::test]
    async fn cache_returns_an_isolated_cached_copy() {
        let runtime = WebRuntime::new();
        runtime
            .cache_put("key".to_owned(), json!({"cached":false,"results":[]}))
            .await;
        let mut first = runtime.cache_get("key").await.expect("cache hit");
        assert_eq!(first["cached"], true);
        first["results"] = json!([{"changed":true}]);
        assert_eq!(
            runtime.cache_get("key").await.expect("second hit")["results"],
            json!([])
        );
    }

    #[tokio::test]
    async fn public_fetch_honors_cancellation_and_total_deadline_before_connecting() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let error = fetch_public(
            Method::GET,
            Url::parse("http://93.184.216.34/").expect("URL"),
            HeaderMap::new(),
            None,
            Instant::now() + Duration::from_secs(5),
            &cancellation,
            1024,
        )
        .await
        .expect_err("cancelled");
        assert_eq!(error.info.code, "cancelled");

        let error = fetch_public(
            Method::GET,
            Url::parse("http://93.184.216.34/").expect("URL"),
            HeaderMap::new(),
            None,
            Instant::now(),
            &CancellationToken::new(),
            1024,
        )
        .await
        .expect_err("deadline");
        assert_eq!(error.info.code, "timeout");
    }

    #[test]
    fn unicode_domains_are_normalized_to_ascii_and_private_domains_are_removed() {
        assert_eq!(
            normalize_domains(Some(&json!(["例子.测试", "localhost", "192.168.1.1"]))),
            vec!["xn--fsqu00a.xn--0zwm56d"]
        );
    }

    #[test]
    fn duck_redirect_urls_are_normalized() {
        assert_eq!(
            normalize_duck_url("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs")
                .as_deref(),
            Some("https://example.com/docs")
        );
    }

    #[test]
    fn html_provider_results_are_parsed_into_the_same_schema() {
        let duck = parse_duck_html(
            r#"<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example &amp; Docs</a>"#,
        );
        let bing = parse_bing_html(
            r#"<li class="b_algo"><h2><a href="https://example.org/page">Example Page</a></h2></li>"#,
        );
        for (provider, raw) in [("duckduckgo", duck), ("bing", bing)] {
            let normalized = normalize_results(provider, "Example", raw, 5);
            assert_eq!(normalized.len(), 1);
            assert_eq!(normalized[0]["provider"], provider);
            assert_eq!(normalized[0]["source_id"], "source_1");
        }
    }

    #[tokio::test]
    async fn find_uses_session_page_references_with_unicode_safe_offsets() {
        let host = HostServices::new(
            eden_agent_store::Store::in_memory().await.expect("store"),
            None,
            None,
        )
        .expect("host");
        let ref_id = host
            .web_runtime
            .put_resource(
                "session-a",
                "page",
                "https://example.com/docs".to_owned(),
                "文档".to_owned(),
                "这里包含统一网页工具，并且前后都是中文字符。".to_owned(),
            )
            .await;
        let (events, _receiver) = event_channel(8);
        let output = WebTool(host)
            .execute(
                &ToolCall {
                    id: "find".to_owned(),
                    name: "web".to_owned(),
                    arguments: json!({"action":"find","ref_id":ref_id,"pattern":"统一网页"}),
                },
                ToolCallContext {
                    cancellation: CancellationToken::new(),
                    events,
                    session_id: Some("session-a".to_owned()),
                    metadata: json!({}),
                },
            )
            .await
            .expect("find");
        assert_eq!(
            output.details["matches"].as_array().expect("matches").len(),
            1
        );
    }
}
