/**
 * SYNC HEARTS AGENCY — ULTIMATE EDITION
 * Features: Create/Edit/Delete Models, API, File Hosting, Admin Dashboard
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const express = require('express');
const cors = require('cors'); // NEW: Allows WebApp to get data
const fs = require('fs');
const path = require('path');
const axios = require('axios'); // NEW: To download photos

// =========================================================
// 1. CONFIGURATION & SERVER
// =========================================================
const app = express();
app.use(cors());
const PORT = process.env.PORT || 8080;

// NEW: Setup Image Hosting Folder
const UPLOAD_DIR = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
// This allows the internet to see your images at: /uploads/image.jpg
app.use('/uploads', express.static(UPLOAD_DIR));

// YOUR CREDENTIALS (Preserved from your upload)
const BOT_TOKEN = '8577711169:AAE8Av0ADtel8-4IbreUJe_08g-DenIhHXw';
const WEBAPP_URL = 'https://placidbarry.github.io/sync-hearts-app/'; 
const ADMIN_ID = 7640605912; 
// Change this to your live URL when deploying (e.g. https://myapp.onrender.com)
// For local testing, keep localhost.
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;

// NEW API: The Web App will call this to get the agent list
app.get('/api/agents', async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: "DB not ready" });
        const agents = await db.all('SELECT * FROM agents');
        
        // Format data for the Web App
        const formatted = agents.map(a => ({
            id: a.id,
            name: a.name,
            age: a.age || 23,
            location: a.location || 'Unknown',
            verified: true,
            premium: true,
            // Main photo (Photo 1)
            photo: a.photo1 ? `${SERVER_URL}/uploads/${a.photo1}` : 'https://placehold.co/400x500',
            // Gallery for potential future use
            gallery: [a.photo1, a.photo2, a.photo3].filter(p => p).map(p => `${SERVER_URL}/uploads/${p}`),
            stats: { rating: '5.0', chats: `${100 * a.id}k` }
        }));
        res.json(formatted);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// =========================================================
// 2. DATABASE SETUP (UPGRADED)
// =========================================================
let db;

(async () => {
    db = await open({ filename: './agency.db', driver: sqlite3.Database });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            first_name TEXT,
            username TEXT,
            credits INTEGER DEFAULT 0, 
            active_room_id INTEGER
        );
    `);

    // NEW SCHEMA: Stores 3 photos instead of 1 image_url
    await db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            age INTEGER DEFAULT 23,
            location TEXT DEFAULT 'Paris',
            photo1 TEXT,
            photo2 TEXT,
            photo3 TEXT,
            is_online INTEGER DEFAULT 0,
            admin_chat_id INTEGER
        );
    `);
    
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

    console.log('✅ Database Ready.');
})();

// =========================================================
// 3. ADMIN DASHBOARD (CREATE, EDIT, DELETE)
// =========================================================

// State Machine: Tracks if Admin is currently uploading a photo
const adminState = {}; 

// --- CREATE AGENT ---
bot.onText(/\/create/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    adminState[ADMIN_ID] = { step: 'CREATE_NAME', data: {} };
    bot.sendMessage(ADMIN_ID, "🆕 **Create New Model**\n\nPlease enter the **Name**:");
});

// --- EDIT AGENT ---
bot.onText(/\/edit (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];

    const agent = await db.get('SELECT * FROM agents WHERE name = ?', name);
    if (!agent) return bot.sendMessage(ADMIN_ID, `❌ Agent "${name}" not found.`);

    // Start editing flow
    adminState[ADMIN_ID] = { step: 'EDIT_photos_1', agent_id: agent.id };
    bot.sendMessage(ADMIN_ID, `✏️ **Editing ${name}**\n\nSend me **Photo #1** (Main Profile Picture).\n(Or type "skip" to keep current).`);
});

// --- DELETE AGENT (NEW) ---
bot.onText(/\/delete (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];

    const agent = await db.get('SELECT * FROM agents WHERE name = ?', name);
    if (!agent) return bot.sendMessage(ADMIN_ID, `❌ Agent "${name}" not found.`);

    await db.run('DELETE FROM agents WHERE name = ?', name);
    bot.sendMessage(ADMIN_ID, `🗑️ **Deleted:** Agent "${name}" has been removed.`);
});

// --- LIST AGENTS ---
bot.onText(/\/list/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const agents = await db.all('SELECT * FROM agents');
    if(agents.length === 0) return bot.sendMessage(ADMIN_ID, "No agents found. Use /create");
    
    let text = "📋 **Current Models:**\n";
    agents.forEach(a => text += `- ${a.name} (Online: ${a.is_online ? '✅' : '🔴'})\n`);
    bot.sendMessage(ADMIN_ID, text);
});

// =========================================================
// 4. MAIN LOGIC ROUTER
// =========================================================

bot.on('message', async (msg) => {
    const userId = msg.chat.id;

    // A. Priority: Admin Editing Flow
    if (userId === ADMIN_ID && adminState[ADMIN_ID]) {
        return handleAdminFlow(msg);
    }

    // B. WebApp Data (Registration / Selection)
    if (msg.web_app_data) {
        return handleWebAppData(msg);
    }

    // C. Regular Chat
    if (msg.text && msg.text.startsWith('/')) return; // Ignore commands
    await handleRegularChat(msg);
});

// ---------------------------------------------------------
// LOGIC A: Admin Flow (Uploading Photos)
// ---------------------------------------------------------
async function handleAdminFlow(msg) {
    const state = adminState[ADMIN_ID];

    // Step 1: Set Name
    if (state.step === 'CREATE_NAME') {
        const name = msg.text;
        try {
            const result = await db.run('INSERT INTO agents (name) VALUES (?)', name);
            adminState[ADMIN_ID] = { step: 'EDIT_photos_1', agent_id: result.lastID };
            bot.sendMessage(ADMIN_ID, `✅ Created **${name}**.\n\nNow upload **Photo #1** (Main).`);
        } catch (e) {
            bot.sendMessage(ADMIN_ID, `❌ Error: Name "${name}" already exists.`);
            delete adminState[ADMIN_ID];
        }
        return;
    }

    // Step 2, 3, 4: Handle Photos
    if (state.step.startsWith('EDIT_photos_')) {
        const photoIndex = state.step.split('_')[2]; // "1", "2", or "3"
        const colName = `photo${photoIndex}`;
        
        // Handle "skip"
        if (msg.text && msg.text.toLowerCase() === 'skip') {
            return advancePhotoStep(state.agent_id, parseInt(photoIndex));
        }

        // Handle Photo Upload
        if (msg.photo) {
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const fileName = `agent_${state.agent_id}_p${photoIndex}_${Date.now()}.jpg`;
            
            // Download logic
            const success = await downloadTelegramFile(fileId, fileName);
            if (success) {
                await db.run(`UPDATE agents SET ${colName} = ? WHERE id = ?`, [fileName, state.agent_id]);
                bot.sendMessage(ADMIN_ID, `✅ Photo ${photoIndex} Saved.`);
                return advancePhotoStep(state.agent_id, parseInt(photoIndex));
            } else {
                bot.sendMessage(ADMIN_ID, "❌ Failed to download. Try again.");
            }
            return;
        }

        bot.sendMessage(ADMIN_ID, "⚠️ Please send a photo (compressed) or type 'skip'.");
    }
}

function advancePhotoStep(agentId, currentStep) {
    if (currentStep < 3) {
        const next = currentStep + 1;
        adminState[ADMIN_ID] = { step: `EDIT_photos_${next}`, agent_id: agentId };
        bot.sendMessage(ADMIN_ID, `📸 Send **Photo #${next}** (or 'skip').`);
    } else {
        delete adminState[ADMIN_ID]; // Finish
        bot.sendMessage(ADMIN_ID, "🎉 **Setup Complete!**\nAgent is live on the API.");
    }
}

async function downloadTelegramFile(fileId, fileName) {
    try {
        const fileLink = await bot.getFileLink(fileId);
        const response = await axios({ url: fileLink, responseType: 'stream' });
        const filePath = path.join(UPLOAD_DIR, fileName);
        
        return new Promise((resolve) => {
            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);
            writer.on('finish', () => resolve(true));
            writer.on('error', () => resolve(false));
        });
    } catch (e) {
        console.error("Download error:", e);
        return false;
    }
}

// ---------------------------------------------------------
// LOGIC B: WebApp Data
// ---------------------------------------------------------
async function handleWebAppData(msg) {
    const userId = msg.chat.id;
    const data = JSON.parse(msg.web_app_data.data);

    if (data.action === 'register_new_user') {
        await db.run(`UPDATE users SET credits = 50 WHERE user_id = ?`, userId);
        return bot.sendMessage(userId, `✅ **Welcome!** 50 Free Credits added.`);
    }

    // Agent Selection (Using ID from API data)
    const agentId = data.agent_id; 
    if (agentId) {
        const agent = await db.get('SELECT * FROM agents WHERE id = ?', agentId);
        if (!agent) return;

        let room = await db.get('SELECT id FROM rooms WHERE user_id = ? AND agent_id = ?', [userId, agent.id]);
        if (!room) {
            const res = await db.run('INSERT INTO rooms (user_id, agent_id) VALUES (?, ?)', [userId, agent.id]);
            room = { id: res.lastID };
        }
        await db.run('UPDATE users SET active_room_id = ? WHERE user_id = ?', [room.id, userId]);

        const userVal = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
        if (userVal.credits > 0) {
            bot.sendMessage(userId, `💬 **Connected with ${agent.name}.**`, { 
                reply_markup: {
                    keyboard: [['📸 Pic (15)', '🎥 Video (50)'], ['🎁 Gift (5)', '💳 Balance'], ['❌ Leave Chat']],
                    resize_keyboard: true
                }
            });
        } else {
            bot.sendMessage(userId, `🔒 **Locked.** Please top up.`);
        }
    }
}

// ---------------------------------------------------------
// LOGIC C: Regular Chat (Human vs AI)
// ---------------------------------------------------------
async function handleRegularChat(msg) {
    const userId = msg.chat.id;

    // 1. Admin Replying to User
    if (userId === ADMIN_ID && msg.reply_to_message) {
        const match = msg.reply_to_message.text.match(/🆔 ID: (\d+)/);
        if (match) bot.sendMessage(match[1], msg.text);
        return;
    }

    // 2. User Chatting
    const user = await db.get(`
        SELECT u.credits, a.name, a.is_online, a.photo1, u.active_room_id
        FROM users u
        JOIN rooms r ON u.active_room_id = r.id 
        JOIN agents a ON r.agent_id = a.id
        WHERE u.user_id = ?`, userId);

    if (!user) {
        if (msg.text === '💳 Balance') {
             const c = await db.get('SELECT credits FROM users WHERE user_id =?', userId);
             return bot.sendMessage(userId, `Credits: ${c?.credits || 0}`);
        }
        return; 
    }

    // --- ACTIONS ---
    if (msg.text === '❌ Leave Chat') {
        await db.run('UPDATE users SET active_room_id = NULL WHERE user_id = ?', userId);
        return bot.sendMessage(userId, "👋 Chat closed.", { reply_markup: { remove_keyboard: true } });
    }

    if (msg.text.includes('📸 Pic')) {
        if (user.credits < 15) return bot.sendMessage(userId, "❌ Low balance.");
        await db.run('UPDATE users SET credits = credits - 15 WHERE user_id = ?', userId);
        
        // NEW: SENDS THE UPLOADED PHOTO FROM DB
        // The bot reads photo1 from DB, converts to URL, and Telegram fetches it.
        const photoUrl = `${SERVER_URL}/uploads/${user.photo1}`;
        
        bot.sendMessage(userId, "😘 *Sending private pic...*", { parse_mode: 'Markdown' });
        setTimeout(() => bot.sendPhoto(userId, photoUrl), 1000); 
        return;
    }
    
    // --- TEXT CHAT ---
    if (user.credits <= 0) return bot.sendMessage(userId, "🔒 No credits.");
    await db.run('UPDATE users SET credits = credits - 1 WHERE user_id = ?', userId);

    if (user.is_online) {
        // Forward to Admin
        const forward = `🔌 **${user.name}** (User: ${msg.from.first_name})\n🆔 ID: ${userId}\n\n"${msg.text}"`;
        bot.sendMessage(ADMIN_ID, forward);
    } else {
        // AI Placeholder
        bot.sendChatAction(userId, 'typing');
        setTimeout(() => bot.sendMessage(userId, "I'm listening... tell me more."), 2000);
    }
}

// Toggle Online/Offline
bot.onText(/\/online (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    await db.run('UPDATE agents SET is_online = 1 WHERE name = ?', match[1]);
    bot.sendMessage(ADMIN_ID, `🟢 ${match[1]} is ONLINE.`);
});

bot.onText(/\/offline (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    await db.run('UPDATE agents SET is_online = 0 WHERE name = ?', match[1]);
    bot.sendMessage(ADMIN_ID, `🔴 ${match[1]} is OFFLINE.`);
}); 
