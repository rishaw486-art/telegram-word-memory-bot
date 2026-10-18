CREATE TABLE IF NOT EXISTS chats (
  chat_id TEXT PRIMARY KEY,
  chat_title TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memories (
  id BIGSERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('word', 'sentence')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(chat_id, kind, content)
);

CREATE INDEX IF NOT EXISTS idx_memories_chat_kind ON memories(chat_id, kind);
CREATE INDEX IF NOT EXISTS idx_chats_enabled ON chats(enabled);
