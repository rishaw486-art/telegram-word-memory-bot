import type { Pool } from "pg";

type MemoryKind = "word" | "sentence" | "image";
type TelegramPhoto = { file_id: string; width: number; height: number; file_size?: number };
type TelegramMessage = {
  chat: { id: number; type: string; title?: string; username?: string };
  text?: string;
  caption?: string;
  photo?: TelegramPhoto[];
  reply_to_message?: { photo?: TelegramPhoto[]; caption?: string };
};
type TelegramUpdate = { message?: TelegramMessage };
type Memory = { id: number; content: string; file_id?: string | null };

const TELEGRAM_API = (token: string) => `https://api.telegram.org/bot${token}`;
const MAX_MEMORY_LENGTH = 1000;

export async function handleUpdate(update: TelegramUpdate, db: Pool, botToken: string): Promise<void> {
  const message = update.message;
  if (!message) return;

  const chatId = String(message.chat.id);
  const chatTitle = message.chat.title ?? message.chat.username ?? null;
  await ensureChat(db, chatId, chatTitle);

  // A photo can be captioned with /addimage, or /addimage can be sent as a
  // reply to a previously sent photo. Telegram's largest photo variant is used.
  const photo = message.photo?.at(-1) ?? message.reply_to_message?.photo?.at(-1);
  const commandText = message.caption?.trim() || message.text?.trim() || "";
  const [rawCommand, ...rest] = commandText.split(/\s+/);
  const command = (rawCommand || "").toLowerCase().split("@")[0];
  const argument = rest.join(" ").trim();

  if (photo && command === "/addimage") {
    await addImage(db, botToken, chatId, photo.file_id, argument || message.reply_to_message?.caption || "");
    return;
  }
  if (!message.text?.trim()) return;

  const [textCommand, ...textRest] = message.text.trim().split(/\s+/);
  const textArgument = textRest.join(" ").trim();
  switch (textCommand.toLowerCase().split("@")[0]) {
    case "/start":
      await setRemindersEnabled(db, chatId, true);
      await sendMessage(botToken, chatId, helpText());
      break;
    case "/help":
      await sendMessage(botToken, chatId, helpText());
      break;
    case "/addword":
      await addMemory(db, botToken, chatId, "word", textArgument);
      break;
    case "/addsentence":
      await addMemory(db, botToken, chatId, "sentence", textArgument);
      break;
    case "/removeword":
      await removeMemory(db, botToken, chatId, "word", textArgument);
      break;
    case "/removesentence":
      await removeMemory(db, botToken, chatId, "sentence", textArgument);
      break;
    case "/removeimage":
      await removeMemory(db, botToken, chatId, "image", textArgument);
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
  const { word, sentence, image } = await getNextMemories(db, chatId);
  if (!word && !sentence && !image) {
    if (!scheduled) await sendMessage(botToken, chatId, "Your reminder list is empty. Add a word, sentence, or image first.");
    return;
  }
  const lines = ["Memory reminder", ""];
  if (word) lines.push(`Word: ${word.content}`);
  if (sentence) lines.push(`Sentence: ${sentence.content}`);
  if (lines.length > 2) await sendMessage(botToken, chatId, lines.join("\n"));
  if (image?.file_id) await sendPhoto(botToken, chatId, image.file_id, image.content || undefined);
}

async function getNextMemories(db: Pool, chatId: string): Promise<{ word?: Memory; sentence?: Memory; image?: Memory }> {
  const client = await db.connect();
  const result: { word?: Memory; sentence?: Memory; image?: Memory } = {};
  const cursorColumns = { word: "word_cursor", sentence: "sentence_cursor", image: "image_cursor" } as const;
  try {
    await client.query("BEGIN");
    // Serialize reminders for one chat so two overlapping cron/manual runs
    // cannot send the same item and advance the cursor incorrectly.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [chatId]);
    const chat = await client.query<{ word_cursor: string; sentence_cursor: string; image_cursor: string }>(
      "SELECT word_cursor, sentence_cursor, image_cursor FROM chats WHERE chat_id = $1 FOR UPDATE", [chatId],
    );
    if (!chat.rows[0]) {
      await client.query("COMMIT");
      return result;
    }

    for (const kind of ["word", "sentence", "image"] as const) {
      const cursor = Number(chat.rows[0][cursorColumns[kind]]);
      let next = await client.query<Memory>(
        "SELECT id, content, file_id FROM memories WHERE chat_id = $1 AND kind = $2 AND id > $3 ORDER BY id ASC LIMIT 1",
        [chatId, kind, cursor],
      );
      if (!next.rows[0]) {
        next = await client.query<Memory>(
          "SELECT id, content, file_id FROM memories WHERE chat_id = $1 AND kind = $2 ORDER BY id ASC LIMIT 1",
          [chatId, kind],
        );
      }
      const memory = next.rows[0];
      if (memory) {
        result[kind] = memory;
        await client.query(`UPDATE chats SET ${cursorColumns[kind]} = $1, updated_at = NOW() WHERE chat_id = $2`, [memory.id, chatId]);
      }
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function addMemory(db: Pool, botToken: string, chatId: string, kind: "word" | "sentence", content: string): Promise<void> {
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

async function addImage(db: Pool, botToken: string, chatId: string, fileId: string, caption: string): Promise<void> {
  const existing = await db.query("SELECT id FROM memories WHERE chat_id = $1 AND kind = 'image' AND file_id = $2", [chatId, fileId]);
  if (existing.rowCount) {
    await sendMessage(botToken, chatId, "That image is already saved.");
    return;
  }
  const result = await db.query(
    "INSERT INTO memories (chat_id, kind, content, file_id) VALUES ($1, 'image', $2, $3)",
    [chatId, caption, fileId],
  );
  await sendMessage(botToken, chatId, result.rowCount === 0 ? "That image is already saved." : `Saved image${caption ? ` with caption: “${caption}”` : "."}`);
}

async function removeMemory(db: Pool, botToken: string, chatId: string, kind: MemoryKind, selector: string): Promise<void> {
  if (!selector) {
    await sendMessage(botToken, chatId, `Usage: /remove${kind} <ID${kind === "image" ? "" : " or exact text"}>`);
    return;
  }
  const numericId = /^\d+$/.test(selector) ? Number(selector) : null;
  const result = numericId !== null
    ? await db.query("DELETE FROM memories WHERE chat_id = $1 AND kind = $2 AND id = $3", [chatId, kind, numericId])
    : await db.query("DELETE FROM memories WHERE chat_id = $1 AND kind = $2 AND content = $3", [chatId, kind, selector]);
  await sendMessage(botToken, chatId, result.rowCount ? `Removed ${kind}.` : `I could not find that ${kind}. Use /list to check the IDs.`);
}

async function listMemories(db: Pool, botToken: string, chatId: string): Promise<void> {
  const { rows } = await db.query<{ id: number; kind: MemoryKind; content: string; file_id: string | null }>(
    "SELECT id, kind, content, file_id FROM memories WHERE chat_id = $1 ORDER BY kind, id", [chatId],
  );
  if (!rows.length) {
    await sendMessage(botToken, chatId, "You have not saved any words, sentences, or images yet.");
    return;
  }
  const section = (title: string, items: Memory[], image = false) => items.length
    ? `${title}\n${items.map((item) => `${item.id}. ${image ? (item.content || "(no caption)") : item.content}`).join("\n")}`
    : `${title}\n(none)`;
  await sendMessage(botToken, chatId, [
    section("Words", rows.filter((row) => row.kind === "word")),
    section("Sentences", rows.filter((row) => row.kind === "sentence")),
    section("Images", rows.filter((row) => row.kind === "image"), true),
  ].join("\n\n"));
}

async function ensureChat(db: Pool, chatId: string, title: string | null): Promise<void> {
  await db.query(`INSERT INTO chats (chat_id, chat_title) VALUES ($1, $2) ON CONFLICT (chat_id) DO UPDATE SET chat_title = EXCLUDED.chat_title, updated_at = NOW()`, [chatId, title]);
}
async function setRemindersEnabled(db: Pool, chatId: string, enabled: boolean): Promise<void> {
  await db.query("UPDATE chats SET enabled = $1, updated_at = NOW() WHERE chat_id = $2", [enabled, chatId]);
}
async function sendMessage(botToken: string, chatId: string, text: string): Promise<void> {
  const response = await fetch(`${TELEGRAM_API(botToken)}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text }) });
  if (!response.ok) throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
}
async function sendPhoto(botToken: string, chatId: string, fileId: string, caption?: string): Promise<void> {
  const response = await fetch(`${TELEGRAM_API(botToken)}/sendPhoto`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, photo: fileId, caption }) });
  if (!response.ok) throw new Error(`Telegram sendPhoto failed: ${response.status} ${await response.text()}`);
}
function helpText(): string {
  return [
    "Word, Sentence & Image Memory Bot", "", "Add items:",
    "/addword ephemeral", "/addsentence The early bird catches the worm.",
    "Send a photo with caption /addimage [optional caption]", "Or reply to a photo with /addimage [optional caption]", "",
    "Manage items:", "/list - show saved items and their IDs", "/removeword 3 - remove word ID 3",
    "/removesentence 7 - remove sentence ID 7", "/removeimage 9 - remove image ID 9", "You can remove words/sentences by exact text.", "",
    "Reminders:", "/start - enable sequential word, sentence, and image reminders every 5 minutes", "/stop - pause reminders", "/remindme - send the next reminder now",
  ].join("\n");
}
