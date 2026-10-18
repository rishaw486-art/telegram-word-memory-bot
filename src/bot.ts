import type { Pool } from "pg";

type MemoryKind = "word" | "sentence";
type TelegramUpdate = {
  message?: {
    chat: { id: number; type: string; title?: string; username?: string };
    text?: string;
  };
};
type Memory = { id: number; content: string };

const TELEGRAM_API = (token: string) => `https://api.telegram.org/bot${token}`;
const MAX_MEMORY_LENGTH = 1000;

export async function handleUpdate(update: TelegramUpdate, db: Pool, botToken: string): Promise<void> {
  const message = update.message;
  if (!message?.text?.trim()) return;

  const chatId = String(message.chat.id);
  const chatTitle = message.chat.title ?? message.chat.username ?? null;
  await ensureChat(db, chatId, chatTitle);

  const text = message.text.trim();
  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split("@")[0];
  const argument = rest.join(" ").trim();

  switch (command) {
    case "/start":
      await setRemindersEnabled(db, chatId, true);
      await sendMessage(botToken, chatId, helpText());
      break;
    case "/help":
      await sendMessage(botToken, chatId, helpText());
      break;
    case "/addword":
      await addMemory(db, botToken, chatId, "word", argument);
      break;
    case "/addsentence":
      await addMemory(db, botToken, chatId, "sentence", argument);
      break;
    case "/removeword":
      await removeMemory(db, botToken, chatId, "word", argument);
      break;
    case "/removesentence":
      await removeMemory(db, botToken, chatId, "sentence", argument);
      break;
    case "/list":
      await listMemories(db, botToken, chatId);
      break;
    case "/stop":
      await setRemindersEnabled(db, chatId, false);
      await sendMessage(botToken, chatId, "Reminders paused. Your saved memories are still safe. Use /start to resume.");
      break;
    case "/remindme":
      await sendReminderNow(db, botToken, chatId);
      break;
    default:
      await sendMessage(botToken, chatId, "I did not recognize that command. Use /help to see what I can do.");
  }
}

export async function sendReminders(db: Pool, botToken: string): Promise<void> {
  const { rows } = await db.query<{ chat_id: string }>("SELECT chat_id FROM chats WHERE enabled = TRUE");
  for (const chat of rows) {
    try {
      await sendReminderNow(db, botToken, chat.chat_id, true);
    } catch (error) {
      console.error(`Reminder failed for chat ${chat.chat_id}`, error);
    }
  }
}

async function sendReminderNow(db: Pool, botToken: string, chatId: string, scheduled = false): Promise<void> {
  const [wordResult, sentenceResult] = await Promise.all([
    db.query<Memory>("SELECT id, content FROM memories WHERE chat_id = $1 AND kind = 'word' ORDER BY RANDOM() LIMIT 1", [chatId]),
    db.query<Memory>("SELECT id, content FROM memories WHERE chat_id = $1 AND kind = 'sentence' ORDER BY RANDOM() LIMIT 1", [chatId]),
  ]);
  const word = wordResult.rows[0];
  const sentence = sentenceResult.rows[0];
  if (!word && !sentence) {
    if (!scheduled) await sendMessage(botToken, chatId, "Your reminder list is empty. Add a word with /addword or a sentence with /addsentence.");
    return;
  }
  const lines = ["Memory reminder", ""];
  if (word) lines.push(`Word: ${word.content}`);
  if (sentence) lines.push(`Sentence: ${sentence.content}`);
  await sendMessage(botToken, chatId, lines.join("\n"));
}

async function addMemory(db: Pool, botToken: string, chatId: string, kind: MemoryKind, content: string): Promise<void> {
  if (!content) {
    await sendMessage(botToken, chatId, `Usage: /add${kind} ${kind === "word" ? "your word" : "your sentence"}`);
    return;
  }
  if (content.length > MAX_MEMORY_LENGTH) {
    await sendMessage(botToken, chatId, `Please keep each ${kind} under ${MAX_MEMORY_LENGTH} characters.`);
    return;
  }
  const result = await db.query(
    "INSERT INTO memories (chat_id, kind, content) VALUES ($1, $2, $3) ON CONFLICT (chat_id, kind, content) DO NOTHING",
    [chatId, kind, content],
  );
  await sendMessage(botToken, chatId, result.rowCount === 0 ? `That ${kind} is already saved.` : `Saved ${kind}: “${content}”`);
}

async function removeMemory(db: Pool, botToken: string, chatId: string, kind: MemoryKind, selector: string): Promise<void> {
  if (!selector) {
    await sendMessage(botToken, chatId, `Usage: /remove${kind} <ID or exact text>`);
    return;
  }
  const numericId = /^\d+$/.test(selector) ? Number(selector) : null;
  const result = numericId !== null
    ? await db.query("DELETE FROM memories WHERE chat_id = $1 AND kind = $2 AND id = $3", [chatId, kind, numericId])
    : await db.query("DELETE FROM memories WHERE chat_id = $1 AND kind = $2 AND content = $3", [chatId, kind, selector]);
  await sendMessage(botToken, chatId, result.rowCount ? `Removed ${kind}.` : `I could not find that ${kind}. Use /list to check the IDs or saved text.`);
}

async function listMemories(db: Pool, botToken: string, chatId: string): Promise<void> {
  const { rows } = await db.query<{ id: number; kind: MemoryKind; content: string }>(
    "SELECT id, kind, content FROM memories WHERE chat_id = $1 ORDER BY kind, id", [chatId],
  );
  if (!rows.length) {
    await sendMessage(botToken, chatId, "You have not saved any words or sentences yet.");
    return;
  }
  const words = rows.filter((row) => row.kind === "word");
  const sentences = rows.filter((row) => row.kind === "sentence");
  const section = (title: string, items: Memory[]) => items.length
    ? `${title}\n${items.map((item) => `${item.id}. ${item.content}`).join("\n")}`
    : `${title}\n(none)`;
  await sendMessage(botToken, chatId, [section("Words", words), section("Sentences", sentences)].join("\n\n"));
}

async function ensureChat(db: Pool, chatId: string, title: string | null): Promise<void> {
  await db.query(
    `INSERT INTO chats (chat_id, chat_title) VALUES ($1, $2)
     ON CONFLICT (chat_id) DO UPDATE SET chat_title = EXCLUDED.chat_title, updated_at = NOW()`,
    [chatId, title],
  );
}

async function setRemindersEnabled(db: Pool, chatId: string, enabled: boolean): Promise<void> {
  await db.query("UPDATE chats SET enabled = $1, updated_at = NOW() WHERE chat_id = $2", [enabled, chatId]);
}

async function sendMessage(botToken: string, chatId: string, text: string): Promise<void> {
  const response = await fetch(`${TELEGRAM_API(botToken)}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
}

function helpText(): string {
  return [
    "Word & Sentence Memory Bot", "", "Add items:",
    "/addword ephemeral", "/addsentence The early bird catches the worm.", "",
    "Manage items:", "/list - show saved items and their IDs", "/removeword 3 - remove word ID 3",
    "/removesentence 7 - remove sentence ID 7", "You can also remove by typing the exact saved text.", "",
    "Reminders:", "/start - enable a random reminder every 5 minutes", "/stop - pause reminders", "/remindme - send a random reminder now",
  ].join("\n");
}
