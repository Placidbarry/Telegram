/**
 * SYNC HEARTS AGENCY - FINAL PRODUCTION BACKEND
 * Features: Admin Takeover, AI Fallback, Credit System, Image Management
 */

require('dotenv').config(); 
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

// =========================================================
// 🔴 CONFIGURATION
// =========================================================
// Replace these with your actual details
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
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
    await db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
            name TEXT PRIMARY KEY,
            image_url TEXT,
            is_online BOOLEAN DEFAULT 0
        );
    `);

    // Seed Default Agents
    await db.run(`INSERT OR IGNORE INTO agents (name, is_online) VALUES ('Sophia', 0)`);
    await db.run(`INSERT OR IGNORE INTO agents (name, is_online) VALUES ('Elena', 0)`);

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

// Handle WebApp Data (When user clicks in the App)
bot.on('message', async (msg) => {
    if (msg.web_app_data) {
        const chatId = msg.chat.id;
        try {
            const data = JSON.parse(msg.web_app_data.data);

            // Logic for when user selects an agent or action
            // Assuming your frontend sends { action: 'select_agent', agent_name: 'Sophia' }
            // or { action: 'interaction', agent_name: 'Sophia', cost: 10 }
            
            const agentName = data.agent_name || 'Sophia'; // Default to Sophia if missing
            
            // Update User's Active Agent
            await db.run('UPDATE users SET current_agent_name = ? WHERE user_id = ?', [agentName, chatId]);

            bot.sendMessage(chatId, `💬 **You are now connected with ${agentName}.**\n\nShe is waiting for your message. Type below! 👇`);
            
        } catch (e) {
            console.error("Error parsing WebApp data", e);
        }
    }
});

// =========================================================
// 3. THE "GHOST RELAY" (Core Logic)
// =========================================================

bot.on('message', async (msg) => {
    // Filter out commands, admin messages, and non-text
    if (!msg.text || msg.text.startsWith('/') || msg.chat.id === ADMIN_ID || msg.web_app_data) return;

    const userId = msg.chat.id;
    const user = await db.get('SELECT * FROM users WHERE user_id = ?', userId);

    // 1. Validate User
    if (!user || !user.current_agent_name) {
        return bot.sendMessage(userId, "⚠️ Please open the app and select a model first.");
    }

    if (user.credits < 1) {
        return bot.sendMessage(userId, "❌ Out of credits. Please top up.");
    }

    // 2. Deduct Credit
    await db.run('UPDATE users SET credits = credits - 1 WHERE user_id = ?', userId);

    // 3. Check if Agent is Online (Human Mode)
    const agent = await db.get('SELECT * FROM agents WHERE name = ?', user.current_agent_name);
    const isHumanOnline = agent ? agent.is_online : 0;

    if (isHumanOnline) {
        // --- HUMAN MODE ---
        // Forward message to ADMIN (You)
        // We add a specific header so we know who to reply to
        const forwardText = `🔌 **${user.current_agent_name} Relay**\nUser: ${user.first_name || 'Anon'} (ID: ${userId})\n\n"${msg.text}"`;
        await bot.sendMessage(ADMIN_ID, forwardText);
    } else {
        // --- AI MODE (Fallback) ---
        bot.sendChatAction(userId, 'typing');
        setTimeout(async () => {
            const reply = await getAiReply(msg.text, user.current_agent_name);
            bot.sendMessage(userId, reply);
        }, 2000); // 2-second simulated delay
    }
});

// =========================================================
// 4. ADMIN CONTROL (How you text back)
// =========================================================

// Handle Admin Replies
bot.on('message', async (msg) => {
    // Only accept messages from Admin that are Replies to another message
    if (msg.chat.id === ADMIN_ID && msg.reply_to_message) {
        const originalText = msg.reply_to_message.text;
        
        // Extract User ID from the message you are replying to
        // Format: "User: Name (ID: 12345)"
        const match = originalText.match(/ID: (\d+)/);
        
        if (match && match[1]) {
            const targetUserId = match[1];
            // Send YOUR text to the user, appearing as the bot
            await bot.sendMessage(targetUserId, msg.text);
            await bot.sendMessage(ADMIN_ID, "✅ Sent as agent.");
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
