import express from "express";
import { db, initDatabase } from "./db.js";
import { handleUpdate } from "./bot.js";

const port = Number(process.env.PORT ?? 10000);
const botToken = process.env.BOT_TOKEN;
const rawWebhookSecret = process.env.WEBHOOK_SECRET;
// Telegram secret_token only permits A-Z, a-z, 0-9, _ and -. Render's
// generateValue may produce base64 characters such as +, / and =.
const webhookSecret = rawWebhookSecret?.replace(/[^A-Za-z0-9_-]/g, "");
const webhookBaseUrl = process.env.WEBHOOK_BASE_URL ?? process.env.RENDER_EXTERNAL_URL;

if (!botToken) throw new Error("BOT_TOKEN is required");
if (!webhookSecret || webhookSecret.length < 16) throw new Error("WEBHOOK_SECRET must contain at least 16 URL-safe characters");

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_request, response) => {
  response.json({ ok: true, service: "telegram-word-memory-bot" });
});

app.post("/telegram/webhook", (request, response) => {
  const telegramSecret = request.header("X-Telegram-Bot-Api-Secret-Token");
  if (telegramSecret !== webhookSecret) {
    response.status(401).send("Unauthorized");
    return;
  }
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

if (webhookBaseUrl) {
  const webhookUrl = `${webhookBaseUrl.replace(/\/$/, "")}/telegram/webhook`;
  const webhookResponse = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: webhookUrl, secret_token: webhookSecret, allowed_updates: ["message"] }),
  });
  const webhookResult = await webhookResponse.json() as { ok?: boolean; description?: string };
  if (!webhookResponse.ok || !webhookResult.ok) {
    console.error("Telegram webhook registration failed", webhookResult);
  } else {
    console.log(`Telegram webhook registered at ${webhookUrl}`);
  }
} else {
  console.warn("RENDER_EXTERNAL_URL is unavailable; set WEBHOOK_BASE_URL and restart to register the Telegram webhook.");
}

process.on("SIGTERM", async () => {
  await db.end();
  process.exit(0);
});
