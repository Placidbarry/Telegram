/**
 * SYNC HEARTS AGENCY — ULTIMATE EDITION
 * Features: Create/Edit/Delete Models, API, File Hosting, Admin Dashboard
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios'); 
const multer = require('multer');

// =========================================================
// 1. SERVER CONFIGURATION
// =========================================================
const app = express();
app.use(cors());
app.use(express.json()); 

const PORT = process.env.PORT || 8080;
const UPLOAD_DIR = path.join(__dirname, 'public/uploads');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
app.use('/uploads', express.static(UPLOAD_DIR));

// Configure Multer for Client Uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, 'client-' + Date.now() + '.jpg')
});
const upload = multer({ storage: storage });

// API: Handle Client Photo Upload
app.post('/api/upload_client', upload.single('photo'), (req, res) => {
    if(req.file) res.json({ url: `${SERVER_URL}/uploads/${req.file.filename}` });
    else res.status(400).send("Error");
});

// Environment Variables
const BOT_TOKEN = process.env.BOT_TOKEN; 
const WEBAPP_URL = process.env.WEBAPP_URL; 
const ADMIN_ID = Number(process.env.ADMIN_ID); 
const SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

if (!BOT_TOKEN || !WEBAPP_URL) {
    console.error("❌ CRITICAL ERROR: Missing BOT_TOKEN or WEBAPP_URL in Environment Variables.");
    process.exit(1);
}

// Start Server
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// =========================================================
// 2. TELEGRAM & WEBHOOK SETUP
// =========================================================
const bot = new TelegramBot(BOT_TOKEN); 
const webhookUrl = `${SERVER_URL}/bot${BOT_TOKEN}`;
bot.setWebHook(webhookUrl);
console.log(`🔗 Webhook set to: ${webhookUrl}`);

app.post(`/bot${BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// =========================================================
// 3. DATABASE SETUP
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
            active_room_id INTEGER,
            profile_photo TEXT, 
            real_name TEXT      
        );
    `);

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

// API: Get Agents for Web App
app.get('/api/agents', async (req, res) => {
    try {
        if (!db) return res.status(500).json({ error: "DB not ready" });
        const agents = await db.all('SELECT * FROM agents');
        
        const formatted = agents.map(a => ({
            id: a.id,
            name: a.name,
            age: a.age || 23,
            location: a.location || 'Unknown',
            verified: true,
            premium: true,
            photo: a.photo1 ? `${SERVER_URL}/uploads/${a.photo1}` : 'https://placehold.co/400x500',
            gallery: [a.photo1, a.photo2, a.photo3].filter(p => p).map(p => `${SERVER_URL}/uploads/${p}`),
            stats: { rating: '5.0', chats: `${100 * a.id}k` }
        }));
        res.json(formatted);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// =========================================================
// 4. MAIN LOGIC ROUTER (The Fix for Conflicting Handlers)
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

    // C. Regular Chat & Commands
    if (msg.text && msg.text.startsWith('/')) return; // Ignore commands (handled by onText)
    await handleRegularChat(msg);
});

// =========================================================
// 5. ADMIN COMMANDS & FLOW
// =========================================================
const adminState = {}; 

// /create
bot.onText(/\/create/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    adminState[ADMIN_ID] = { step: 'CREATE_NAME', data: {} };
    bot.sendMessage(ADMIN_ID, "🆕 **Create New Model**\n\nPlease enter the **Name**:");
});

// /edit [name]
bot.onText(/\/edit (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];

    const agent = await db.get('SELECT * FROM agents WHERE name = ?', name);
    if (!agent) return bot.sendMessage(ADMIN_ID, `❌ Agent "${name}" not found.`);

    // Start editing from Age
    adminState[ADMIN_ID] = { step: 'EDIT_AGE', agent_id: agent.id };
    bot.sendMessage(ADMIN_ID, `✏️ **Editing ${name}**\n\nFirst, enter the **Age** (e.g. 24):`);
});

// /delete [name]
bot.onText(/\/delete (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];
    await db.run('DELETE FROM agents WHERE name = ?', name);
    bot.sendMessage(ADMIN_ID, `🗑️ **Deleted:** Agent "${name}" has been removed.`);
});

// /list
bot.onText(/\/list/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const agents = await db.all('SELECT * FROM agents');
    if(agents.length === 0) return bot.sendMessage(ADMIN_ID, "No agents found. Use /create");
    
    let text = "📋 **Current Models:**\n";
    agents.forEach(a => text += `- ${a.name} (Online: ${a.is_online ? '✅' : '🔴'})\n`);
    bot.sendMessage(ADMIN_ID, text);
});

// /online & /offline
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

// /wipe_all_data
bot.onText(/\/wipe_all_data/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    bot.sendMessage(msg.chat.id, "⚠️ **WARNING** ⚠️\nType `/confirm_wipe` to delete ALL data.");
});

bot.onText(/\/confirm_wipe/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    await db.run('DELETE FROM users');
    await db.run('DELETE FROM agents');
    await db.run('DELETE FROM rooms');
    bot.sendMessage(msg.chat.id, "✅ **Database Wiped Successfully.**");
});

// ---------------------------------------------------------
// LOGIC A: Admin Flow Handler (Merged & Fixed)
// ---------------------------------------------------------
async function handleAdminFlow(msg) {
    const state = adminState[ADMIN_ID];

    // Step 1: Create Name
    if (state.step === 'CREATE_NAME') {
        const name = msg.text;
        try {
            const result = await db.run('INSERT INTO agents (name) VALUES (?)', name);
            // Move to Age immediately after name
            adminState[ADMIN_ID] = { step: 'EDIT_AGE', agent_id: result.lastID };
            bot.sendMessage(ADMIN_ID, `✅ Created **${name}**.\n\nNow enter the **Age** (e.g. 23).`);
        } catch (e) {
            bot.sendMessage(ADMIN_ID, `❌ Error: Name "${name}" already exists.`);
            delete adminState[ADMIN_ID];
        }
        return;
    }

    // Step 2: Edit Age
    if (state.step === 'EDIT_AGE') {
        const age = parseInt(msg.text);
        if(!isNaN(age)) {
            await db.run('UPDATE agents SET age = ? WHERE id = ?', [age, state.agent_id]);
            // Now move to photos
            adminState[ADMIN_ID] = { step: 'EDIT_photos_1', agent_id: state.agent_id };
            bot.sendMessage(ADMIN_ID, "✅ Age Updated.\n\nNow upload **Photo #1** (Main) or type 'skip'.");
        } else {
            bot.sendMessage(ADMIN_ID, "⚠️ Please enter a number for Age.");
        }
        return;
    }

    // Step 3, 4, 5: Handle Photos
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

// =========================================================
// 6. USER LOGIC
// =========================================================

// /start
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'User';

    try {
        await db.run(
            `INSERT INTO users (user_id, first_name, credits) VALUES (?, ?, 0)
             ON CONFLICT(user_id) DO UPDATE SET first_name = ?`,
            [userId, firstName, firstName]
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
    } catch (e) {
        console.error("Start Error:", e);
    }
});

// Logic B: WebApp Data
async function handleWebAppData(msg) {
    const userId = msg.chat.id;
    
    try {
        const data = JSON.parse(msg.web_app_data.data);

        // 1. REGISTRATION
        if (data.action === 'register_new_user') {
            const { age, country, photo_url } = data.user_data;
            
            await db.run(`
                INSERT INTO users (user_id, first_name, credits, profile_photo) 
                VALUES (?, ?, 50, ?)
                ON CONFLICT(user_id) DO UPDATE SET 
                credits = 50, profile_photo = ?
            `, [userId, msg.from.first_name, photo_url || null, photo_url || null]);

            if(photo_url) {
                bot.sendMessage(ADMIN_ID, `🆕 **New Client:** ${msg.from.first_name} (${age}, ${country})\nPhoto: ${photo_url}`);
            }
            return bot.sendMessage(userId, `✅ **Registration Complete!**\n\n💰 50 Free Credits added.`);
        }

        // 2. AGENT SELECTION
        if (data.action === 'select_agent') {
            const agentId = data.agent_id; 
            const agent = await db.get('SELECT * FROM agents WHERE id = ?', agentId);
            if (!agent) return;

            let room = await db.get('SELECT id FROM rooms WHERE user_id = ? AND agent_id = ?', [userId, agent.id]);
            if (!room) {
                const res = await db.run('INSERT INTO rooms (user_id, agent_id) VALUES (?, ?)', [userId, agent.id]);
                room = { id: res.lastID };
            }
            await db.run('UPDATE users SET active_room_id = ? WHERE user_id = ?', [room.id, userId]);

            const userVal = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
            
            bot.sendMessage(userId, `💬 **Connected with ${agent.name}.**`, { 
                reply_markup: {
                    keyboard: [['📸 Pic (15)', '🎥 Video (50)'], ['🎁 Gift (5)', '💳 Balance'], ['❌ Leave Chat']],
                    resize_keyboard: true
                }
            });
        }
    } catch (e) {
        console.error("WebApp Error:", e);
    }
}

// Logic C: Regular Chat
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
