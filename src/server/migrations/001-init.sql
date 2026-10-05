-- Version 1. No column can hold prompt text, code or file contents.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user       TEXT NOT NULL,
  project    TEXT NOT NULL,
  transcript TEXT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);

CREATE TABLE agents (
  session   TEXT NOT NULL REFERENCES sessions (id),
  agent_key TEXT NOT NULL,
  name      TEXT NOT NULL,
  is_boss   INTEGER NOT NULL DEFAULT 0,
  stage     TEXT NOT NULL DEFAULT 'Thinking',
  last_ts   INTEGER NOT NULL,
  PRIMARY KEY (session, agent_key)
);

CREATE TABLE tasks (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  session               TEXT NOT NULL,
  agent_key             TEXT NOT NULL,
  started_at            INTEGER NOT NULL,
  ended_at              INTEGER,
  tokens_input          INTEGER NOT NULL DEFAULT 0,
  tokens_output         INTEGER NOT NULL DEFAULT 0,
  tokens_cache_creation INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read     INTEGER NOT NULL DEFAULT 0,
  tokens_incomplete     INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (session, agent_key) REFERENCES agents (session, agent_key)
);

CREATE INDEX idx_tasks_open ON tasks (session, agent_key, ended_at);
CREATE INDEX idx_tasks_started_at ON tasks (started_at);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER REFERENCES tasks (id),
  ts         INTEGER NOT NULL,
  hook       TEXT NOT NULL,
  user       TEXT NOT NULL,
  project    TEXT NOT NULL,
  session    TEXT NOT NULL,
  agent_key  TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  tool       TEXT,
  file       TEXT,
  notification TEXT
);

CREATE INDEX idx_events_agent_ts ON events (session, agent_key, ts);
CREATE INDEX idx_events_task ON events (task_id);
