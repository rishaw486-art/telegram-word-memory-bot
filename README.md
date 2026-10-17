# Telegram Word & Sentence Memory Bot

A serverless Telegram bot built for **Cloudflare Workers + D1**. You can save words and sentences, remove them later, and receive one random saved word and one random saved sentence every five minutes.

## Why this serverless design works

Serverless functions should not keep a process or `setInterval` running. This project uses:

- **Cloudflare Worker** for the Telegram webhook.
- **Cloudflare D1** for durable SQLite-compatible storage.
- **Cloudflare Cron Trigger** (`*/5 * * * *`) for scheduled reminders.

The cron trigger runs every five minutes and sends reminders to chats that have enabled them with `/start`.

## Prerequisites

1. A Telegram bot token from [@BotFather](https://t.me/BotFather).
2. A Cloudflare account with Workers and D1 enabled.
3. Node.js 18+ and npm.
4. Wrangler authenticated with `npx wrangler login`.

## Deploy

From this directory:

```bash
npm install
npx wrangler login
npx wrangler d1 create telegram-memory-db
```

Copy the `database_id` printed by Wrangler into `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`.

Create the database schema:

```bash
npm run db:migrate:remote
```

Set the Worker secrets. Use a long random webhook secret; it becomes part of the webhook URL:

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

Deploy:

```bash
npm run deploy
```

Wrangler prints a Worker URL such as `https://telegram-word-memory-bot.<your-subdomain>.workers.dev`.

## Register the Telegram webhook

Replace the placeholders and run:

```bash
curl -sS -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  --data-urlencode "url=https://<your-worker-domain>/telegram/<WEBHOOK_SECRET>" \
  -d "allowed_updates=[\"message\"]"
```

A successful response contains `"ok":true`. For basic diagnostics:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
curl "https://<your-worker-domain>/health"
```

The bot token should not be committed to Git or put in frontend code. Store it only as a Wrangler secret.

## Bot commands

- `/start` enables five-minute reminders and shows help.
- `/addword ephemeral` saves a word.
- `/addsentence The early bird catches the worm.` saves a sentence.
- `/list` shows saved words and sentences with IDs.
- `/removeword 3` removes word ID 3.
- `/removesentence 7` removes sentence ID 7.
- `/removeword exact saved text` also removes by exact text.
- `/stop` pauses reminders without deleting anything.
- `/remindme` sends a reminder immediately.
- `/help` shows the command list.

Duplicate items in the same chat are ignored. Data is isolated by Telegram chat ID, so users in different private chats do not see one another's memories. In a group, the memories belong to that group.

## Optional BotFather command menu

In @BotFather, use `/setcommands` and paste:

```text
start - Enable reminders and show help
help - Show available commands
addword - Save a word
addsentence - Save a sentence
list - List saved memories
removeword - Remove a word by ID or exact text
removesentence - Remove a sentence by ID or exact text
stop - Pause five-minute reminders
remindme - Send a reminder now
```

## Local development

Create a local secrets file:

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars with test values
npm run db:migrate:local
npm run dev
```

For local webhook testing, Telegram needs a public HTTPS URL. You can use a temporary tunnel such as Cloudflare Tunnel and register that URL as the webhook. Do not use local polling in this Worker design.

## Project files

- `src/index.ts` — webhook, commands, D1 queries, and scheduled reminders.
- `migrations/0001_initial.sql` — D1 schema.
- `wrangler.toml` — Worker, D1, and cron configuration.
- `.dev.vars.example` — local secret names.
