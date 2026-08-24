CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    active_version TEXT NOT NULL,
    active_revision TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    trust_state TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_uri TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_versions (
    plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    revision TEXT NOT NULL,
    root_path TEXT NOT NULL,
    trust_state TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_uri TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    installed_at INTEGER NOT NULL,
    PRIMARY KEY (plugin_id, version, revision),
    UNIQUE (root_path)
);

CREATE INDEX IF NOT EXISTS idx_plugin_versions_installed
ON plugin_versions(plugin_id, installed_at DESC);

CREATE TABLE IF NOT EXISTS plugin_permission_grants (
    plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
    capability TEXT NOT NULL,
    resource TEXT NOT NULL,
    access TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied')),
    manifest_revision TEXT NOT NULL,
    decided_at INTEGER NOT NULL,
    PRIMARY KEY (plugin_id, capability, resource, access)
);
