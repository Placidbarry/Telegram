/**
 * SYNC HEARTS AGENCY - PROFESSIONAL BACKEND
 * * Features:
 * 1. Hybrid AI/Human Routing (Ghost Relay)
 * 2. SQLite Database for Persistence
 * 3. Admin "God Mode" Dashboard
 */

const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const fs = require('fs');

// =========================================================
// 🔴 CONFIGURATION (EDIT THESE)
// =========================================================
const BOT_TOKEN = '8577711169:AAE8Av0ADtel8-4IbreUJe_08g-DenIhHXw'; 
const ADMIN_ID = 7640605912; // Your Personal Telegram ID
const WEBAPP_URL = 'https://placidbarry.github.io/sync-hearts-app/'; 

// =========================================================
// 1. DATABASE INITIALIZATION
// =========================================================
let db;

async function initDb() {
    db = await open({
        filename: './agency.db',
        driver: sqlite3.Database
    });

    // Users Table
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            first_name TEXT,
            username TEXT,
            credits INTEGER DEFAULT 50,
            current_agent_name TEXT DEFAULT NULL,
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Agents Configuration Table (For Online/Offline Status)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
            name TEXT PRIMARY KEY,
            is_online BOOLEAN DEFAULT 0,
            auto_reply_style TEXT DEFAULT 'flirty'
        );
    `);

    // Seed default agents if they don't exist
    const agentList = ['Sophia', 'Elena', 'Jessica', 'Isabella'];
    for (const agent of agentList) {
        await db.run(`INSERT OR IGNORE INTO agents (name, is_online) VALUES (?, 0)`, agent);
    }

    console.log('✅ Database connected. Agency is ready.');
}

initDb();

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// =========================================================
// 2. WEB APP HANDLER (The Bridge)
// =========================================================

// Handle /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    // Ensure user exists
    await db.run(`INSERT OR IGNORE INTO users (user_id, credits) VALUES (?, 50)`, chatId);
    
    bot.sendMessage(chatId, `🔥 **Welcome to Sync Hearts**\n\nTap below to find your perfect companion.`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: "💋 Enter Agency", web_app: { url: WEBAPP_URL } }]]
        }
    });
});

// Handle Data sent from the App (Registration & "Chat" clicks)
bot.on('message', async (msg) => {
    if (!msg.web_app_data) return;

    const chatId = msg.chat.id;
    const data = JSON.parse(msg.web_app_data.data);

    // A. USER REGISTERED
    if (data.action === 'register_new_user') {
        const u = data.user_data;
        await db.run(`
            INSERT OR REPLACE INTO users (user_id, first_name, username, credits, current_agent_name)
            VALUES (?, ?, ?, ?, ?)
        `, [chatId, u.firstName, u.username, 50 + (data.bonus_credits || 0), null]);

        bot.sendMessage(chatId, `✅ **Profile Created!**\n💰 Balance: 50 Coins.\n\nOpen the app again to pick a companion.`);
        bot.sendMessage(ADMIN_ID, `🆕 **New User:** ${u.firstName} (${u.country})`);
    }

    // B. USER SELECTED "CHAT" OR SENT GIFT
    if (data.action === 'interaction') {
        const cost = data.cost;
        const agentName = data.agent_name;
        
        // 1. Check Credits
        const user = await db.get('SELECT credits FROM users WHERE user_id = ?', chatId);
        if (!user || user.credits < cost) {
            return bot.sendMessage(chatId, `❌ **Insufficient Credits**\nYou have ${user ? user.credits : 0} coins.`);
        }

        // 2. Deduct Credits & Set Active Agent
        await db.run('UPDATE users SET credits = credits - ?, current_agent_name = ? WHERE user_id = ?', [cost, agentName, chatId]);

        // 3. Send Confirmation (The "Chat Opened" Logic)
        if (data.sub_type === 'text') {
            await bot.sendMessage(chatId, `💬 **Connected with ${agentName}**\n\nShe is waiting... Type your message here directly in Telegram! 👇`);
        } else {
            // It was a gift/pic request
            await bot.sendMessage(chatId, `✅ **${data.sub_type.toUpperCase()} Sent!**\n${agentName} received your request.`);
            
            // Allow user to chat now
            await bot.sendMessage(chatId, `(You can now chat with ${agentName} here. Just type!)`);
        }

        // 4. Notify Admin
        bot.sendMessage(ADMIN_ID, `💰 **Income: ${cost} Coins**\nUser: ${msg.from.first_name}\nAgent: ${agentName}\nAction: ${data.sub_type}`);
    }
});

// =========================================================
// 3. THE GHOST RELAY (Chat Routing)
// =========================================================

bot.on('message', async (msg) => {
    // Ignore commands, web app data, and admin replies
    if (msg.text && !msg.text.startsWith('/') && !msg.web_app_data && msg.chat.id !== ADMIN_ID) {
        const userId = msg.chat.id;

        // 1. Who is this user talking to?
        const user = await db.get('SELECT * FROM users WHERE user_id = ?', userId);
        
        if (!user || !user.current_agent_name) {
            return bot.sendMessage(userId, "⚠️ Please open the Agency App and select a girl to chat with first!");
        }

        const agentName = user.current_agent_name;

        // 2. Check Agent Status (Online/Offline)
        const agentConfig = await db.get('SELECT is_online FROM agents WHERE name = ?', agentName);
        const isOnline = agentConfig ? agentConfig.is_online : 0;

        // 3. Deduct 1 Credit for the message
        if (user.credits < 1) {
            return bot.sendMessage(userId, "❌ **Zero Balance.** Please buy credits.");
        }
        await db.run('UPDATE users SET credits = credits - 1 WHERE user_id = ?', userId);

        // === SCENARIO A: AGENT IS ONLINE (Human Relay) ===
        if (isOnline) {
            // Forward to Admin so you can reply
            // We include a hidden ID tag so the bot knows who to reply to later
            const forwardText = `🔌 **LIVE CHAT**\nUser: ${user.first_name} (ID: ${userId})\nTo: ${agentName}\n\n"${msg.text}"`;
            
            // We store the context in a way we can reply. 
            // The simplest way is to force a Reply to the message in Telegram.
            await bot.sendMessage(ADMIN_ID, forwardText);
        } 
        
        // === SCENARIO B: AGENT IS OFFLINE (AI Fallback) ===
        else {
            // Simulate typing
            bot.sendChatAction(userId, 'typing');
            
            // Simple Random AI Response (You can connect ChatGPT here later)
            setTimeout(() => {
                const replies = [
                    "Mmm tell me more... 😘",
                    "I was just thinking about you!",
                    "You're cute. Send me a pic?",
                    "I'm a bit busy but I love reading your texts.",
                    "What are you wearing? 😈",
                    "Come closer..."
                ];
                const randomReply = replies[Math.floor(Math.random() * replies.length)];
                bot.sendMessage(userId, randomReply);
            }, 2000); // 2 second delay
        }
    }
});

// =========================================================
// 4. ADMIN GOD MODE (You replying)
// =========================================================

// Handle Admin Replies
bot.on('message', async (msg) => {
    if (msg.chat.id === ADMIN_ID && msg.reply_to_message) {
        
        // Parse the original message to find the User ID
        // Format was: "User: Name (ID: 12345)"
        const originalText = msg.reply_to_message.text;
        const idMatch = originalText.match(/ID: (\d+)/);

        if (idMatch && idMatch[1]) {
            const targetUserId = idMatch[1];
            
            // Send YOUR text to the User as the Bot
            await bot.sendMessage(targetUserId, msg.text);
            await bot.sendMessage(ADMIN_ID, "✅ Sent.");
        }
    }
});

// =========================================================
// 5. ADMIN COMMANDS
// =========================================================

// Check Agents: /agents
bot.onText(/\/agents/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const agents = await db.all('SELECT * FROM agents');
    let report = "🕵️‍♀️ **Agent Status:**\n\n";
    agents.forEach(a => {
        report += `${a.name}: ${a.is_online ? '🟢 ONLINE' : '🔴 OFFLINE'}\n`;
    });
    bot.sendMessage(ADMIN_ID, report);
});

// Toggle Online: /online Sophia
bot.onText(/\/online (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1]; // e.g., "Sophia"
    await db.run('UPDATE agents SET is_online = 1 WHERE name = ?', name);
    bot.sendMessage(ADMIN_ID, `✅ **${name} is now ONLINE.**\nMessages will be forwarded to you.`);
});

// Toggle Offline: /offline Sophia
bot.onText(/\/offline (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];
    await db.run('UPDATE agents SET is_online = 0 WHERE name = ?', name);
    bot.sendMessage(ADMIN_ID, `💤 **${name} is now OFFLINE.**\nAI will handle replies.`);
});

// Add Credits: /add 12345 100
bot.onText(/\/add (.+) (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const userId = match[1];
    const amount = match[2];
    await db.run('UPDATE users SET credits = credits + ? WHERE user_id = ?', [amount, userId]);
    bot.sendMessage(ADMIN_ID, `Added ${amount} coins to ${userId}`);
});
