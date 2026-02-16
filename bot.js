/**
 * SYNC HEARTS AGENCY — ULTIMATE EDITION with Inline Keyboards & Group Chats
 * Features: Client registration, inline menus, group creation, coin deduction, admin panel.
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

// ----------------------------------------------------------------------
// EXPRESS SETUP
// ----------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

const UPLOAD_DIR = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
app.use('/uploads', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, 'client-' + Date.now() + '.jpg')
});
const upload = multer({ storage: storage });

// ----------------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ----------------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;  // optional, can be null
const ADMIN_ID = Number(process.env.ADMIN_ID);
const SERVER_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

if (!BOT_TOKEN || !ADMIN_ID) {
    console.error("❌ CRITICAL ERROR: Missing BOT_TOKEN or ADMIN_ID in Environment Variables.");
    process.exit(1);
}

// ----------------------------------------------------------------------
// TELEGRAM BOT (WEBHOOK MODE)
// ----------------------------------------------------------------------
const bot = new TelegramBot(BOT_TOKEN);
const webhookUrl = `${SERVER_URL}/bot${BOT_TOKEN}`;
bot.setWebHook(webhookUrl);
console.log(`🔗 Webhook set to: ${webhookUrl}`);

app.post(`/bot${BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// ----------------------------------------------------------------------
// DATABASE (initialized asynchronously)
// ----------------------------------------------------------------------
let db;

(async () => {
    db = await open({ filename: './agency.db', driver: sqlite3.Database });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            first_name TEXT,
            username TEXT,
            credits INTEGER DEFAULT 0,
            profile_photo TEXT,
            real_name TEXT,
            registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS groups (
            group_id INTEGER PRIMARY KEY,
            user_id INTEGER,
            agent_id INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, agent_id)
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS user_active_group (
            user_id INTEGER PRIMARY KEY,
            group_id INTEGER
        );
    `);

    console.log('✅ Database Ready.');
})();

// ----------------------------------------------------------------------
// HELPER FUNCTIONS
// ----------------------------------------------------------------------
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

function advancePhotoStep(agentId, currentStep) {
    if (currentStep < 3) {
        const next = currentStep + 1;
        adminState[ADMIN_ID] = { step: `EDIT_photos_${next}`, agent_id: agentId };
        bot.sendMessage(ADMIN_ID, `📸 Send **Photo #${next}** (or 'skip').`);
    } else {
        delete adminState[ADMIN_ID];
        bot.sendMessage(ADMIN_ID, "🎉 **Setup Complete!**\nAgent is live.");
    }
}

// Send main client menu (inline)
async function sendClientMainMenu(userId, firstName) {
    const user = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
    const credits = user ? user.credits : 0;
    const activeGroup = await db.get('SELECT group_id FROM user_active_group WHERE user_id = ?', userId);
    const keyboard = {
        inline_keyboard: [
            [{ text: "🔍 Browse Models", callback_data: "browse_agents" }],
            [{ text: "💰 My Balance", callback_data: "balance" }],
            [{ text: "💳 Buy Credits", callback_data: "buy" }]
        ]
    };
    if (activeGroup) {
        keyboard.inline_keyboard.push([{ text: "💬 My Group", callback_data: "my_group" }]);
    }
    await bot.sendMessage(userId, `👋 Welcome, ${firstName}!\nYou have ${credits} credits.`, {
        reply_markup: keyboard
    });
}

// Create a private group for client and admin (agent)
async function createAgentGroup(userId, agentId) {
    try {
        // Check if group already exists
        const existing = await db.get('SELECT group_id FROM groups WHERE user_id = ? AND agent_id = ?', [userId, agentId]);
        if (existing) {
            // Update active group
            await db.run('INSERT OR REPLACE INTO user_active_group (user_id, group_id) VALUES (?, ?)', [userId, existing.group_id]);
            return existing.group_id;
        }

        // Get agent details
        const agent = await db.get('SELECT * FROM agents WHERE id = ?', agentId);
        if (!agent) throw new Error('Agent not found');

        // Create group with client and admin (ADMIN_ID is the agent)
        const chat = await bot.createNewGroupChat([userId, ADMIN_ID], `Chat with ${agent.name}`);
        const groupId = chat.id;

        // Store in database
        await db.run('INSERT INTO groups (group_id, user_id, agent_id) VALUES (?, ?, ?)', [groupId, userId, agentId]);
        await db.run('INSERT OR REPLACE INTO user_active_group (user_id, group_id) VALUES (?, ?)', [userId, groupId]);

        // Send welcome message with inline actions
        const welcomeText = `💬 You are now chatting with ${agent.name}.\nEach message costs 1 credit.\nUse the buttons below for extra content.`;
        const inlineKeyboard = {
            inline_keyboard: [
                [{ text: "📸 Photo (15 credits)", callback_data: "send_photo" }],
                [{ text: "🎥 Video (50 credits)", callback_data: "send_video" }],
                [{ text: "🎁 Gift (5 credits)", callback_data: "send_gift" }],
                [{ text: "💳 My Balance", callback_data: "balance_group" }],
                [{ text: "🚪 Leave Group", callback_data: "leave_group" }]
            ]
        };
        await bot.sendMessage(groupId, welcomeText, { reply_markup: inlineKeyboard });

        // Notify admin
        await bot.sendMessage(ADMIN_ID, `🆕 New group created with client ${userId} for agent ${agent.name}.`);
        return groupId;
    } catch (e) {
        console.error('Error creating group:', e);
        await bot.sendMessage(userId, "❌ Failed to create group. Please try again later.");
        return null;
    }
}

// ----------------------------------------------------------------------
// ADMIN STATE MACHINE (for creating/editing agents)
// ----------------------------------------------------------------------
const adminState = {};

// ----------------------------------------------------------------------
// COMMAND HANDLERS (using onText)
// ----------------------------------------------------------------------

// /start - User welcome & registration
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'User';
    const username = msg.from.username || '';

    try {
        if (!db) return bot.sendMessage(userId, "System initializing, please try again later.");

        // Check if user exists
        const user = await db.get('SELECT user_id FROM users WHERE user_id = ?', userId);
        if (!user) {
            // New user: give 50 free credits
            await db.run(
                `INSERT INTO users (user_id, first_name, username, credits) VALUES (?, ?, ?, 50)`,
                [userId, firstName, username]
            );
            await bot.sendMessage(userId, "🎉 Welcome! You've received 50 free credits.");
        }

        await sendClientMainMenu(userId, firstName);
    } catch (e) {
        console.error("Start Error:", e);
    }
});

// Admin commands

bot.onText(/\/create/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    adminState[ADMIN_ID] = { step: 'CREATE_NAME' };
    bot.sendMessage(ADMIN_ID, "🆕 **Create New Model**\n\nPlease enter the **Name**:");
});

bot.onText(/\/edit (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];
    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");
        const agent = await db.get('SELECT * FROM agents WHERE name = ?', name);
        if (!agent) return bot.sendMessage(ADMIN_ID, `❌ Agent "${name}" not found.`);
        adminState[ADMIN_ID] = { step: 'EDIT_AGE', agent_id: agent.id };
        bot.sendMessage(ADMIN_ID, `✏️ **Editing ${name}**\n\nEnter the **Age** (e.g. 24):`);
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

bot.onText(/\/delete (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];
    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");
        const agent = await db.get('SELECT * FROM agents WHERE name = ?', name);
        if (!agent) return bot.sendMessage(ADMIN_ID, `❌ Agent "${name}" not found.`);
        await db.run('DELETE FROM agents WHERE name = ?', name);
        bot.sendMessage(ADMIN_ID, `🗑️ **Deleted:** Agent "${name}" has been removed.`);
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

bot.onText(/\/list/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");
        const agents = await db.all('SELECT * FROM agents');
        if (agents.length === 0) return bot.sendMessage(ADMIN_ID, "No agents found. Use /create");
        let text = "📋 **Current Models:**\n";
        agents.forEach(a => text += `- ${a.name} (Online: ${a.is_online ? '✅' : '🔴'})\n`);
        bot.sendMessage(ADMIN_ID, text);
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

bot.onText(/\/online (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");
        await db.run('UPDATE agents SET is_online = 1 WHERE name = ?', match[1]);
        bot.sendMessage(ADMIN_ID, `🟢 ${match[1]} is ONLINE.`);
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

bot.onText(/\/offline (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");
        await db.run('UPDATE agents SET is_online = 0 WHERE name = ?', match[1]);
        bot.sendMessage(ADMIN_ID, `🔴 ${match[1]} is OFFLINE.`);
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

// Add credits to a client
bot.onText(/\/addcredits (\d+) (\d+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const userId = parseInt(match[1]);
    const amount = parseInt(match[2]);
    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");
        await db.run('UPDATE users SET credits = credits + ? WHERE user_id = ?', [amount, userId]);
        bot.sendMessage(ADMIN_ID, `✅ Added ${amount} credits to user ${userId}.`);
        bot.sendMessage(userId, `💰 You received ${amount} credits!`);
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

// List all clients
bot.onText(/\/clients/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");
        const clients = await db.all('SELECT user_id, first_name, username, credits FROM users ORDER BY registered_at DESC LIMIT 20');
        if (clients.length === 0) return bot.sendMessage(ADMIN_ID, "No clients yet.");
        let text = "📋 **Recent Clients:**\n";
        clients.forEach(c => text += `- ${c.first_name} (@${c.username || 'no username'}) ID: ${c.user_id} | Credits: ${c.credits}\n`);
        bot.sendMessage(ADMIN_ID, text);
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

// List active groups
bot.onText(/\/groups/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");
        const groups = await db.all(`
            SELECT g.group_id, u.first_name, u.user_id, a.name as agent_name
            FROM groups g
            JOIN users u ON g.user_id = u.user_id
            JOIN agents a ON g.agent_id = a.id
        `);
        if (groups.length === 0) return bot.sendMessage(ADMIN_ID, "No active groups.");
        let text = "📋 **Active Groups:**\n";
        groups.forEach(g => text += `- Group ${g.group_id} | Client: ${g.first_name} (${g.user_id}) | Agent: ${g.agent_name}\n`);
        bot.sendMessage(ADMIN_ID, text);
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

// Wipe all data (danger)
bot.onText(/\/wipe_all_data/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    bot.sendMessage(msg.chat.id, "⚠️ **WARNING** ⚠️\n\nThis will delete:\n- All Users & Credits\n- All Created Agents\n- All Groups\n\nType `/confirm_wipe` to proceed.");
});

bot.onText(/\/confirm_wipe/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");
        await db.run('DELETE FROM users');
        await db.run('DELETE FROM agents');
        await db.run('DELETE FROM groups');
        await db.run('DELETE FROM user_active_group');
        await db.run('DELETE FROM sqlite_sequence');
        bot.sendMessage(msg.chat.id, "✅ **Database Wiped Successfully.**");
    } catch (error) {
        bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
    }
});

// Reset only clients
bot.onText(/\/reset_clients/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");
        await db.run('DELETE FROM users');
        await db.run('DELETE FROM groups');
        await db.run('DELETE FROM user_active_group');
        bot.sendMessage(ADMIN_ID, "✅ **Clients Wiped.**\nAll user accounts and groups deleted.\nModels are SAFE.");
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

// ----------------------------------------------------------------------
// MAIN MESSAGE HANDLER (non-command)
// ----------------------------------------------------------------------
bot.on('message', async (msg) => {
    // Ignore commands (handled by onText)
    if (msg.text && msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Admin editing flow (private chat)
    if (chatId === ADMIN_ID && adminState[ADMIN_ID]) {
        await handleAdminFlow(msg);
        return;
    }

    // Group messages
    if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
        await handleGroupMessage(msg);
        return;
    }

    // Private chat with client (non-command) – maybe handle balance inquiry etc., but we rely on inline buttons.
});

// ----------------------------------------------------------------------
// ADMIN FLOW HANDLER
// ----------------------------------------------------------------------
async function handleAdminFlow(msg) {
    const state = adminState[ADMIN_ID];
    if (!state) return;

    try {
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

        if (state.step === 'EDIT_AGE') {
            const age = parseInt(msg.text);
            if (!isNaN(age)) {
                await db.run('UPDATE agents SET age = ? WHERE id = ?', [age, state.agent_id]);
                adminState[ADMIN_ID] = { step: 'EDIT_photos_1', agent_id: state.agent_id };
                bot.sendMessage(ADMIN_ID, "✅ Age Updated.\n\nNow upload **Photo #1** (or type 'skip').");
            } else {
                bot.sendMessage(ADMIN_ID, "⚠️ Please enter a number for Age.");
            }
            return;
        }

        if (state.step.startsWith('EDIT_photos_')) {
            const photoIndex = state.step.split('_')[2];
            const colName = `photo${photoIndex}`;

            if (msg.text && msg.text.toLowerCase() === 'skip') {
                return advancePhotoStep(state.agent_id, parseInt(photoIndex));
            }

            if (msg.photo) {
                const fileId = msg.photo[msg.photo.length - 1].file_id;
                const fileName = `agent_${state.agent_id}_p${photoIndex}_${Date.now()}.jpg`;

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
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
        delete adminState[ADMIN_ID];
    }
}

// ----------------------------------------------------------------------
// GROUP MESSAGE HANDLER
// ----------------------------------------------------------------------
async function handleGroupMessage(msg) {
    const groupId = msg.chat.id;
    const userId = msg.from.id;

    // Ignore messages from bot itself
    if (userId === bot.botId) return;

    // Check if this group is in our database
    const group = await db.get('SELECT * FROM groups WHERE group_id = ?', groupId);
    if (!group) return; // not our group

    // Determine if sender is the client
    if (userId !== group.user_id) {
        // Message from admin (agent) – no deduction, just let it pass
        return;
    }

    // Sender is client: deduct 1 credit per message (text, photo, etc.)
    const user = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
    if (!user) return;

    if (user.credits <= 0) {
        // Delete message and notify
        try {
            await bot.deleteMessage(groupId, msg.message_id);
            await bot.sendMessage(groupId, "⚠️ You have 0 credits. Please buy more to continue chatting.", {
                reply_markup: {
                    inline_keyboard: [[{ text: "💳 Buy Credits", callback_data: "buy_from_group" }]]
                }
            });
        } catch (e) {}
        return;
    }

    // Deduct one credit
    await db.run('UPDATE users SET credits = credits - 1 WHERE user_id = ?', userId);

    // Optional: notify admin about low balance
    if (user.credits - 1 <= 5) {
        bot.sendMessage(ADMIN_ID, `⚠️ Client ${userId} has low balance (${user.credits-1} credits).`);
    }
}

// ----------------------------------------------------------------------
// CALLBACK QUERY HANDLER (inline buttons)
// ----------------------------------------------------------------------
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const userId = callbackQuery.from.id;
    const chatId = msg.chat.id;

    await bot.answerCallbackQuery(callbackQuery.id);

    // Handle different callbacks
    if (data === 'browse_agents') {
        // Show list of agents as inline buttons
        const agents = await db.all('SELECT id, name FROM agents WHERE is_online = 1');
        if (!agents.length) {
            return bot.sendMessage(chatId, "No agents available at the moment.");
        }
        const buttons = agents.map(a => [{
            text: a.name,
            callback_data: `select_agent_${a.id}`
        }]);
        await bot.sendMessage(chatId, "Choose a model:", {
            reply_markup: { inline_keyboard: buttons }
        });
    }
    else if (data.startsWith('select_agent_')) {
        const agentId = parseInt(data.split('_')[2]);
        // Create group for this client and agent
        const groupId = await createAgentGroup(userId, agentId);
        if (groupId) {
            await bot.sendMessage(chatId, `✅ Group created! Join the chat:`, {
                reply_markup: {
                    inline_keyboard: [[{ text: "Go to Group", url: `https://t.me/c/${groupId.toString().replace('-100', '')}` }]]
                }
            });
        }
    }
    else if (data === 'balance' || data === 'balance_group') {
        const user = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
        await bot.sendMessage(chatId, `💰 Your balance: ${user ? user.credits : 0} credits.`);
    }
    else if (data === 'buy' || data === 'buy_from_group') {
        // Notify admin
        const user = await db.get('SELECT first_name, username FROM users WHERE user_id = ?', userId);
        const name = user ? user.first_name : 'Unknown';
        await bot.sendMessage(ADMIN_ID, `💳 Purchase request from ${name} (ID: ${userId}).\nPlease add credits via /addcredits ${userId} <amount>.`);
        await bot.sendMessage(chatId, "Your request has been sent to admin. You will be credited shortly after payment (crypto/gift card).");
    }
    else if (data === 'my_group') {
        const active = await db.get('SELECT group_id FROM user_active_group WHERE user_id = ?', userId);
        if (active) {
            await bot.sendMessage(chatId, "Your active group:", {
                reply_markup: {
                    inline_keyboard: [[{ text: "Open Group", url: `https://t.me/c/${active.group_id.toString().replace('-100', '')}` }]]
                }
            });
        } else {
            await bot.sendMessage(chatId, "You don't have an active group. Browse models first.");
        }
    }
    else if (data === 'leave_group') {
        const active = await db.get('SELECT group_id FROM user_active_group WHERE user_id = ?', userId);
        if (active) {
            // Kick the client from the group
            try {
                await bot.kickChatMember(active.group_id, userId);
                await bot.unbanChatMember(active.group_id, userId); // allow rejoin later if needed
            } catch (e) {}
            await db.run('DELETE FROM groups WHERE group_id = ?', active.group_id);
            await db.run('DELETE FROM user_active_group WHERE user_id = ?', userId);
            await bot.sendMessage(chatId, "👋 You have left the group. To start a new chat, browse models again.");
            await bot.sendMessage(active.group_id, "The client has left the group.");
        } else {
            await bot.sendMessage(chatId, "You are not in any group.");
        }
    }
    else if (data === 'send_photo') {
        // Deduct 15 credits and send a photo from the agent's gallery
        const group = await db.get('SELECT * FROM groups WHERE group_id = ?', chatId);
        if (!group) return;
        const user = await db.get('SELECT credits FROM users WHERE user_id = ?', group.user_id);
        if (user.credits < 15) {
            return bot.sendMessage(chatId, "❌ Insufficient credits. You need 15.");
        }
        await db.run('UPDATE users SET credits = credits - 15 WHERE user_id = ?', group.user_id);
        const agent = await db.get('SELECT photo1 FROM agents WHERE id = ?', group.agent_id);
        if (agent && agent.photo1) {
            const photoUrl = `${SERVER_URL}/uploads/${agent.photo1}`;
            await bot.sendPhoto(chatId, photoUrl, { caption: "Here's your private photo 😘" });
        } else {
            await bot.sendMessage(chatId, "No photo available.");
        }
    }
    else if (data === 'send_video') {
        // Similar, but for video (placeholder)
        const group = await db.get('SELECT * FROM groups WHERE group_id = ?', chatId);
        if (!group) return;
        const user = await db.get('SELECT credits FROM users WHERE user_id = ?', group.user_id);
        if (user.credits < 50) {
            return bot.sendMessage(chatId, "❌ Insufficient credits. You need 50.");
        }
        await db.run('UPDATE users SET credits = credits - 50 WHERE user_id = ?', group.user_id);
        await bot.sendMessage(chatId, "🎥 Video feature coming soon!");
    }
    else if (data === 'send_gift') {
        const group = await db.get('SELECT * FROM groups WHERE group_id = ?', chatId);
        if (!group) return;
        const user = await db.get('SELECT credits FROM users WHERE user_id = ?', group.user_id);
        if (user.credits < 5) {
            return bot.sendMessage(chatId, "❌ Insufficient credits. You need 5.");
        }
        await db.run('UPDATE users SET credits = credits - 5 WHERE user_id = ?', group.user_id);
        await bot.sendMessage(chatId, "🎁 Gift sent! (Admin will see this)");
        // Notify admin
        await bot.sendMessage(ADMIN_ID, `🎁 Client ${group.user_id} sent a gift in group ${chatId}.`);
    }
});

// ----------------------------------------------------------------------
// API ENDPOINTS (for web app support)
// ----------------------------------------------------------------------
app.get('/api/agents', async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: "Database not ready" });
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

app.post('/api/upload_client', upload.single('photo'), (req, res) => {
    if (req.file) {
        res.json({ url: `${SERVER_URL}/uploads/${req.file.filename}` });
    } else {
        res.status(400).send("Error");
    }
});

// ----------------------------------------------------------------------
// START SERVER
// ----------------------------------------------------------------------
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
