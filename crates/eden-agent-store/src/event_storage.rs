use super::*;
use std::collections::{BTreeMap, HashMap};

const MAX_DELTA_DEPTH: usize = 63;

/// Owned by one message stream. State advances only after a successful commit.
#[derive(Default)]
pub struct StreamEventWriter {
    previous: Option<EventRecord>,
    delta_depth: usize,
}

// Tagged patches avoid confusing user-provided JSON with storage instructions.
#[derive(Serialize, Deserialize)]
enum Patch {
    Replace(Value),
    Append(String),
    Object(BTreeMap<String, Patch>, Vec<String>),
    Array(BTreeMap<usize, Patch>, usize),
}

impl Patch {
    fn between(old: &Value, new: &Value) -> Self {
        match (old, new) {
            (Value::String(old), Value::String(new)) if new.starts_with(old) => {
                Self::Append(new[old.len()..].to_owned())
            }
            (Value::Object(old), Value::Object(new)) => Self::Object(
                new.iter()
                    .filter(|(key, value)| old.get(*key) != Some(value))
                    .map(|(key, value)| {
                        (
                            key.clone(),
                            old.get(key).map_or_else(
                                || Self::Replace(value.clone()),
                                |old| Self::between(old, value),
                            ),
                        )
                    })
                    .collect(),
                old.keys()
                    .filter(|key| !new.contains_key(*key))
                    .cloned()
                    .collect(),
            ),
            (Value::Array(old), Value::Array(new)) => Self::Array(
                new.iter()
                    .enumerate()
                    .filter(|(index, value)| old.get(*index) != Some(value))
                    .map(|(index, value)| {
                        (
                            index,
                            old.get(index).map_or_else(
                                || Self::Replace(value.clone()),
                                |old| Self::between(old, value),
                            ),
                        )
                    })
                    .collect(),
                new.len(),
            ),
            _ => Self::Replace(new.clone()),
        }
    }

    fn apply(self, value: &mut Value) -> Result<(), StoreError> {
        let invalid = || StoreError::InvalidValue("invalid event payload patch".into());
        match self {
            Self::Replace(next) => *value = next,
            Self::Append(suffix) => {
                let Value::String(text) = value else {
                    return Err(invalid());
                };
                text.push_str(&suffix);
            }
            Self::Object(changes, removed) => {
                let object = value.as_object_mut().ok_or_else(invalid)?;
                for key in removed {
                    object.remove(&key);
                }
                for (key, patch) in changes {
                    patch.apply(object.entry(key).or_insert(Value::Null))?;
                }
            }
            Self::Array(changes, len) => {
                let array = value.as_array_mut().ok_or_else(invalid)?;
                array.resize(len, Value::Null);
                for (index, patch) in changes {
                    patch.apply(array.get_mut(index).ok_or_else(invalid)?)?;
                }
            }
        }
        Ok(())
    }
}

impl StreamEventWriter {
    pub async fn append(
        &mut self,
        store: &Store,
        session_id: SessionId,
        turn_id: Option<TurnId>,
        payload: Value,
    ) -> Result<EventRecord, StoreError> {
        let stored = if self.delta_depth < MAX_DELTA_DEPTH {
            self.previous
                .as_ref()
                .filter(|event| event.session_id == session_id && event.turn_id == turn_id)
                .map(|previous| -> Result<_, StoreError> {
                    let patch =
                        serde_json::to_string(&Patch::between(&previous.payload, &payload))?;
                    let full = serde_json::to_string(&payload)?;
                    Ok((patch.len() < full.len()).then_some((previous.seq, patch)))
                })
                .transpose()?
                .flatten()
        } else {
            None
        };
        // Bound random-access replay work, trading some storage for predictable pages.
        let next_depth = if stored.is_some() {
            self.delta_depth + 1
        } else {
            0
        };
        let mut transaction = store.pool.begin_with("BEGIN IMMEDIATE").await?;
        ensure_session(&mut transaction, session_id).await?;
        let event = append_event_storage_tx(
            &mut transaction,
            session_id,
            turn_id,
            "agent.message_update",
            payload,
            stored,
        )
        .await?;
        transaction.commit().await?;
        let _ = store.events.send(event.clone());
        self.previous = Some(event.clone());
        self.delta_depth = next_depth;
        Ok(event)
    }
}

impl Store {
    pub(super) async fn read_event_storage(
        &self,
        session_id: SessionId,
        after_seq: i64,
        limit: Option<usize>,
    ) -> Result<Vec<EventRecord>, StoreError> {
        // Include dependencies in the same SQLite snapshot, including when a page
        // begins in the middle of a stream. UNION deduplicates shared ancestors.
        let rows = sqlx::query(
            "WITH RECURSIVE wanted AS (
                SELECT seq FROM session_events WHERE session_id = ?1 AND seq > ?2
                ORDER BY seq LIMIT ?3
             ), required(seq) AS (
                SELECT seq FROM wanted
                UNION
                SELECT e.payload_base_seq FROM session_events e JOIN required r ON e.seq = r.seq
                WHERE e.session_id = ?1 AND e.payload_base_seq IS NOT NULL
                  AND e.payload_base_seq < e.seq
             )
             SELECT e.id, e.session_id, e.seq, e.turn_id, e.event_type, e.payload_json,
                    e.created_at, e.payload_base_seq, e.seq IN (SELECT seq FROM wanted) AS wanted
             FROM session_events e JOIN required r ON e.seq = r.seq
             WHERE e.session_id = ?1 ORDER BY e.seq",
        )
        .bind(session_id.to_string())
        .bind(after_seq)
        .bind(limit.map_or(-1, |limit| limit as i64))
        .fetch_all(&self.pool)
        .await?;
        let mut uses = HashMap::<i64, usize>::new();
        for row in &rows {
            if let Some(base) = row.try_get::<Option<i64>, _>("payload_base_seq")? {
                *uses.entry(base).or_default() += 1;
            }
        }
        let mut bases = HashMap::<i64, Value>::new();
        let mut result = Vec::new();
        for row in rows {
            let mut event = event_from_row(&row)?;
            if let Some(base) = row.try_get::<Option<i64>, _>("payload_base_seq")? {
                let remaining = uses.get_mut(&base).expect("dependency counted above");
                *remaining -= 1;
                let mut payload = if *remaining == 0 {
                    bases.remove(&base)
                } else {
                    bases.get(&base).cloned()
                }
                .ok_or_else(|| {
                    StoreError::InvalidValue(format!("missing event payload base {base}"))
                })?;
                serde_json::from_value::<Patch>(event.payload)?.apply(&mut payload)?;
                event.payload = payload;
            }
            let wanted = row.try_get::<bool, _>("wanted")?;
            if uses.contains_key(&event.seq) {
                if !wanted {
                    bases.insert(event.seq, event.payload);
                    continue;
                }
                bases.insert(event.seq, event.payload.clone());
            }
            if wanted {
                result.push(event);
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patches_preserve_unicode_structural_changes_and_stream_resets() {
        let values = [
            json!({"content":[{"type":"text","text":"你好🌱"}],"extra":null}),
            json!({"content":[{"type":"text","text":"你好🌱世界"},{"type":"toolCall","arguments":{"a":1}}]}),
            json!({"content":[{"type":"thinking","thinking":"重新开始"}],"extra":{"Append":"user data"}}),
            json!({"content":[],"extra":false}),
        ];
        for pair in values.windows(2) {
            let encoded = serde_json::to_string(&Patch::between(&pair[0], &pair[1])).unwrap();
            let mut decoded = pair[0].clone();
            serde_json::from_str::<Patch>(&encoded)
                .unwrap()
                .apply(&mut decoded)
                .unwrap();
            assert_eq!(decoded, pair[1]);
        }
    }

    #[tokio::test]
    async fn long_stream_pages_have_bounded_dependencies() {
        let store = Store::in_memory().await.unwrap();
        let session = store.create_session("long stream").await.unwrap();
        let mut writer = StreamEventWriter::default();
        let mut last = None;
        for index in 0..1025 {
            last = Some(
                writer
                    .append(
                        &store,
                        session.id,
                        None,
                        json!({"message":{"content":"x".repeat(2048 + index)}}),
                    )
                    .await
                    .unwrap(),
            );
        }
        let depths: Vec<i64> = sqlx::query_scalar(
            "WITH RECURSIVE depths(seq, depth) AS (
                SELECT seq, 0 FROM session_events WHERE session_id=?1 AND payload_base_seq IS NULL
                UNION ALL SELECT e.seq, d.depth+1 FROM session_events e JOIN depths d ON e.payload_base_seq=d.seq
                WHERE e.session_id=?1
             ) SELECT depth FROM depths",
        ).bind(session.id.to_string()).fetch_all(&store.pool).await.unwrap();
        assert_eq!(depths.len(), 1025);
        assert!(depths.iter().copied().max().unwrap() <= MAX_DELTA_DEPTH as i64);
        let last = last.unwrap();
        let page = store
            .list_event_page(session.id, last.seq - 1, 1)
            .await
            .unwrap();
        assert_eq!(page.items, vec![last]);
        assert!(!page.has_more);
    }

    #[tokio::test]
    async fn compact_streams_replay_exactly_after_reopen_and_across_page_boundaries() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("stream.db");
        let store = Store::open(&path).await.unwrap();
        let session = store.create_session("stream").await.unwrap();
        let other = store.create_session("other").await.unwrap();
        let mut subscriber = store.subscribe();
        let mut writer = StreamEventWriter::default();
        let mut other_writer = StreamEventWriter::default();
        let mut expected = Vec::new();
        for index in 1..=130 {
            let payload = json!({"message":{"role":"assistant","content":[{"type":"text","text":"你好🌱".repeat(index * 16)}]},"delta":"你好🌱".repeat(16)});
            let event = writer
                .append(&store, session.id, None, payload)
                .await
                .unwrap();
            assert_eq!(subscriber.recv().await.unwrap(), event);
            expected.push(event);
            if index % 9 == 0 {
                let event = store
                    .append_event(
                        session.id,
                        None,
                        "character.action.changed",
                        json!({"action":index}),
                    )
                    .await
                    .unwrap();
                assert_eq!(subscriber.recv().await.unwrap(), event);
                expected.push(event);
            }
            let other_event = other_writer
                .append(
                    &store,
                    other.id,
                    None,
                    json!({"message":"other".repeat(index)}),
                )
                .await
                .unwrap();
            assert_eq!(subscriber.recv().await.unwrap(), other_event);
        }
        let stored_bytes: i64 = sqlx::query_scalar(
            "SELECT SUM(length(CAST(payload_json AS BLOB))) FROM session_events WHERE session_id=?",
        )
        .bind(session.id.to_string())
        .fetch_one(&store.pool)
        .await
        .unwrap();
        let full_bytes: usize = expected
            .iter()
            .map(|event| serde_json::to_vec(&event.payload).unwrap().len())
            .sum();
        assert!(
            (stored_bytes as usize) < full_bytes / 5,
            "stored={stored_bytes}, full={full_bytes}"
        );
        eprintln!("stream payload bytes: full={full_bytes}, encoded={stored_bytes}");
        drop(writer);
        drop(other_writer);
        drop(subscriber);
        drop(store);
        let store = Store::open(&path).await.unwrap();
        assert_eq!(store.list_events(session.id, 0).await.unwrap(), expected);
        // A dependency may precede the requested page by many stream updates.
        for offset in [2, 7, 63, 96, 127, 130] {
            let after = expected[offset].seq;
            assert_eq!(
                store.list_events(session.id, after).await.unwrap(),
                expected[offset + 1..]
            );
            let page = store.list_event_page(session.id, after, 3).await.unwrap();
            assert_eq!(page.items, expected[offset + 1..offset + 4]);
            assert_eq!(page.next_cursor, Some(expected[offset + 3].seq.to_string()));
            assert!(page.has_more);
        }
        let last = expected.last().unwrap().seq;
        assert!(
            store
                .list_event_page(session.id, last, 3)
                .await
                .unwrap()
                .items
                .is_empty()
        );
    }
}
