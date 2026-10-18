import express from "express";
import { db, initDatabase } from "./db.js";
import { handleUpdate } from "./bot.js";

const port = Number(process.env.PORT ?? 10000);
const botToken = process.env.BOT_TOKEN;
const webhookSecret = process.env.WEBHOOK_SECRET;

if (!botToken) throw new Error("BOT_TOKEN is required");
if (!webhookSecret) throw new Error("WEBHOOK_SECRET is required");

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_request, response) => {
  response.json({ ok: true, service: "telegram-word-memory-bot" });
});

app.post(`/telegram/${webhookSecret}`, (request, response) => {
  // Acknowledge Telegram immediately; process the update after the response is sent.
  response.status(200).send("ok");
  void handleUpdate(request.body, db, botToken).catch((error) => {
    console.error("Telegram update failed", error);
  });
});

app.use((_request, response) => response.status(404).json({ ok: false, error: "Not found" }));

await initDatabase();
app.listen(port, "0.0.0.0", () => {
  console.log(`Telegram memory bot listening on port ${port}`);
});

process.on("SIGTERM", async () => {
  await db.end();
  process.exit(0);
});
