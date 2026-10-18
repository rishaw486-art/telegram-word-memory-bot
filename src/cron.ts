import { db, initDatabase } from "./db.js";
import { sendReminders } from "./bot.js";

const botToken = process.env.BOT_TOKEN;
if (!botToken) throw new Error("BOT_TOKEN is required");

try {
  await initDatabase();
  await sendReminders(db, botToken);
} finally {
  await db.end();
}
