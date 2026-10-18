import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 5,
});

export async function initDatabase(): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock(827364)");
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY,
        chat_title TEXT,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(chat_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        file_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(chat_id, kind, content)
      )
    `);
    await client.query("ALTER TABLE memories ADD COLUMN IF NOT EXISTS file_id TEXT");
    await client.query("ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_kind_check");
    await client.query("ALTER TABLE memories ADD CONSTRAINT memories_kind_check CHECK (kind IN ('word', 'sentence', 'image'))");
    await client.query("CREATE INDEX IF NOT EXISTS idx_memories_chat_kind ON memories(chat_id, kind)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_chats_enabled ON chats(enabled)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_memories_file_id ON memories(chat_id, file_id) WHERE file_id IS NOT NULL");
    await client.query("COMMIT");
    await client.query("SELECT pg_advisory_unlock(827364)");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("SELECT pg_advisory_unlock(827364)").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
