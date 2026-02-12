# Sync Hearts Bot

Telegram bot for private companion chats with credit system and Telegram Stars payments.

## Deploy on Render

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) → New Web Service.
3. Connect repo, set:
   - Build command: `npm install`
   - Start command: `npm start`
4. Add environment variable `BOT_TOKEN` (your bot token).
5. Deploy.

## Configuration

Edit `bot.js` and replace:
- `YOUR_BOT_TOKEN`
- `WEBAPP_URL` (your GitHub Pages URL)
- `WORKER_USERNAME` (your worker's @)
- `ADMIN_ID` (your Telegram ID)

## Worker must start the bot once.
