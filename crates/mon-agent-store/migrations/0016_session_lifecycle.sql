ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'legacy'
    CHECK (title_source IN ('pending', 'generating', 'generated', 'fallback', 'user', 'legacy'));
