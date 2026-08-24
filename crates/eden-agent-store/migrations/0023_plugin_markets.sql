CREATE TABLE IF NOT EXISTS plugin_market_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    key_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    index_json TEXT,
    index_revision TEXT,
    last_refreshed_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_market_sources_enabled
ON plugin_market_sources(enabled, id);

CREATE TABLE IF NOT EXISTS plugin_market_revocations (
    source_id TEXT NOT NULL REFERENCES plugin_market_sources(id) ON DELETE CASCADE,
    plugin_id TEXT NOT NULL,
    version TEXT NOT NULL,
    revision TEXT NOT NULL,
    reason TEXT NOT NULL,
    revoked_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, plugin_id, version, revision)
);

CREATE INDEX IF NOT EXISTS idx_plugin_market_revocations_release
ON plugin_market_revocations(plugin_id, version, revision);
