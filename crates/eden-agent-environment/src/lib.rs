use chrono::{Datelike, Duration, FixedOffset, Local, NaiveDate, Utc, Weekday};
use chrono_tz::Tz;
use serde_json::{Value, json};

const LUNAR_MONTH_NAMES: [&str; 12] = [
    "正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "冬月", "腊月",
];
const LUNAR_DAY_NAMES: [&str; 30] = [
    "初一", "初二", "初三", "初四", "初五", "初六", "初七", "初八", "初九", "初十", "十一", "十二",
    "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "廿一", "廿二", "廿三", "廿四",
    "廿五", "廿六", "廿七", "廿八", "廿九", "三十",
];

// Common Chinese lunar-calendar encoding for 1900–2100: the low four bits
// identify the leap month and the high bits contain month lengths.
const LUNAR_INFO: [u32; 201] = [
    0x04BD8, 0x04AE0, 0x0A570, 0x054D5, 0x0D260, 0x0D950, 0x16554, 0x056A0, 0x09AD0, 0x055D2,
    0x04AE0, 0x0A5B6, 0x0A4D0, 0x0D250, 0x1D255, 0x0B540, 0x0D6A0, 0x0ADA2, 0x095B0, 0x14977,
    0x04970, 0x0A4B0, 0x0B4B5, 0x06A50, 0x06D40, 0x1AB54, 0x02B60, 0x09570, 0x052F2, 0x04970,
    0x06566, 0x0D4A0, 0x0EA50, 0x06E95, 0x05AD0, 0x02B60, 0x186E3, 0x092E0, 0x1C8D7, 0x0C950,
    0x0D4A0, 0x1D8A6, 0x0B550, 0x056A0, 0x1A5B4, 0x025D0, 0x092D0, 0x0D2B2, 0x0A950, 0x0B557,
    0x06CA0, 0x0B550, 0x15355, 0x04DA0, 0x0A5D0, 0x14573, 0x052D0, 0x0A9A8, 0x0E950, 0x06AA0,
    0x0AEA6, 0x0AB50, 0x04B60, 0x0AAE4, 0x0A570, 0x05260, 0x0F263, 0x0D950, 0x05B57, 0x056A0,
    0x096D0, 0x04DD5, 0x04AD0, 0x0A4D0, 0x0D4D4, 0x0D250, 0x0D558, 0x0B540, 0x0B6A0, 0x195A6,
    0x095B0, 0x049B0, 0x0A974, 0x0A4B0, 0x0B27A, 0x06A50, 0x06D40, 0x0AF46, 0x0AB60, 0x09570,
    0x04AF5, 0x04970, 0x064B0, 0x074A3, 0x0EA50, 0x06B58, 0x055C0, 0x0AB60, 0x096D5, 0x092E0,
    0x0C960, 0x0D954, 0x0D4A0, 0x0DA50, 0x07552, 0x056A0, 0x0ABB7, 0x025D0, 0x092D0, 0x0CAB5,
    0x0A950, 0x0B4A0, 0x0BAA4, 0x0AD50, 0x055D9, 0x04BA0, 0x0A5B0, 0x15176, 0x052B0, 0x0A930,
    0x07954, 0x06AA0, 0x0AD50, 0x05B52, 0x04B60, 0x0A6E6, 0x0A4E0, 0x0D260, 0x0EA65, 0x0D530,
    0x05AA0, 0x076A3, 0x096D0, 0x04BD7, 0x04AD0, 0x0A4D0, 0x1D0B6, 0x0D250, 0x0D520, 0x0DD45,
    0x0B5A0, 0x056D0, 0x055B2, 0x049B0, 0x0A577, 0x0A4B0, 0x0AA50, 0x1B255, 0x06D20, 0x0ADA0,
    0x14B63, 0x09370, 0x049F8, 0x04970, 0x064B0, 0x168A6, 0x0EA50, 0x06B20, 0x1A6C4, 0x0AAE0,
    0x0A2E0, 0x0D2E3, 0x0C960, 0x0D557, 0x0D4A0, 0x0DA50, 0x05D55, 0x056A0, 0x0A6D0, 0x055D4,
    0x052D0, 0x0A9B8, 0x0A950, 0x0B4A0, 0x0B6A6, 0x0AD50, 0x055A0, 0x0ABA4, 0x0A5B0, 0x052B0,
    0x0B273, 0x06930, 0x07337, 0x06AA0, 0x0AD50, 0x14B55, 0x04B60, 0x0A570, 0x054E4, 0x0D160,
    0x0E968, 0x0D520, 0x0DAA0, 0x16AA6, 0x056D0, 0x04AE0, 0x0A9D4, 0x0A2D0, 0x0D150, 0x0F252,
    0x0D520,
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LunarDate {
    year: i32,
    month: u32,
    day: u32,
    is_leap_month: bool,
}

#[must_use]
pub fn current_time_context(environment: &Value) -> Value {
    let timezone = text(environment, "timezone").unwrap_or_default();
    let utc = Utc::now();
    let (local_time, utc_offset) = if let Ok(parsed) = timezone.parse::<Tz>() {
        let local = utc.with_timezone(&parsed);
        (local.to_rfc3339(), local.format("%:z").to_string())
    } else if let Some(offset) = timezone_offset(&timezone) {
        let local = utc.with_timezone(&offset);
        (local.to_rfc3339(), local.format("%:z").to_string())
    } else {
        let local = Local::now();
        (local.to_rfc3339(), local.format("%:z").to_string())
    };
    json!({
        "utcTime":utc.to_rfc3339(),
        "localTime":local_time,
        "utcOffset":utc_offset,
        "timezone":if timezone.is_empty() { Value::Null } else { json!(timezone) },
    })
}

pub fn calendar_context(arguments: &Value, environment: &Value) -> Result<(String, Value), String> {
    let timezone = text(arguments, "timezone")
        .or_else(|| text(environment, "timezone"))
        .unwrap_or_default();
    let locale = text(arguments, "locale")
        .or_else(|| text(environment, "locale"))
        .unwrap_or_else(|| "zh-CN".to_owned());
    let date = match text(arguments, "date") {
        Some(value) => parse_date(&value)?,
        None => current_date(&timezone),
    };
    let nearby_days = arguments
        .get("nearbyDays")
        .or_else(|| arguments.get("nearby_days"))
        .and_then(Value::as_i64)
        .unwrap_or(30)
        .clamp(1, 90);
    let lunar = to_lunar(date);
    let festivals = festival_items(date, lunar);
    let nearby = nearby_festivals(date, nearby_days);
    let lunar_value = lunar.map(lunar_value).unwrap_or(Value::Null);
    let context = json!({
        "date":date.format("%Y-%m-%d").to_string(),
        "weekday":weekday_text(date.weekday(), &locale),
        "is_weekend":matches!(date.weekday(), Weekday::Sat | Weekday::Sun),
        "lunar":lunar_value,
        "festivals":festivals,
        "holidays":festivals,
        "nearby_festivals":nearby,
        "timezone":if timezone.is_empty() { Value::Null } else { json!(timezone) },
        "source":"local_calendar_rules",
        "note":"包含常见公历/农历节日；不包含年度法定调休表。",
    });
    Ok((calendar_summary(&context), context))
}

fn parse_date(value: &str) -> Result<NaiveDate, String> {
    let date = value.trim().get(..10).unwrap_or(value.trim());
    NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|error| format!("invalid date: {error}"))
}

fn current_date(timezone: &str) -> NaiveDate {
    timezone
        .parse::<Tz>()
        .ok()
        .map(|timezone| Utc::now().with_timezone(&timezone).date_naive())
        .or_else(|| {
            timezone_offset(timezone).map(|offset| Utc::now().with_timezone(&offset).date_naive())
        })
        .unwrap_or_else(|| Local::now().date_naive())
}

fn timezone_offset(value: &str) -> Option<FixedOffset> {
    let value = value.trim();
    let seconds = match value {
        "UTC" | "Etc/UTC" | "GMT" => 0,
        _ => parse_offset(value)?,
    };
    FixedOffset::east_opt(seconds)
}

fn parse_offset(value: &str) -> Option<i32> {
    let value = value
        .strip_prefix("UTC")
        .or_else(|| value.strip_prefix("GMT"))
        .unwrap_or(value);
    let (sign, value) = match value.as_bytes().first()? {
        b'+' => (1, &value[1..]),
        b'-' => (-1, &value[1..]),
        _ => return None,
    };
    let (hours, minutes) = value.split_once(':').unwrap_or((value, "0"));
    let hours = hours.parse::<i32>().ok()?;
    let minutes = minutes.parse::<i32>().ok()?;
    (hours <= 23 && minutes <= 59).then_some(sign * (hours * 3600 + minutes * 60))
}

fn lunar_year_days(year: i32) -> i64 {
    let info = lunar_info(year);
    let mut days = 348;
    let mut bit = 0x8000;
    while bit > 0x8 {
        if info & bit != 0 {
            days += 1;
        }
        bit >>= 1;
    }
    days + lunar_leap_days(year)
}

fn lunar_info(year: i32) -> u32 {
    LUNAR_INFO[(year - 1900) as usize]
}

fn lunar_leap_month(year: i32) -> u32 {
    lunar_info(year) & 0xF
}

fn lunar_leap_days(year: i32) -> i64 {
    if lunar_leap_month(year) == 0 {
        0
    } else if lunar_info(year) & 0x10000 != 0 {
        30
    } else {
        29
    }
}

fn lunar_month_days(year: i32, month: u32) -> i64 {
    if lunar_info(year) & (0x10000 >> month) != 0 {
        30
    } else {
        29
    }
}

fn to_lunar(target: NaiveDate) -> Option<LunarDate> {
    let start = NaiveDate::from_ymd_opt(1900, 1, 31)?;
    let end = NaiveDate::from_ymd_opt(2100, 12, 31)?;
    if target < start || target > end {
        return None;
    }
    let mut offset = target.signed_duration_since(start).num_days();
    let mut year = 1900;
    while year <= 2100 {
        let days = lunar_year_days(year);
        if offset < days {
            break;
        }
        offset -= days;
        year += 1;
    }
    if year > 2100 {
        return None;
    }
    let leap_month = lunar_leap_month(year);
    let mut month = 1_u32;
    let mut is_leap = false;
    while month <= 12 {
        let days = if is_leap {
            lunar_leap_days(year)
        } else {
            lunar_month_days(year, month)
        };
        if offset < days {
            break;
        }
        offset -= days;
        if leap_month == month && !is_leap {
            is_leap = true;
        } else {
            is_leap = false;
            month += 1;
        }
    }
    Some(LunarDate {
        year,
        month,
        day: u32::try_from(offset + 1).ok()?,
        is_leap_month: is_leap,
    })
}

fn lunar_value(lunar: LunarDate) -> Value {
    let month = LUNAR_MONTH_NAMES
        .get((lunar.month.saturating_sub(1)) as usize)
        .copied()
        .unwrap_or("未知月");
    let day = LUNAR_DAY_NAMES
        .get((lunar.day.saturating_sub(1)) as usize)
        .copied()
        .unwrap_or("未知日");
    json!({
        "year":lunar.year,
        "month":lunar.month,
        "day":lunar.day,
        "is_leap_month":lunar.is_leap_month,
        "text":format!("{}{month}{day}", if lunar.is_leap_month { "闰" } else { "" }),
    })
}

fn festival_items(target: NaiveDate, lunar: Option<LunarDate>) -> Vec<Value> {
    let mut items = Vec::new();
    let solar = match (target.month(), target.day()) {
        (1, 1) => Some("元旦"),
        (2, 14) => Some("情人节"),
        (3, 8) => Some("妇女节"),
        (3, 12) => Some("植树节"),
        (4, 1) => Some("愚人节"),
        (5, 1) => Some("劳动节"),
        (5, 4) => Some("青年节"),
        (6, 1) => Some("儿童节"),
        (7, 1) => Some("建党节"),
        (8, 1) => Some("建军节"),
        (9, 10) => Some("教师节"),
        (10, 1) => Some("国庆节"),
        (12, 24) => Some("平安夜"),
        (12, 25) => Some("圣诞节"),
        _ => None,
    };
    if let Some(name) = solar {
        items.push(festival(name, "solar", target, None));
    }
    let ordinal = ((target.day() - 1) / 7) + 1;
    if target.month() == 5 && target.weekday() == Weekday::Sun && ordinal == 2 {
        items.push(festival("母亲节", "weekday", target, None));
    }
    if target.month() == 6 && target.weekday() == Weekday::Sun && ordinal == 3 {
        items.push(festival("父亲节", "weekday", target, None));
    }
    if let Some(lunar) = lunar {
        let name = match (lunar.month, lunar.day) {
            (1, 1) => Some("春节"),
            (1, 15) => Some("元宵节"),
            (2, 2) => Some("龙抬头"),
            (5, 5) => Some("端午节"),
            (7, 7) => Some("七夕"),
            (7, 15) => Some("中元节"),
            (8, 15) => Some("中秋节"),
            (9, 9) => Some("重阳节"),
            (12, 8) => Some("腊八节"),
            (12, 23) => Some("北方小年"),
            (12, 24) => Some("南方小年"),
            _ => None,
        };
        if let Some(name) = name {
            items.push(festival(name, "lunar", target, Some(lunar)));
        }
        if lunar.month == 12
            && to_lunar(target + Duration::days(1))
                .is_some_and(|next| next.month == 1 && next.day == 1)
        {
            items.push(festival("除夕", "lunar", target, Some(lunar)));
        }
    }
    items
}

fn festival(name: &str, kind: &str, date: NaiveDate, lunar: Option<LunarDate>) -> Value {
    let mut value = json!({
        "name":name,
        "type":kind,
        "date":date.format("%Y-%m-%d").to_string(),
    });
    if let Some(lunar) = lunar {
        value["lunar"] = lunar_value(lunar);
    }
    value
}

fn nearby_festivals(target: NaiveDate, days: i64) -> Vec<Value> {
    let mut items = Vec::new();
    for offset in 1..=days.clamp(1, 90) {
        let date = target + Duration::days(offset);
        for mut item in festival_items(date, to_lunar(date)) {
            item["days_until"] = json!(offset);
            items.push(item);
            if items.len() == 8 {
                return items;
            }
        }
    }
    items
}

fn calendar_summary(context: &Value) -> String {
    let mut lines = vec![format!(
        "日期：{} {}",
        context.get("date").and_then(Value::as_str).unwrap_or("-"),
        context
            .get("weekday")
            .and_then(Value::as_str)
            .unwrap_or("-")
    )];
    lines.push(format!(
        "周末：{}",
        if context.get("is_weekend").and_then(Value::as_bool) == Some(true) {
            "是"
        } else {
            "否"
        }
    ));
    if let Some(lunar) = context
        .get("lunar")
        .and_then(|value| value.get("text"))
        .and_then(Value::as_str)
    {
        lines.push(format!("农历：{lunar}"));
    }
    let festivals = context
        .get("festivals")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    lines.push(format!(
        "当天节日：{}",
        if festivals.is_empty() {
            "无".to_owned()
        } else {
            festivals.join("、")
        }
    ));
    if let Some(nearby) = context.get("nearby_festivals").and_then(Value::as_array)
        && !nearby.is_empty()
    {
        lines.push("近期节日：".to_owned());
        for item in nearby.iter().take(5) {
            lines.push(format!(
                "- {} {}（{} 天后）",
                item.get("date").and_then(Value::as_str).unwrap_or("-"),
                item.get("name").and_then(Value::as_str).unwrap_or("-"),
                item.get("days_until").and_then(Value::as_i64).unwrap_or(0),
            ));
        }
    }
    lines.join("\n")
}

fn weekday_text(weekday: Weekday, locale: &str) -> String {
    if locale.to_ascii_lowercase().starts_with("zh") {
        match weekday {
            Weekday::Mon => "星期一",
            Weekday::Tue => "星期二",
            Weekday::Wed => "星期三",
            Weekday::Thu => "星期四",
            Weekday::Fri => "星期五",
            Weekday::Sat => "星期六",
            Weekday::Sun => "星期日",
        }
        .to_owned()
    } else {
        match weekday {
            Weekday::Mon => "Monday",
            Weekday::Tue => "Tuesday",
            Weekday::Wed => "Wednesday",
            Weekday::Thu => "Thursday",
            Weekday::Fri => "Friday",
            Weekday::Sat => "Saturday",
            Weekday::Sun => "Sunday",
        }
        .to_owned()
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_time_uses_the_session_iana_timezone() {
        let value = current_time_context(&json!({"timezone":"Asia/Shanghai"}));
        assert_eq!(value["timezone"], "Asia/Shanghai");
        assert!(
            value["localTime"]
                .as_str()
                .expect("local time")
                .ends_with("+08:00")
        );
        assert_eq!(value["utcOffset"], "+08:00");
    }

    #[test]
    fn calendar_restores_lunar_and_nearby_festival_context() {
        let (summary, value) = calendar_context(
            &json!({"date":"2024-02-10","locale":"zh-CN","nearbyDays":30}),
            &json!({"timezone":"Asia/Shanghai"}),
        )
        .expect("calendar");
        assert_eq!(value["lunar"]["month"], 1);
        assert_eq!(value["lunar"]["day"], 1);
        assert!(
            value["festivals"]
                .as_array()
                .expect("festivals")
                .iter()
                .any(|item| item["name"] == "春节")
        );
        assert!(summary.contains("农历：正月初一"));
    }

    #[test]
    fn calendar_validates_dates_and_clamps_the_search_window() {
        assert!(calendar_context(&json!({"date":"not-a-date"}), &json!({})).is_err());
        let (_, value) =
            calendar_context(&json!({"date":"2026-09-30","nearbyDays":999}), &json!({}))
                .expect("calendar");
        assert!(
            value["nearby_festivals"]
                .as_array()
                .expect("nearby")
                .iter()
                .any(|item| item["name"] == "国庆节" && item["days_until"] == 1)
        );
    }

    #[test]
    fn calendar_never_indexes_beyond_the_supported_lunar_table() {
        let (_, value) =
            calendar_context(&json!({"date":"2100-12-31"}), &json!({})).expect("calendar");
        assert_eq!(value["date"], "2100-12-31");
    }
}
