CREATE TABLE IF NOT EXISTS midi_songs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  original_filename TEXT NOT NULL,
  object_path TEXT NOT NULL UNIQUE,
  song_data TEXT NOT NULL,
  backing_track_path TEXT,
  backing_track_mime_type TEXT,
  backing_track_duration_seconds REAL,
  backing_track_offset_seconds REAL NOT NULL DEFAULT 0,
  backing_track_tempo_bpm REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
