const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

// ---------- CONFIG ----------
const BOT_TOKEN = '8577711169:AAE8Av0ADtel8-4IbreUJe_08g-DenIhHXw'; // 🔴 REPLACE WITH YOUR REAL TOKEN
const WEBAPP_URL = 'https://placidbarry.github.io/sync-hearts-app/'; // 🔴 YOUR GITHUB PAGES URL
const WORKER_USERNAME = 'lisa'; // 🔴 REPLACE WITH YOUR WORKER'S TELEGRAM @USERNAME
const ADMIN_ID = 7640605912; // 🔴 REPLACE WITH YOUR TELEGRAM USER ID

// ---------- DATABASE ----------
let db;
(async () => {
  db = await open({
    filename: './database.db',
    driver: sqlite3.Database
  });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      credits INTEGER DEFAULT 10,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS groups (
      group_id INTEGER PRIMARY KEY,
      user_id INTEGER,
      worker_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ Database ready');
})();

// ---------- BOT SETUP ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ---------- WEBHOOK for WEB APP (if needed) ----------
const app = express();
app.use(express.json());
app.post('/webhook', (req, res) => {
  // Handle data from your web app if you send via HTTP instead of tg.sendData
  res.sendStatus(200);
});
app.listen(3000, () => console.log('✅ Webhook server on port 3000'));

// ---------- COMMANDS ----------
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Give 10 free credits to new users
  const user = await db.get('SELECT * FROM users WHERE user_id = ?', userId);
  if (!user) {
    await db.run('INSERT INTO users (user_id, credits) VALUES (?, 10)', userId);
  }

  // Send welcome message with web app button
  await bot.sendMessage(chatId, 
    `✨ Welcome! You have 10 free credits to start.\nPress the button to find a companion.`, 
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '🔍 Find Worker', web_app: { url: WEBAPP_URL } }
        ]]
      }
    }
  );
});

// ---------- HANDLE DATA FROM WEB APP (tg.sendData) ----------
bot.on('web_app_data', async (msg) => {
  const data = JSON.parse(msg.web_app_data.data);
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  if (data.action === 'pay_connect') {
    // Check user credits
    const user = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
    if (!user || user.credits < 1) {
      return bot.sendMessage(chatId, '❌ Not enough credits. Please buy more.');
    }

    // Deduct 1 credit
    await db.run('UPDATE users SET credits = credits - 1 WHERE user_id = ?', userId);

    // Create a private group
    const newGroup = await bot.createChat(
      null,
      `companion-${userId}-${Date.now()}`,
      { chat_type: 'group' }
    );
    const groupId = newGroup.id;

    // Add user and worker to the group
    await bot.promoteChatMember(groupId, bot.id, { can_invite_users: true });
    await bot.inviteChatMember(groupId, userId);
    await bot.inviteChatMember(groupId, WORKER_USERNAME);

    // Store group info
    await db.run(
      'INSERT INTO groups (group_id, user_id, worker_id) VALUES (?, ?, ?)',
      groupId, userId, data.worker_id || 'unknown'
    );

    // Send initial message
    await bot.sendMessage(groupId, 
      `✅ Connection established! You are chatting with ${data.worker_name || 'your companion'}.\n` +
      `💎 You have ${user.credits - 1} credits left. Each message costs 1 credit.\n` +
      `To buy more, type /buy`
    );

    await bot.sendMessage(chatId, `🎉 Private group created! Go chat with ${data.worker_name}.`);
  }
});

// ---------- DEDUCT CREDITS PER MESSAGE ----------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Only act in groups we created
  const group = await db.get('SELECT * FROM groups WHERE group_id = ?', chatId);
  if (!group) return;

  // Don't deduct for bot's own messages
  if (msg.from.is_bot) return;

  // Check if user has credits
  const user = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
  if (!user || user.credits <= 0) {
    await bot.sendMessage(chatId, '❌ No credits left. Type /buy to purchase more.');
    // Optionally remove user from group? Not implemented here.
    return;
  }

  // Deduct 1 credit
  await db.run('UPDATE users SET credits = credits - 1 WHERE user_id = ?', userId);
  console.log(`Deducted 1 credit from ${userId}. Remaining: ${user.credits - 1}`);
});

// ---------- BUY CREDITS WITH TELEGRAM STARS ----------
bot.onText(/\/buy/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Create an invoice for 100 Stars (change amount as needed)
  const invoice = {
    chat_id: chatId,
    title: '💎 Buy Credits',
    description: '100 Telegram Stars = 50 credits',
    payload: 'buy_credits_50',
    provider_token: '', // Leave empty for Telegram Stars
    currency: 'XTR',    // Special code for Telegram Stars
    prices: [{ label: '50 Credits', amount: 100 }] // 100 Stars
  };

  bot.sendInvoice(invoice).catch(e => {
    console.error(e);
    bot.sendMessage(chatId, '⚠️ Payment not available. Try again later.');
  });
});

// ---------- HANDLE SUCCESSFUL PAYMENT ----------
bot.on('pre_checkout_query', (query) => {
  bot.answerPreCheckoutQuery(query.id, true);
});

bot.on('successful_payment', async (msg) => {
  const userId = msg.from.id;
  // Add 50 credits (adjust according to your invoice)
  await db.run('UPDATE users SET credits = credits + 50 WHERE user_id = ?', userId);
  bot.sendMessage(msg.chat.id, '✅ Payment received! 50 credits added to your account.');
});

// ---------- ADMIN: CHECK CREDITS ----------
bot.onText(/\/credits/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;
  const userId = msg.text.split(' ')[1];
  if (!userId) return bot.sendMessage(msg.chat.id, 'Usage: /credits <user_id>');
  const user = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
  bot.sendMessage(msg.chat.id, `User ${userId} has ${user?.credits || 0} credits.`);
});

console.log('🤖 Bot is running...');
