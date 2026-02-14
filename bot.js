/**
 * SYNC HEARTS AGENCY — FINAL PRODUCTION BACKEND
 * Features: Admin Takeover, AI Fallback, Persistent Rooms, Stars Payments
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

// Health check for Render/Heroku to keep the bot alive
app.get('/', (_, res) => res.send('Sync Hearts Agency Bot is Running.'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const BOT_TOKEN = '8577711169:AAGnhnGoZ3U3-hIIj7zGkSXfk1uYWSODnwY';
const WEBAPP_URL = 'https://placidbarry.github.io/sync-hearts-app/';
const ADMIN_ID = 7640605912;

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

    // A. Users: Tracks credits and which "room" (agent) they are currently in
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            first_name TEXT,
            username TEXT,
            credits INTEGER DEFAULT 50,
            active_room_id INTEGER
        );
    `);

    // B. Agents: The models. 'admin_chat_id' routes messages to YOU.
    await db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            image_url TEXT,
            is_online INTEGER DEFAULT 0,
            admin_chat_id INTEGER
        );
    `);

    // C. Rooms: Links a specific User to a specific Agent. Persists chat state.
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

    // Seed Default Agents (Change names if needed)
    await db.run(`INSERT OR IGNORE INTO agents (name, is_online, admin_chat_id) VALUES ('Sophia', 0, ?)`, [ADMIN_ID]);
    await db.run(`INSERT OR IGNORE INTO agents (name, is_online, admin_chat_id) VALUES ('Elena', 0, ?)`, [ADMIN_ID]);

    console.log('✅ Database & Agency Ready.');
})();

// =========================================================
// 3. CONNECTION & WEBAPP HANDLER
// =========================================================

// Start Command
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const firstName = msg.from.first_name;

    // Register User
    await db.run(
        `INSERT INTO users (user_id, first_name, username) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET first_name = ?`,
        [userId, firstName, msg.from.username, firstName]
    );

    bot.sendMessage(userId, 
        `🔥 **Welcome to Sync Hearts, ${firstName}.**\n\nBrowse our exclusive models and choose your companion.`, 
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: "💋 View Models", web_app: { url: WEBAPP_URL } }]]
            }
        }
    );
});

// WebApp Data Handler (Navigation & Selection)
bot.on('message', async (msg) => {
    if (!msg.web_app_data) return;

    const userId = msg.chat.id;
    try {
        const data = JSON.parse(msg.web_app_data.data);
        console.log("WebApp Data:", data);

        // A. REGISTER NEW USER (From WebApp)
        if (data.action === 'register_new_user') {
            await db.run(`UPDATE users SET credits = credits + 50 WHERE user_id = ?`, userId);
            return bot.sendMessage(userId, `✅ **Registration Bonus!**\nYou received 50 free credits.`);
        }

        // B. NAVIGATION: OPEN CHATS
        if (data.action === 'open_chats') {
            const user = await db.get(`
                SELECT agents.name FROM users 
                JOIN rooms ON users.active_room_id = rooms.id 
                JOIN agents ON rooms.agent_id = agents.id 
                WHERE users.user_id = ?`, userId);
            
            const currentName = user ? user.name : "No one yet";
            return bot.sendMessage(userId, `📂 **Active Chat**\n\nCurrently speaking with: **${currentName}**\n\n👇 _Type below to chat._`, { parse_mode: 'Markdown' });
        }

        // C. NAVIGATION: WALLET
        if (data.action === 'open_wallet') {
            const user = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
            return bot.sendMessage(userId, `💳 **Balance:** ${user ? user.credits : 0} Credits.`);
        }

        // D. SELECT AGENT / INTERACTION
        // This handles "Chat" buttons OR "Gift/Action" buttons
        const agentName = data.agent_name || data.name;
        if (agentName) {
            // 1. Find Agent ID
            const agent = await db.get('SELECT id, name FROM agents WHERE name = ?', agentName);
            if (!agent) return bot.sendMessage(userId, "⚠️ Agent not found.");

            // 2. Find or Create Room
            let room = await db.get('SELECT id FROM rooms WHERE user_id = ? AND agent_id = ?', [userId, agent.id]);
            if (!room) {
                const result = await db.run('INSERT INTO rooms (user_id, agent_id) VALUES (?, ?)', [userId, agent.id]);
                room = { id: result.lastID };
            }

            // 3. Set Active Room for User
            await db.run('UPDATE users SET active_room_id = ? WHERE user_id = ?', [room.id, userId]);

            // 4. Handle Specific Actions (Gifts/Media)
            if (data.action === 'interaction') {
                const { sub_type, cost } = data;

                // -- Premium Media (Stars Invoice) --
                if (sub_type === 'pic' || sub_type === 'video') {
                    const price = sub_type === 'pic' ? 15 : 50;
                    await bot.sendInvoice(
                        userId,
                        `Private ${sub_type === 'pic' ? 'Photo' : 'Video'}`, 
                        `Unlock exclusive content from ${agent.name}`,
                        `unlock_${sub_type}_${agent.name}`, // Payload
                        "", // Provider Token (Empty for Stars)
                        "XTR", // Currency
                        [{ label: "Unlock Content", amount: price }]
                    );
                    return; // Stop here, wait for payment
                } 
                
                // -- Standard Actions (Credits) --
                else {
                    const userCredit = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
                    if (userCredit.credits < cost) return bot.sendMessage(userId, "❌ Not enough credits.");

                    await db.run('UPDATE users SET credits = credits - ? WHERE user_id = ?', [cost, userId]);
                    
                    let reply = "";
                    if (sub_type === 'flower') reply = `🌹 **You sent flowers.**\n${agent.name}: "Aww, these are beautiful! Thank you baby."`;
                    if (sub_type === 'naughty') reply = `🔥 **You sent a gift.**\n${agent.name}: "Mmm... you shouldn't have... but I love it."`;
                    
                    await bot.sendMessage(userId, reply, { parse_mode: 'Markdown' });
                }
            } else {
                // Just selecting the agent
                bot.sendMessage(userId, `💬 **Connected with ${agent.name}.**\nShe is online. Say hello! 👇`, { parse_mode: 'Markdown' });
            }
        }

    } catch (e) {
        console.error("WebApp Error:", e);
    }
});

// =========================================================
// 4. MESSAGE ROUTER (THE GHOST RELAY)
// =========================================================
bot.on('message', async (msg) => {
    // Filter: Ignore commands, admin messages, webapp data, payments
    if (!msg.text || msg.text.startsWith('/') || msg.chat.id === ADMIN_ID || msg.web_app_data || msg.successful_payment) return;

    const userId = msg.chat.id;

    // 1. Get User's Active Room
    const user = await db.get(`
        SELECT users.credits, rooms.agent_id, agents.name, agents.is_online, agents.admin_chat_id 
        FROM users 
        JOIN rooms ON users.active_room_id = rooms.id 
        JOIN agents ON rooms.agent_id = agents.id
        WHERE users.user_id = ?`, userId);

    if (!user) {
        return bot.sendMessage(userId, "⚠️ **No Active Chat.**\nPlease open the app and select a model first.");
    }

    // 2. ROUTING LOGIC
    if (user.is_online) {
        // --- HUMAN MODE (Forward to Admin) ---
        // Format: "User ID: <id>" is crucial for the reply handler
        const forwardText = `🔌 **${user.name} (Human Relay)**\nUser: ${msg.from.first_name} (ID: ${userId})\n\n"${msg.text}"`;
        
        await bot.sendMessage(user.admin_chat_id, forwardText, { 
            reply_markup: { force_reply: true } // Makes it easier to reply
        });
    } else {
        // --- AI MODE (Fallback) ---
        if (user.credits < 1) {
            return bot.sendMessage(userId, "❌ **Out of Credits.**\nOpen the app wallet to top up.");
        }

        // Deduct Credit
        await db.run('UPDATE users SET credits = credits - 1 WHERE user_id = ?', userId);

        // Simulation
        await fakeTyping(userId);
        const aiResponse = getAiReply(user.name);
        await bot.sendMessage(userId, aiResponse);
    }
});

// =========================================================
// 5. ADMIN REPLY HANDLER
// =========================================================
bot.on('message', async (msg) => {
    // Only process messages FROM Admin that are REPLIES
    if (msg.chat.id === ADMIN_ID && msg.reply_to_message) {
        
        // Extract the User ID from the original message text
        // Looks for: "User: Name (ID: 12345)"
        const match = msg.reply_to_message.text.match(/ID: (\d+)/);
        
        if (match && match[1]) {
            const targetUserId = match[1];
            await bot.sendMessage(targetUserId, msg.text); // Send as bot
            await bot.sendMessage(ADMIN_ID, "✅ Sent.");
        }
    }
});

// =========================================================
// 6. PAYMENT HANDLERS (TELEGRAM STARS)
// =========================================================

// Pre-checkout (Must always answer true for Stars)
bot.on('pre_checkout_query', (query) => {
    bot.answerPreCheckoutQuery(query.id, true);
});

// Successful Payment (Unlock Content)
bot.on('message', async (msg) => {
    if (msg.successful_payment) {
        const chatId = msg.chat.id;
        const payload = msg.successful_payment.invoice_payload; // e.g., "unlock_pic_Sophia"

        await bot.sendMessage(chatId, "💎 **Payment Successful!** Sending your private content...");

        // Simulate sending content based on payload
        if (payload.includes('pic')) {
            // Replace with your actual file ID or URL
            await bot.sendPhoto(chatId, 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1', { caption: "Here you go, love. 💋" });
        } 
        else if (payload.includes('video')) {
            await bot.sendVideo(chatId, 'https://www.w3schools.com/html/mov_bbb.mp4', { caption: "Don't show this to anyone. 🤫" });
        }
    }
});

// =========================================================
// 7. ADMIN COMMANDS
// =========================================================
bot.onText(/\/online (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];
    
    // Set Online
    await db.run('UPDATE agents SET is_online = 1 WHERE name = ?', name);
    bot.sendMessage(ADMIN_ID, `🟢 **${name} is now ONLINE.**\nYou will receive her messages.`);

    // Notify active users
    const users = await db.all(`
        SELECT users.user_id FROM users 
        JOIN rooms ON users.active_room_id = rooms.id 
        JOIN agents ON rooms.agent_id = agents.id 
        WHERE agents.name = ?`, name);
        
    users.forEach(u => {
        bot.sendMessage(u.user_id, `💬 **${name} is back online.**\nShe just saw your messages...`);
    });
});

bot.onText(/\/offline (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];
    await db.run('UPDATE agents SET is_online = 0 WHERE name = ?', name);
    bot.sendMessage(ADMIN_ID, `🔴 **${name} is now OFFLINE.**\nAI will handle replies.`);
});

// =========================================================
// 8. HELPERS (AI & TYPING)
// =========================================================

// Simulates human typing speed
async function fakeTyping(chatId) {
    await bot.sendChatAction(chatId, 'typing');
    // Random delay between 2s and 4.5s
    const delay = Math.floor(Math.random() * 2500) + 2000; 
    return new Promise(resolve => setTimeout(resolve, delay));
}

// Generates a Safe, Flirty Response
function getAiReply(agentName) {
    const responses = [
        `Mmm... you really know how to get my attention. 😏`,
        `I was just looking at your profile picture... tell me something real about you.`,
        `You're making me blush over here. 🙈 What else?`,
        `I love it when you talk to me like that.`,
        `I’d tell you what I’m thinking, but you might have to unlock a photo to see... 📸`,
        `You’re trouble, aren't you? I like trouble. 💋`,
        `Stop teasing me... or actually, don't stop.`,
        `I wish you were here to whisper that in my ear.`
    ];
    return responses[Math.floor(Math.random() * responses.length)];
}
