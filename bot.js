/**
 * SYNC HEARTS AGENCY — FINAL PRODUCTION BACKEND
 * Telegram-native chat | Mini App = profiles only
 * Rooms simulated | AI fallback | Admin takeover | Stars payments
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const express = require('express');

// =========================================================
// CONFIG
// =========================================================
const BOT_TOKEN = process.env.BOT_TOKEN || '8577711169:AAHNCiGfnnxMRyZnnvLg9JKVaNrjZ1-9KHc';
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 7640605912; // Your ID from the upload
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://placidbarry.github.io/sync-hearts-app/';
const PORT = process.env.PORT || 8080;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();

// =========================================================
// EXPRESS (health check only)
// =========================================================
app.get('/', (_, res) => res.send('Sync Hearts Bot running'));
app.listen(PORT);

// =========================================================
// DATABASE
// =========================================================
let db;

(async () => {
  db = await open({
    filename: './agency.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      first_name TEXT,
      credits INTEGER DEFAULT 50,
      active_room INTEGER
    );

    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      image_url TEXT,
      is_online INTEGER DEFAULT 0,
      admin_chat_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      agent_id INTEGER,
      status TEXT,
      UNIQUE(user_id, agent_id)
    );
  `);

  await db.run(
    `INSERT OR IGNORE INTO agents (name, admin_chat_id) VALUES ('Sophia', ?)`,
    ADMIN_ID
  );
  await db.run(
    `INSERT OR IGNORE INTO agents (name, admin_chat_id) VALUES ('Elena', ?)`,
    ADMIN_ID
  );

  console.log('✅ Database initialized');
})();

// =========================================================
// START
// =========================================================
bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;

  const exists = await db.get(
    `SELECT 1 FROM users WHERE user_id = ?`,
    userId
  );

  if (!exists) {
    await db.run(
      `INSERT INTO users (user_id, first_name) VALUES (?, ?)`,
      [userId, msg.from.first_name]
    );
  }

  bot.sendMessage(
    userId,
    `🔥 Welcome to Sync Hearts\n\nBrowse profiles and choose your companion.`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: '💋 View Profiles', web_app: { url: WEBAPP_URL } }
        ]]
      }
    }
  );
});

// =========================================================
// WEBAPP ROUTER (STRICT)
// =========================================================
bot.on('message', async (msg) => {
  if (!msg.web_app_data) return;

  const userId = msg.from.id;
  const data = JSON.parse(msg.web_app_data.data);

  // --- REGISTER ---
  if (data.action === 'register_new_user') {
    const exists = await db.get(
      `SELECT 1 FROM users WHERE user_id = ?`,
      userId
    );

    if (!exists) {
      await db.run(
        `INSERT INTO users (user_id, first_name) VALUES (?, ?)`,
        [userId, data.user_data.firstName]
      );
    }

    return bot.sendMessage(userId, '✅ Account ready');
  }

  // --- OPEN CHATS ---
  if (data.action === 'open_chats') {
    const user = await db.get(
      `SELECT active_room FROM users WHERE user_id = ?`,
      userId
    );

    if (!user?.active_room) {
      return bot.sendMessage(userId, 'No active chat yet');
    }

    const room = await db.get(
      `SELECT agents.name FROM rooms 
       JOIN agents ON agents.id = rooms.agent_id
       WHERE rooms.id = ?`,
      user.active_room
    );

    return bot.sendMessage(
      userId,
      `💬 Active chat: ${room.name}\n\nType below 👇`
    );
  }

  // --- SELECT AGENT (CREATE ROOM) ---
  if (data.action === 'select_agent') {
    const agent = await db.get(
      `SELECT id FROM agents WHERE name = ?`,
      data.agent_name
    );

    if (!agent) return;

    let room = await db.get(
      `SELECT id FROM rooms WHERE user_id = ? AND agent_id = ?`,
      [userId, agent.id]
    );

    if (!room) {
      const result = await db.run(
        `INSERT INTO rooms (user_id, agent_id, status)
         VALUES (?, ?, 'ai')`,
        [userId, agent.id]
      );
      room = { id: result.lastID };
    }

    await db.run(
      `UPDATE users SET active_room = ? WHERE user_id = ?`,
      [room.id, userId]
    );

    return bot.sendMessage(
      userId,
      `💋 Connected with ${data.agent_name}\nSay hi 👇`
    );
  }
});

// =========================================================
// MESSAGE ROUTER (ROOM ISOLATION)
// =========================================================
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/') || msg.web_app_data) return;

  const userId = msg.from.id;
  if (userId === ADMIN_ID) return;

  const user = await db.get(
    `SELECT active_room, credits FROM users WHERE user_id = ?`,
    userId
  );

  if (!user?.active_room) {
    return bot.sendMessage(userId, 'Select a profile first');
  }

  const room = await db.get(
    `SELECT rooms.*, agents.name, agents.is_online, agents.admin_chat_id
     FROM rooms
     JOIN agents ON agents.id = rooms.agent_id
     WHERE rooms.id = ?`,
    user.active_room
  );

  if (room.is_online) {
    return bot.sendMessage(
      room.admin_chat_id,
      `👤 ${room.name}\nUser ID: ${userId}\n\n${msg.text}`,
      { reply_markup: { force_reply: true } }
    );
  }

  if (user.credits < 1) {
    return bot.sendMessage(userId, 'Out of credits');
  }

  await db.run(
    `UPDATE users SET credits = credits - 1 WHERE user_id = ?`,
    userId
  );

  await bot.sendChatAction(userId, 'typing');
  setTimeout(() => {
    bot.sendMessage(userId, aiReply(room.name));
  }, 2000);
});

// =========================================================
// ADMIN REPLY BRIDGE
// =========================================================
bot.on('message', async (msg) => {
  if (msg.from.id !== ADMIN_ID || !msg.reply_to_message) return;

  const match = msg.reply_to_message.text.match(/User ID: (\d+)/);
  if (!match) return;

  bot.sendMessage(match[1], msg.text);
});

// =========================================================
// ADMIN COMMANDS
// =========================================================
bot.onText(/\/online (.+)/, async (msg, m) => {
  if (msg.from.id !== ADMIN_ID) return;
  await db.run(`UPDATE agents SET is_online = 1 WHERE name = ?`, m[1]);
  bot.sendMessage(ADMIN_ID, `${m[1]} ONLINE`);
});

bot.onText(/\/offline (.+)/, async (msg, m) => {
  if (msg.from.id !== ADMIN_ID) return;
  await db.run(`UPDATE agents SET is_online = 0 WHERE name = ?`, m[1]);
  bot.sendMessage(ADMIN_ID, `${m[1]} OFFLINE`);
});

// =========================================================
// STARS PAYMENTS
// =========================================================
bot.on('pre_checkout_query', q =>
  bot.answerPreCheckoutQuery(q.id, true)
);

bot.on('message', async (msg) => {
  if (!msg.successful_payment) return;
  bot.sendMessage(msg.from.id, '💎 Content unlocked');
});

// =========================================================
// AI FALLBACK
// =========================================================
function aiReply(name) {
  const lines = [
    `Mmm… you’re making me curious 😌`,
    `I like how you talk to me.`,
    `Careful… you’re tempting me 💋`,
    `Maybe I’ll show you more later…`,
    `You’re trouble. I like that.`
  ];
  return `${name}: ` + lines[Math.floor(Math.random() * lines.length)];
}
