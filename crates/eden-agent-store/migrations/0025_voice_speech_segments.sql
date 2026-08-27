CREATE TABLE IF NOT EXISTS voice_speech_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    external_message_id TEXT NOT NULL,
    external_audio_asset_id INTEGER,
    audio_blob_id TEXT NOT NULL REFERENCES blobs(id) ON DELETE RESTRICT,
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    audio_format TEXT NOT NULL,
    segment_group_id TEXT NOT NULL,
    group_index INTEGER NOT NULL CHECK (group_index >= 0),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    text_hash TEXT NOT NULL,
    text_length INTEGER NOT NULL CHECK (text_length >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(session_id, external_message_id, segment_group_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_voice_speech_segments_session_message
    ON voice_speech_segments(session_id, external_message_id, group_index, sequence);
