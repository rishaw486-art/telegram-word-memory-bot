interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
}

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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "telegram-word-memory-bot" });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (url.pathname !== `/telegram/${env.WEBHOOK_SECRET}`) {
      return new Response("Not Found", { status: 404 });
    }

    let update: TelegramUpdate;
    try {
      update = await request.json<TelegramUpdate>();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // Return quickly to Telegram. Cloudflare keeps the invocation alive while
    // waitUntil completes the database writes and API calls.
    ctx.waitUntil(handleUpdate(update, env));
    return new Response("ok");
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendReminders(env));
  },
};

async function handleUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const message = update.message;
  if (!message?.text?.trim()) return;

  const chatId = String(message.chat.id);
  const chatTitle = message.chat.title ?? message.chat.username ?? null;
  await ensureChat(env.DB, chatId, chatTitle);

  const text = message.text.trim();
  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split("@")[0];
  const argument = rest.join(" ").trim();

  switch (command) {
    case "/start":
      await setRemindersEnabled(env.DB, chatId, true);
      await sendMessage(env, chatId, helpText());
      break;
    case "/help":
      await sendMessage(env, chatId, helpText());
      break;
    case "/addword":
      await addMemory(env, chatId, "word", argument);
      break;
    case "/addsentence":
      await addMemory(env, chatId, "sentence", argument);
      break;
    case "/removeword":
      await removeMemory(env, chatId, "word", argument);
      break;
    case "/removesentence":
      await removeMemory(env, chatId, "sentence", argument);
      break;
    case "/list":
      await listMemories(env, chatId);
      break;
    case "/stop":
      await setRemindersEnabled(env.DB, chatId, false);
      await sendMessage(env, chatId, "Reminders paused. Your saved memories are still safe. Use /start to resume.");
      break;
    case "/remindme":
      await sendReminderNow(env, chatId);
      break;
    default:
      await sendMessage(env, chatId, "I did not recognize that command. Use /help to see what I can do.");
  }
}

function helpText(): string {
  return [
    "Word & Sentence Memory Bot",
    "",
    "Add items:",
    "/addword ephemeral",
    "/addsentence The early bird catches the worm.",
    "",
    "Manage items:",
    "/list - show saved items and their IDs",
    "/removeword 3 - remove word ID 3",
    "/removesentence 7 - remove sentence ID 7",
    "You can also remove by typing the exact saved text.",
    "",
    "Reminders:",
    "/start - enable a random reminder every 5 minutes",
    "/stop - pause reminders",
    "/remindme - send a random reminder now",
  ].join("\n");
}

async function addMemory(env: Env, chatId: string, kind: MemoryKind, content: string): Promise<void> {
  if (!content) {
    await sendMessage(env, chatId, `Usage: /add${kind} ${kind === "word" ? "your word" : "your sentence"}`);
    return;
  }
  if (content.length > MAX_MEMORY_LENGTH) {
    await sendMessage(env, chatId, `Please keep each ${kind} under ${MAX_MEMORY_LENGTH} characters.`);
    return;
  }

  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO memories (chat_id, kind, content) VALUES (?, ?, ?)",
  ).bind(chatId, kind, content).run();

  if (result.meta.changes === 0) {
    await sendMessage(env, chatId, `That ${kind} is already saved.`);
  } else {
    await sendMessage(env, chatId, `Saved ${kind}: “${content}”`);
  }
}

async function removeMemory(env: Env, chatId: string, kind: MemoryKind, selector: string): Promise<void> {
  if (!selector) {
    await sendMessage(env, chatId, `Usage: /remove${kind} <ID or exact text>`);
    return;
  }

  const numericId = /^\d+$/.test(selector) ? Number(selector) : null;
  const result = numericId !== null
    ? await env.DB.prepare("DELETE FROM memories WHERE chat_id = ? AND kind = ? AND id = ?").bind(chatId, kind, numericId).run()
    : await env.DB.prepare("DELETE FROM memories WHERE chat_id = ? AND kind = ? AND content = ?").bind(chatId, kind, selector).run();

  await sendMessage(env, chatId, result.meta.changes
    ? `Removed ${kind}.`
    : `I could not find that ${kind}. Use /list to check the IDs or saved text.`);
}

async function listMemories(env: Env, chatId: string): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id, kind, content FROM memories WHERE chat_id = ? ORDER BY kind, id",
  ).bind(chatId).all<{ id: number; kind: MemoryKind; content: string }>();

  if (!rows.results.length) {
    await sendMessage(env, chatId, "You have not saved any words or sentences yet.");
    return;
  }

  const words = rows.results.filter((row) => row.kind === "word");
  const sentences = rows.results.filter((row) => row.kind === "sentence");
  const section = (title: string, items: Memory[]) => items.length
    ? `${title}\n${items.map((item) => `${item.id}. ${item.content}`).join("\n")}`
    : `${title}\n(none)`;

  await sendMessage(env, chatId, [section("Words", words), section("Sentences", sentences)].join("\n\n"));
}

async function sendReminders(env: Env): Promise<void> {
  const chats = await env.DB.prepare("SELECT chat_id FROM chats WHERE enabled = 1").all<{ chat_id: string }>();
  for (const chat of chats.results) {
    // A failure for one chat must not prevent reminders for other chats.
    try {
      await sendReminderNow(env, chat.chat_id, true);
    } catch (error) {
      console.error(`Reminder failed for chat ${chat.chat_id}`, error);
    }
  }
}

async function sendReminderNow(env: Env, chatId: string, scheduled = false): Promise<void> {
  const [wordResult, sentenceResult] = await Promise.all([
    env.DB.prepare("SELECT id, kind, content FROM memories WHERE chat_id = ? AND kind = 'word' ORDER BY RANDOM() LIMIT 1")
      .bind(chatId).all<{ id: number; kind: MemoryKind; content: string }>(),
    env.DB.prepare("SELECT id, kind, content FROM memories WHERE chat_id = ? AND kind = 'sentence' ORDER BY RANDOM() LIMIT 1")
      .bind(chatId).all<{ id: number; kind: MemoryKind; content: string }>(),
  ]);

  const word = wordResult.results[0];
  const sentence = sentenceResult.results[0];
  if (!word && !sentence) {
    if (!scheduled) {
      await sendMessage(env, chatId, "Your reminder list is empty. Add a word with /addword or a sentence with /addsentence.");
    }
    return;
  }

  const lines = ["Memory reminder", ""];
  if (word) lines.push(`Word: ${word.content}`);
  if (sentence) lines.push(`Sentence: ${sentence.content}`);
  await sendMessage(env, chatId, lines.join("\n"));
}

async function ensureChat(db: D1Database, chatId: string, title: string | null): Promise<void> {
  await db.prepare(
    "INSERT INTO chats (chat_id, chat_title) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET chat_title = excluded.chat_title, updated_at = CURRENT_TIMESTAMP",
  ).bind(chatId, title).run();
}

async function setRemindersEnabled(db: D1Database, chatId: string, enabled: boolean): Promise<void> {
  await db.prepare(
    "UPDATE chats SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE chat_id = ?",
  ).bind(enabled ? 1 : 0, chatId).run();
}

async function sendMessage(env: Env, chatId: string, text: string): Promise<void> {
  const response = await fetch(`${TELEGRAM_API(env.BOT_TOKEN)}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
