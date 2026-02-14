/**
 * SYNC HEARTS AGENCY — FULL BACKEND
 * Handlers: Registration, Wallet, Direct Chat, In-Chat Actions (Pic/Video/Gift)
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const express = require('express');

// =========================================================
// 1. CONFIGURATION & SERVER
// =========================================================
const app = express();
const PORT = process.env.PORT || 8080;

// Simple health check for hosting platforms
app.get('/', (_, res) => res.send('Sync Hearts Agency Bot is Running.'));
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// Load Environment Variables
const BOT_TOKEN = '8577711169:AAE8Av0ADtel8-4IbreUJe_08g-DenIhHXw';
const WEBAPP_URL = 'https://placidbarry.github.io/sync-hearts-app/'; 
const ADMIN_ID = 7640605912; 

if (!BOT_TOKEN || !WEBAPP_URL) {
    console.error("❌ MISSING CONFIG: Check your .env file for BOT_TOKEN and WEBAPP_URL");
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// =========================================================
// 2. DATABASE SETUP
// =========================================================
let db;

(async () => {
    db = await open({
        filename: './agency.db',
        driver: sqlite3.Database
    });

    // A. Users Table (Stores credits and current room)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            first_name TEXT,
            username TEXT,
            credits INTEGER DEFAULT 0, 
            active_room_id INTEGER
        );
    `);

    // B. Agents Table (Stores model info)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            image_url TEXT,
            is_online INTEGER DEFAULT 0,
            admin_chat_id INTEGER
        );
    `);

    // C. Rooms Table (Links User to Agent)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            agent_id INTEGER,
            status TEXT DEFAULT 'ai',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, agent_id)
        );
    `);

    // D. Seed Default Agents (If not exist)
    await db.run(`INSERT OR IGNORE INTO agents (name, image_url) VALUES ('Sophia', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330')`);
    await db.run(`INSERT OR IGNORE INTO agents (name, image_url) VALUES ('Elena', 'https://images.unsplash.com/photo-1534528741775-53994a69daeb')`);
    await db.run(`INSERT OR IGNORE INTO agents (name, image_url) VALUES ('Jessica', 'https://images.unsplash.com/photo-1517841905240-472988babdf9')`);
    await db.run(`INSERT OR IGNORE INTO agents (name, image_url) VALUES ('Isabella', 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1')`);

    console.log('✅ Database Ready & Seeding Complete.');
})();

// =========================================================
// 3. WEB APP DATA HANDLER (The "Gateway")
// =========================================================

// Handle /start command
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const firstName = msg.from.first_name;

    // Ensure user exists in DB
    await db.run(
        `INSERT INTO users (user_id, first_name, username) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET first_name = ?`,
        [userId, firstName, msg.from.username, firstName]
    );

    bot.sendMessage(userId, 
        `🔥 **Welcome, ${firstName}.**\n\nTap below to enter the agency and browse models.`, 
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: "💋 Enter Agency", web_app: { url: WEBAPP_URL } }]]
            }
        }
    );
});

// Handle Data sent FROM the Web App (Registration, Wallet, Selection)
bot.on('message', async (msg) => {
    if (!msg.web_app_data) return;

    const userId = msg.chat.id;
    try {
        const data = JSON.parse(msg.web_app_data.data);
        console.log(`Received WebApp Data from ${userId}:`, data.action);

        // --- SCENARIO 1: NEW USER REGISTRATION ---
        if (data.action === 'register_new_user') {
            // Give them the 50 Free Coins
            await db.run(`UPDATE users SET credits = 50 WHERE user_id = ?`, userId);
            
            return bot.sendMessage(userId, 
                `✅ **Registration Successful!**\n\n💰 **50 Free Credits** added to your account.\n\nYou can now select a model to chat with.`
            );
        }

        // --- SCENARIO 2: OPEN WALLET ---
        if (data.action === 'open_wallet') {
            const user = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
            return bot.sendMessage(userId, 
                `💳 **Wallet Balance**\n\nCurrent Credits: **${user ? user.credits : 0}**\n\n(To add more, contact support - *Payment link placeholder*)`
            );
        }

        // --- SCENARIO 3: SELECT AGENT (Enter Chat Room) ---
        const agentName = data.agent_name || data.name; 
        if (agentName) {
            // 1. Find Agent
            const agent = await db.get('SELECT id, name FROM agents WHERE name = ?', agentName);
            if (!agent) return bot.sendMessage(userId, "❌ Error: Agent not found.");

            // 2. Create or Retrieve Room
            let room = await db.get('SELECT id FROM rooms WHERE user_id = ? AND agent_id = ?', [userId, agent.id]);
            if (!room) {
                const result = await db.run('INSERT INTO rooms (user_id, agent_id) VALUES (?, ?)', [userId, agent.id]);
                room = { id: result.lastID };
            }
            
            // 3. Mark User as "In Room"
            await db.run('UPDATE users SET active_room_id = ? WHERE user_id = ?', [room.id, userId]);

            // 4. Send "Connected" Message WITH THE CUSTOM KEYBOARD
            const userVal = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
            
            // Check if they have credits to start
            if (userVal.credits > 0) {
                bot.sendMessage(userId, 
                    `💬 **Connected with ${agent.name}.**\n\n` +
                    `She is online and waiting.\n` +
                    `Use the buttons below to interact! 👇`, 
                    { 
                        parse_mode: 'Markdown',
                        reply_markup: {
                            // THIS IS THE IN-CHAT CONTROL PANEL
                            keyboard: [
                                ['📸 Pic (15)', '🎥 Video (50)'],
                                ['🎁 Gift (5)', '💳 Balance'],
                                ['❌ Leave Chat']
                            ],
                            resize_keyboard: true,
                            one_time_keyboard: false
                        }
                    }
                );
            } else {
                bot.sendMessage(userId, 
                    `🔒 **${agent.name} is Locked.**\n\nYou have 0 credits. Please buy more coins to chat.`,
                    { parse_mode: 'Markdown' }
                );
            }
        }

    } catch (e) {
        console.error("WebApp Error:", e);
    }
});

// =========================================================
// 4. CHAT MESSAGE & ACTION HANDLER
// =========================================================

bot.on('message', async (msg) => {
    // Ignore commands, web_app_data, or admin messages
    if (!msg.text || msg.text.startsWith('/') || msg.web_app_data || msg.chat.id === ADMIN_ID) return;

    const userId = msg.chat.id;

    // 1. Check if User is in a Room
    const user = await db.get(`
        SELECT users.credits, agents.name, agents.image_url, agents.is_online 
        FROM users 
        JOIN rooms ON users.active_room_id = rooms.id 
        JOIN agents ON rooms.agent_id = agents.id
        WHERE users.user_id = ?`, userId);

    if (!user) {
        // Allow basic commands if not in room, otherwise ignore
        if (msg.text === '💳 Balance') {
             const bal = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
             return bot.sendMessage(userId, `Credits: ${bal ? bal.credits : 0}`);
        }
        return; // User is not in a room, ignore text
    }

    // ===========================
    // HANDLE SPECIAL ACTIONS
    // ===========================

    // --- LEAVE CHAT ---
    if (msg.text === '❌ Leave Chat') {
        await db.run('UPDATE users SET active_room_id = NULL WHERE user_id = ?', userId);
        return bot.sendMessage(userId, "👋 You left the chat. Open the app to choose another model.", {
            reply_markup: { remove_keyboard: true } // Hides the buttons
        });
    }

    // --- CHECK BALANCE ---
    if (msg.text === '💳 Balance') {
        return bot.sendMessage(userId, `💎 **Balance:** ${user.credits} Credits`, { parse_mode: 'Markdown' });
    }

    // --- SEND PIC (Cost: 15) ---
    if (msg.text.includes('📸 Pic')) {
        if (user.credits < 15) return sendLowBalanceAlert(userId);
        
        await db.run('UPDATE users SET credits = credits - 15 WHERE user_id = ?', userId);
        
        bot.sendMessage(userId, "😘 *Sending photo...*", { parse_mode: 'Markdown' });
        
        // Simulating upload delay
        setTimeout(() => {
            bot.sendPhoto(userId, user.image_url, { 
                caption: `Here is a private pic for you... ❤️\n(Credits left: ${user.credits - 15})` 
            });
        }, 1000);
        return;
    }

    // --- SEND VIDEO (Cost: 50) ---
    if (msg.text.includes('🎥 Video')) {
        if (user.credits < 50) return sendLowBalanceAlert(userId);
        
        await db.run('UPDATE users SET credits = credits - 50 WHERE user_id = ?', userId);
        
        bot.sendMessage(userId, "🎥 *Uploading video... (this might take a moment)*", { parse_mode: 'Markdown' });
        
        setTimeout(() => {
            // NOTE: Replace this text with an actual video file_id or URL in production
            bot.sendMessage(userId, `🎬 **VIDEO SENT**\n\n(In production, this would be a real video file.)\n\nCredits left: ${user.credits - 50}`, { parse_mode: 'Markdown' });
        }, 2000);
        return;
    }

    // --- SEND GIFT (Cost: 5) ---
    if (msg.text.includes('🎁 Gift')) {
        if (user.credits < 5) return sendLowBalanceAlert(userId);
        
        await db.run('UPDATE users SET credits = credits - 5 WHERE user_id = ?', userId);
        return bot.sendMessage(userId, `🌹 **Gift Sent!**\n\n${user.name}: "Aww, thank you baby! I love it." ❤️`, { parse_mode: 'Markdown' });
    }

// ===========================
    // HANDLE REGULAR TEXT CHAT (AI vs HUMAN)
    // ===========================

    // 1. Check Lock (0 Credits)
    if (user.credits <= 0) {
        return bot.sendMessage(userId, `🔒 **Chat Locked**\n\nYou have run out of credits.`, { parse_mode: 'Markdown' });
    }

    // 2. Deduct 1 Credit
    await db.run('UPDATE users SET credits = credits - 1 WHERE user_id = ?', userId);

    // 3. CHECK MODE: IS AGENT ONLINE?
    // If the agent is marked "Online" in DB, we forward to Human.
    // If "Offline", the AI replies.
    
    if (user.is_online === 1) {
        // --- HUMAN MODE ---
        // Forward the message to the ADMIN_ID so you can reply.
        // We add the UserID in the text so the bot knows who to reply to later.
        const forwardText = `🔌 **${user.name}** (User: ${msg.from.first_name})\n🆔 ID: ${userId}\n\n"${msg.text}"`;
        
        await bot.sendMessage(ADMIN_ID, forwardText);
        
        // Optional: You can send a "Read Receipt" or "Typing" status to the user here
        await bot.sendChatAction(userId, 'typing');
        
    } else {
        // --- AI MODE ---
        // Agent is offline, so the Bot replies automatically.
        await fakeTyping(userId);
        const reply = getAiReply(user.name);
        bot.sendMessage(userId, reply);
    }
});

// =========================================================
// 6. NEW: ADMIN REPLY HANDLER (The "No Command" Logic)
// =========================================================

// This listens for YOUR messages in the Admin Chat
bot.on('message', async (msg) => {
    // Only process messages from the Admin that are REPLIES
    if (msg.chat.id !== ADMIN_ID || !msg.reply_to_message) return;

    // 1. Extract the User's ID from the message you are replying to
    // We look for the "🆔 ID: 12345" pattern we created above
    const textToParse = msg.reply_to_message.text;
    const match = textToParse.match(/🆔 ID: (\d+)/);

    if (match && match[1]) {
        const targetUserId = match[1];

        // 2. Send YOUR text to the User (as the Bot)
        // The user sees this as coming from "Sophia" or "Elena"
        await bot.sendMessage(targetUserId, msg.text);

        // Confirmation for you
        // await bot.sendMessage(ADMIN_ID, "✅ Sent"); // Optional: Comment out to reduce spam
    }
});

// Switch Agent to HUMAN MODE
bot.onText(/\/online (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const agentName = match[1]; // e.g., "/online Sophia"
    await db.run('UPDATE agents SET is_online = 1 WHERE name = ?', agentName);
    bot.sendMessage(ADMIN_ID, `🟢 ${agentName} is now ONLINE (Human Mode).`);
});

// Switch Agent to AI MODE
bot.onText(/\/offline (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const agentName = match[1]; // e.g., "/offline Sophia"
    await db.run('UPDATE agents SET is_online = 0 WHERE name = ?', agentName);
    bot.sendMessage(ADMIN_ID, `🔴 ${agentName} is now OFFLINE (AI Mode).`);
});

// =========================================================
// 5. HELPER FUNCTIONS
// =========================================================

function sendLowBalanceAlert(userId) {
    bot.sendMessage(userId, "❌ **Insufficient Credits**\n\nYou don't have enough coins for this action.");
}

async function fakeTyping(chatId) {
    await bot.sendChatAction(chatId, 'typing');
    // Random delay between 1.5s and 3.5s for realism
    const delay = Math.floor(Math.random() * 2000) + 1500; 
    return new Promise(resolve => setTimeout(resolve, delay));
}

function getAiReply(agentName) {
    const responses = [
        "Tell me more about that...",
        "I was just thinking about you. 😉",
        "You always know what to say.",
        "That's so interesting!",
        "I'm feeling a bit lonely, glad you're here.",
        "Do you want to see a picture? 📸",
        "Send me a gift if you really like me. 🌹"
    ];
    return responses[Math.floor(Math.random() * responses.length)];
}
