/**
 * SYNC HEARTS AGENCY - FINAL PRODUCTION BACKEND
 * Features: Admin Takeover, AI Fallback, Credit System, Image Management
 */

require('dotenv').config(); 
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const express = require('express');
const app = express();
const port = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.send('Sync Hearts Bot is running!');
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
// =========================================================
// 🔴 CONFIGURATION
// =========================================================
// Replace these with your actual details
const BOT_TOKEN = process.env.BOT_TOKEN || '8577711169:AAHNCiGfnnxMRyZnnvLg9JKVaNrjZ1-9KHc';
const ADMIN_ID = parseInt(process.env.ADMIN_ID) || 7640605912; // Your ID from the upload
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://placidbarry.github.io/sync-hearts-app/';

// =========================================================
// 1. DATABASE SETUP (Auto-creates agency.db)
// =========================================================
let db;

async function initDb() {
    db = await open({
        filename: './agency.db',
        driver: sqlite3.Database
    });

    // Users: Tracks credits and who they are currently chatting with
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            first_name TEXT,
            username TEXT,
            credits INTEGER DEFAULT 50,
            current_agent_name TEXT DEFAULT NULL
        );
    `);

    // Agents: Tracks if YOU (the human) are online for them
    // We added 'admin_chat_id' so the bot knows where to forward user messages
    await db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
            name TEXT PRIMARY KEY,
            image_url TEXT,
            is_online BOOLEAN DEFAULT 0,
            admin_chat_id INTEGER DEFAULT ${ADMIN_ID} 
        );
    `);

    // Seed Default Agents (Ensures they exist with your Admin ID)
    await db.run(`INSERT OR IGNORE INTO agents (name, is_online, admin_chat_id) VALUES ('Sophia', 0, ?)`, [ADMIN_ID]);
    await db.run(`INSERT OR IGNORE INTO agents (name, is_online, admin_chat_id) VALUES ('Elena', 0, ?)`, [ADMIN_ID]);

    console.log('✅ Database Ready. Agency Open.');
}

initDb();

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// =========================================================
// 2. CONNECTION HANDLERS
// =========================================================

// Start Command
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await db.run(`INSERT OR IGNORE INTO users (user_id, credits) VALUES (?, 50)`, chatId);
    
    bot.sendMessage(chatId, `🔥 **Welcome to the Agency**\n\nBrowse our models and choose your companion.`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: "💋 View Models", web_app: { url: WEBAPP_URL } }]]
        }
    });
});

// =========================================================
// HANDLE WEBAPP DATA (Strict Routing)
// =========================================================
bot.on('message', async (msg) => {
    if (msg.web_app_data) {
        const chatId = msg.chat.id;
        try {
            const data = JSON.parse(msg.web_app_data.data);
            console.log("WebApp Data Received:", data); // Debugging

            switch (data.action) {
                // 1. REGISTRATION
                case 'register_new_user':
                    const { firstName } = data.user_data;
                    await db.run(`INSERT OR REPLACE INTO users (user_id, first_name, credits) VALUES (?, ?, ?)`, 
                        [chatId, firstName, 50]); 
                    await bot.sendMessage(chatId, `✅ **Welcome, ${firstName}!**\n\nYour account is created with 50 credits.\nType /start or open the app to browse models.`);
                    break;

                // 2. NAVIGATION: OPEN CHATS (Fixes the freeze)
                case 'open_chats':
                    const user = await db.get('SELECT current_agent_name FROM users WHERE user_id = ?', chatId);
                    const current = user?.current_agent_name || "No one yet";
                    await bot.sendMessage(chatId, `📂 **Active Chat Room**\n\nCurrent Model: **${current}**\n\n👇 *Type a message below to chat with her!*`);
                    break;

                // 3. NAVIGATION: WALLET
                case 'open_wallet':
                    const uCredit = await db.get('SELECT credits FROM users WHERE user_id = ?', chatId);
                    await bot.sendMessage(chatId, `💳 **Your Wallet**\n\nBalance: **${uCredit?.credits || 0} Credits**\n\n(Top-up integration coming soon)`);
                    break;

                // 4. INTERACTION (Gifts/Actions)
                case 'interaction':
                    const { sub_type, agent_name, cost } = data;
                    
                    // Deduct and Update Room
                    await db.run('UPDATE users SET credits = credits - ? WHERE user_id = ?', [cost, chatId]);
                    await db.run('UPDATE users SET current_agent_name = ? WHERE user_id = ?', [agent_name, chatId]);

                    let replyText = "";
                    if (sub_type === 'text') replyText = `💬 **You are now chatting with ${agent_name}.**\nShe is waiting for your reply...`;
                    else if (sub_type === 'flower') replyText = `🌹 **You sent flowers to ${agent_name}.**\nShe is blushing!`;
                    else if (sub_type === 'pic') replyText = `📸 **Request sent to ${agent_name}.**\n(She will send a photo shortly)`;
                    else replyText = `🔥 **Interaction sent to ${agent_name}.**`;

                    await bot.sendMessage(chatId, replyText);
                    break;

                // 5. DEFAULT: AGENT SELECTION (Browsing)
                // This catches simple agent clicks
                default:
                    // If the app sent a name but no specific action, treat as "Enter Room"
                    const targetName = data.agent_name || data.name || data.action; 
                    if (targetName) {
                        await db.run('UPDATE users SET current_agent_name = ? WHERE user_id = ?', [targetName, chatId]);
                        await bot.sendMessage(chatId, `💋 **Connected with ${targetName}.**\n\nType "Hi" to start chatting! 👇`);
                    }
                    break;
            }
        } catch (e) {
            console.error("Error parsing WebApp data", e);
        }
    }
});

// =========================================================
// 3. THE "GHOST RELAY" (Router)
// =========================================================

bot.on('message', async (msg) => {
    // 1. FILTER: Ignore commands, admin replies, and WebApp data packets
    if (!msg.text || msg.text.startsWith('/') || msg.chat.id === ADMIN_ID || msg.web_app_data) return;

    const userId = msg.chat.id;
    const user = await db.get('SELECT * FROM users WHERE user_id = ?', userId);

    // 2. VALIDATION: Does user have an active agent?
    if (!user || !user.current_agent_name) {
        return bot.sendMessage(userId, "⚠️ **No Active Chat**\n\nPlease open the app and select a model to talk to.");
    }

    // 3. CHECK AGENT STATUS
    const agent = await db.get('SELECT * FROM agents WHERE name = ?', user.current_agent_name);
    
    // If agent doesn't exist in DB yet, default to AI mode
    const isHumanOnline = agent ? agent.is_online : 0;
    const targetAdmin = agent ? agent.admin_chat_id : ADMIN_ID;

    // 4. ROUTING
    if (isHumanOnline) {
        // --- HUMAN MODE (Relay to Admin) ---
        const forwardText = `🔌 **${user.current_agent_name} (Human Mode)**\nUser: ${user.first_name} (ID: ${userId})\n\n"${msg.text}"`;
        
        // We force a reply interface so Admin replies go back to THIS user
        await bot.sendMessage(targetAdmin, forwardText);
        
        // Optional: Tick receipt
        // bot.sendMessage(userId, "READ", { disable_notification: true }); 
    } else {
        // --- AI MODE (Credits + Fallback) ---
        if (user.credits < 1) {
            return bot.sendMessage(userId, "❌ **Out of Credits**\n\nPlease open the wallet to top up.");
        }

        // Deduct 1 Credit per AI message
        await db.run('UPDATE users SET credits = credits - 1 WHERE user_id = ?', userId);

        bot.sendChatAction(userId, 'typing');
        setTimeout(async () => {
            const reply = await getAiReply(msg.text, user.current_agent_name);
            bot.sendMessage(userId, reply);
        }, 1500); // 1.5s delay for realism
    }
});

// =========================================================
// 4. ADMIN CONTROL (Human Response)
// =========================================================

bot.on('message', async (msg) => {
    // Check if this is the ADMIN speaking
    if (msg.chat.id === ADMIN_ID && msg.reply_to_message) {
        
        // We look at the message the Admin is replying TO
        const originalText = msg.reply_to_message.text;
        
        // Extract User ID: Expects format "User: Name (ID: 12345)"
        const match = originalText.match(/ID: (\d+)/);
        
        if (match && match[1]) {
            const targetUserId = match[1];
            
            // Send the text to the user (appearing as the bot/agent)
            await bot.sendMessage(targetUserId, msg.text);
            
            // Confirm to Admin
            await bot.sendMessage(ADMIN_ID, "✅ Sent.");
        } else {
            bot.sendMessage(ADMIN_ID, "❌ Could not find User ID in that message.");
        }
    }
});

// Admin Commands
bot.onText(/\/admin/, (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    bot.sendMessage(ADMIN_ID, 
        `👑 **Admin Dashboard**\n` +
        `/online <name> - Take over chat\n` +
        `/offline <name> - Return to AI\n` +
        `/setimage <name> <url> - Change pic\n` +
        `/credits <id> <amount> - Give coins`
    );
});

// 1. Toggle Online (Takeover)
bot.onText(/\/online (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];
    await db.run('INSERT OR IGNORE INTO agents (name) VALUES (?)', name);
    await db.run('UPDATE agents SET is_online = 1 WHERE name = ?', name);
    bot.sendMessage(ADMIN_ID, `🟢 **${name} is ONLINE.**\nYou will now receive her messages.`);
});

// 2. Toggle Offline (AI Mode)
bot.onText(/\/offline (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];
    await db.run('UPDATE agents SET is_online = 0 WHERE name = ?', name);
    bot.sendMessage(ADMIN_ID, `🔴 **${name} is OFFLINE.**\nAI will handle replies.`);
});

// 3. Change Agent Image
bot.onText(/\/setimage (.+?) (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];
    const url = match[2];
    await db.run('UPDATE agents SET image_url = ? WHERE name = ?', [url, name]);
    bot.sendMessage(ADMIN_ID, `🖼️ Image updated for ${name}.`);
});

// 4. Give Credits
bot.onText(/\/credits (.+) (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const userId = match[1];
    const amount = match[2];
    await db.run('UPDATE users SET credits = credits + ? WHERE user_id = ?', [amount, userId]);
    bot.sendMessage(ADMIN_ID, `💰 Added ${amount} credits to User ${userId}`);
});

// =========================================================
// 5. AI LOGIC (Simple Fallback)
// =========================================================
async function getAiReply(text, agentName) {
    // You can replace this with an OpenAI API call later
    const responses = [
        "That's so interesting... tell me more? 😘",
        "I was just thinking about you.",
        "I wish you were here right now.",
        "You always know what to say to make me smile.",
        "Send me a picture? I want to see you. 😉"
    ];
    return responses[Math.floor(Math.random() * responses.length)];
                    }
