export const SCHEMA = `CREATE TABLE IF NOT EXISTS episodes (
 episode INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, season INTEGER, guid TEXT,
 title TEXT NOT NULL, published_at TEXT, duration_seconds INTEGER, canonical_url TEXT NOT NULL,
 json_url TEXT NOT NULL, audio_url TEXT, transistor_url TEXT, youtube_url TEXT,
 summary TEXT NOT NULL DEFAULT '', guests_json TEXT NOT NULL, guests_text TEXT NOT NULL,
 chapters_json TEXT NOT NULL, chapters_text TEXT NOT NULL, segment_count INTEGER NOT NULL,
 manifest_entry TEXT NOT NULL, content_hash TEXT NOT NULL, etag TEXT,
 ingested_at TEXT NOT NULL, checked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS segments (
 id INTEGER PRIMARY KEY, episode INTEGER NOT NULL, idx INTEGER NOT NULL, time TEXT NOT NULL,
 seconds INTEGER NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL, url TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
 text, speaker, content='segments', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
 title, guests_text, chapters_text, summary, content='episodes', content_rowid='episode',
 tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;
export const EPISODE_COLUMNS = ["episode","slug","season","guid","title","published_at","duration_seconds","canonical_url","json_url","audio_url","transistor_url","youtube_url","summary","guests_json","guests_text","chapters_json","chapters_text","segment_count","manifest_entry","content_hash","etag","ingested_at","checked_at"] as const;
export const SEGMENT_COLUMNS = ["id","episode","idx","time","seconds","speaker","text","url"] as const;
