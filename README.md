# Telegram Word & Sentence Memory Bot

A Telegram bot that stores words and sentences, lets you remove them, and sends one random word plus one random sentence every five minutes.

This version is built for **Render**:

- Render Web Service runs the Telegram webhook.
- Render PostgreSQL stores memories permanently.
- Render Cron Job runs `npm run cron` every five minutes.

## Commands

- `/start` — enable reminders and show help
- `/help` — show help
- `/addword ephemeral` — save a word
- `/addsentence The early bird catches the worm.` — save a sentence
- Send a photo with caption `/addimage [optional caption]` — save an image
- Reply to a photo with `/addimage [optional caption]` — save an existing photo
- `/list` — show saved items and IDs
- `/removeword 3` — remove a word by ID
- `/removesentence 7` — remove a sentence by ID
- `/removeimage 9` — remove an image by ID
- `/removeword exact text` — remove a word by exact text
- `/removesentence exact text` — remove a sentence by exact text
- `/stop` — pause reminders without deleting data
- `/remindme` — send a reminder immediately

## Deploy with Render Blueprint

1. Push this repository to GitHub.
2. In Render, choose **New > Blueprint**.
3. Select the `telegram-word-memory-bot` GitHub repository.
4. Render reads `render.yaml` and creates:
   - a web service named `telegram-word-memory-bot`;
   - a PostgreSQL database named `telegram-memory-db`;
   - a cron job named `telegram-word-memory-reminders`.
5. When Render asks for `BOT_TOKEN`, enter the token from @BotFather.
6. Deploy the Blueprint.

`WEBHOOK_SECRET` is generated automatically for the web service. `DATABASE_URL` is connected automatically to the Render PostgreSQL database.

The web service listens on Render's `PORT` environment variable. It exposes:

```text
GET /health
POST /telegram/webhook
```

The database schema is initialized automatically when the web service or cron job starts. The SQL reference is in `migrations/001_initial.sql`.

Images are stored using Telegram's `file_id`, not as downloaded files. This keeps the database small and lets Telegram deliver the original saved image when a reminder is sent. The image caption is optional and is shown when the image is sent.

## Telegram webhook

On startup, the web service automatically registers its webhook using Render's `RENDER_EXTERNAL_URL` value. It normally looks like:

```text
https://telegram-word-memory-bot.onrender.com
```

The final webhook endpoint is:

```bash
https://telegram-word-memory-bot.onrender.com/telegram/webhook
```

The service sends Telegram a secret header token automatically. This avoids putting the secret in the URL and works even when Render generates a secret containing characters that are not valid in a URL path.

If you use a custom domain, set `WEBHOOK_BASE_URL` on the web service to that base URL and redeploy. Otherwise, Render's automatic URL is used.

If you need to register it manually, use:

```bash
curl -sS -X POST \
  "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://telegram-word-memory-bot.onrender.com/telegram/webhook","secret_token":"<WEBHOOK_SECRET>","allowed_updates":["message"]}'
```

Check the webhook:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Test the Render service:

```bash
curl https://telegram-word-memory-bot.onrender.com/health
```

Expected response:

```json
{"ok":true,"service":"telegram-word-memory-bot"}
```

## Deploy manually instead of using Blueprint

Create a Render **Web Service** connected to this repository:

- **Runtime:** Node
- **Build Command:** `npm ci && npm run build`
- **Start Command:** `npm start`
- **Health Check Path:** `/health`

Add these environment variables:

```text
BOT_TOKEN=<token from BotFather>
WEBHOOK_SECRET=<long random URL-safe secret>
DATABASE_URL=<Render PostgreSQL internal connection string>
```

Then create a Render **Cron Job** from the same repository:

- **Schedule:** `*/5 * * * *`
- **Build Command:** `npm ci && npm run build`
- **Start Command:** `npm run cron`
- **Environment:** the same `BOT_TOKEN` and `DATABASE_URL`

The cron job is what sends reminders every five minutes. Do not rely on `setInterval` in the web service because a Render service can restart or sleep.

## Troubleshooting no response

Open the Render web service URL followed by `/health`. It must return JSON with `"ok": true`. Then inspect the webhook status:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

The `url` should end with `/telegram/webhook`, and `last_error_message` should be absent. After pushing a new commit, wait for the Render deploy to become live; the service registers the webhook again during startup.

## Local development

```bash
cp .env.example .env
npm install
npm run dev
```

Use a local PostgreSQL database and set `DATABASE_URL`. Telegram requires a public HTTPS webhook URL, so local webhook testing needs a tunnel. Render deployment is the simplest way to test the production webhook.

## Security

Never commit `BOT_TOKEN`, `WEBHOOK_SECRET`, `DATABASE_URL`, `.env`, or any database password. Telegram only calls the secret webhook path, and all SQL queries use PostgreSQL parameters.
