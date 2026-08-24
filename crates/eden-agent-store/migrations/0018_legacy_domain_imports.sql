CREATE TABLE IF NOT EXISTS legacy_import_items (
    source_kind TEXT NOT NULL,
    entity_kind TEXT NOT NULL,
    legacy_key TEXT NOT NULL,
    target_key TEXT NOT NULL DEFAULT '',
    details_json TEXT NOT NULL DEFAULT '{}',
    imported_at INTEGER NOT NULL,
    PRIMARY KEY (source_kind, entity_kind, legacy_key)
);

CREATE INDEX IF NOT EXISTS legacy_import_items_entity
    ON legacy_import_items(source_kind, entity_kind, imported_at);

CREATE TABLE IF NOT EXISTS legacy_skill_installations (
    id TEXT PRIMARY KEY NOT NULL,
    legacy_key TEXT NOT NULL UNIQUE,
    skill_name TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT 'user',
    source_type TEXT NOT NULL DEFAULT '',
    source_uri TEXT NOT NULL DEFAULT '',
    source_ref TEXT NOT NULL DEFAULT '',
    installed_version TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL DEFAULT '',
    was_enabled INTEGER NOT NULL DEFAULT 0,
    trust_status TEXT NOT NULL DEFAULT '',
    manifest_json TEXT NOT NULL DEFAULT '{}',
    migration_state TEXT NOT NULL CHECK (
        migration_state IN ('requires_reinstall', 'disabled', 'unavailable')
    ),
    imported_at INTEGER NOT NULL
);
