/**
 * SYNC HEARTS AGENCY — INLINE KEYBOARD EDITION
 * No web app – all interactions via inline keyboards.
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

// ----------------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ----------------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);

if (!BOT_TOKEN) {
    console.error("❌ CRITICAL ERROR: Missing BOT_TOKEN in Environment Variables.");
    process.exit(1);
}

// ----------------------------------------------------------------------
// TELEGRAM BOT (POLLING MODE)
// ----------------------------------------------------------------------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("✅ Bot started with polling");

// ----------------------------------------------------------------------
// DATABASE
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
            active_room_id INTEGER,
            age INTEGER,
            country TEXT,
            looking_for TEXT,
            profile_photo_file_id TEXT,
            registered INTEGER DEFAULT 0
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            age INTEGER DEFAULT 23,
            location TEXT DEFAULT 'Paris',
            photo1_file_id TEXT,
            photo2_file_id TEXT,
            photo3_file_id TEXT,
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

// ----------------------------------------------------------------------
// USER STATE MACHINE (for registration flow)
// ----------------------------------------------------------------------
const userState = {}; // { userId: { step: 'awaiting_name', data: {} } }

// ----------------------------------------------------------------------
// ADMIN STATE MACHINE (for agent creation/editing)
// ----------------------------------------------------------------------
const adminState = {};

// ----------------------------------------------------------------------
// HELPER FUNCTIONS
// ----------------------------------------------------------------------
function escapeMarkdown(text) {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// ----------------------------------------------------------------------
// MAIN MENU INLINE KEYBOARD
// ----------------------------------------------------------------------
function getMainMenu() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "👥 Browse Agents", callback_data: "browse_agents" }],
                [{ text: "💳 My Credits", callback_data: "my_credits" }],
                [{ text: "📞 Support", callback_data: "support" }]
            ]
        }
    };
}

// ----------------------------------------------------------------------
// REGISTRATION FLOW
// ----------------------------------------------------------------------
async function startRegistration(userId, firstName) {
    userState[userId] = { step: 'awaiting_name', data: {} };
    await bot.sendMessage(userId, "Let's create your profile! What's your name?");
}

// Handle registration steps
async function handleRegistrationMessage(msg) {
    const userId = msg.chat.id;
    const text = msg.text;
    const state = userState[userId];

    if (state.step === 'awaiting_name') {
        state.data.name = text;
        state.step = 'awaiting_age';
        await bot.sendMessage(userId, "Great! How old are you?");
    }
    else if (state.step === 'awaiting_age') {
        const age = parseInt(text);
        if (isNaN(age) || age < 18) {
            await bot.sendMessage(userId, "Please enter a valid age (18+).");
            return;
        }
        state.data.age = age;
        state.step = 'awaiting_country';
        await bot.sendMessage(userId, "Which country are you from?");
    }
    else if (state.step === 'awaiting_country') {
        state.data.country = text;
        state.step = 'awaiting_looking_for';
        await bot.sendMessage(userId, "Are you looking for:", {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Women 💃", callback_data: "looking_female" }],
                    [{ text: "Men 🕺", callback_data: "looking_male" }],
                    [{ text: "Both", callback_data: "looking_both" }]
                ]
            }
        });
    }
}

// Handle callback queries for registration
async function handleRegistrationCallback(query) {
    const userId = query.from.id;
    const data = query.data;
    const state = userState[userId];
    if (!state) return;

    if (data.startsWith('looking_')) {
        state.data.lookingFor = data.replace('looking_', '');
        // Registration complete – save to database
        await db.run(`
            INSERT INTO users (user_id, first_name, credits, age, country, looking_for, registered)
            VALUES (?, ?, 50, ?, ?, ?, 1)
            ON CONFLICT(user_id) DO UPDATE SET
                first_name = ?,
                age = ?,
                country = ?,
                looking_for = ?,
                registered = 1,
                credits = 50
        `, [
            userId, state.data.name, state.data.age, state.data.country, state.data.lookingFor,
            state.data.name, state.data.age, state.data.country, state.data.lookingFor
        ]);
        delete userState[userId];
        await bot.sendMessage(userId, 
            `✅ Registration complete! You've received 50 free credits.\n\nWelcome, ${state.data.name}!`,
            getMainMenu()
        );
        await bot.answerCallbackQuery(query.id);
    }
}

// ----------------------------------------------------------------------
// BROWSE AGENTS (inline keyboard pagination)
// ----------------------------------------------------------------------
async function showAgentList(userId, page = 0) {
    const agents = await db.all('SELECT id, name, age, location FROM agents ORDER BY id');
    const pageSize = 5;
    const totalPages = Math.ceil(agents.length / pageSize);

    if (agents.length === 0) {
        await bot.sendMessage(userId, "No agents available at the moment.");
        return;
    }

    const start = page * pageSize;
    const end = start + pageSize;
    const pageAgents = agents.slice(start, end);

    const buttons = pageAgents.map(a => ([
        { text: `${a.name}, ${a.age} (${a.location})`, callback_data: `select_agent_${a.id}` }
    ]));

    // Navigation buttons
    const navButtons = [];
    if (page > 0) navButtons.push({ text: "◀️ Previous", callback_data: `agent_page_${page-1}` });
    if (page < totalPages - 1) navButtons.push({ text: "Next ▶️", callback_data: `agent_page_${page+1}` });
    if (navButtons.length) buttons.push(navButtons);

    await bot.sendMessage(userId, "Select an agent to chat:", {
        reply_markup: { inline_keyboard: buttons }
    });
}

// ----------------------------------------------------------------------
// START CHAT WITH AGENT
// ----------------------------------------------------------------------
async function startChat(userId, agentId) {
    const agent = await db.get('SELECT * FROM agents WHERE id = ?', agentId);
    if (!agent) return bot.sendMessage(userId, "Agent not found.");

    // Ensure user exists (if somehow not registered)
    let user = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
    if (!user) {
        // Create a minimal user with 0 credits
        await db.run(
            'INSERT INTO users (user_id, first_name, credits, registered) VALUES (?, ?, 0, 1)',
            [userId, "User"]
        );
        user = { credits: 0 };
    }

    // Create or get room
    await db.run(`
        INSERT OR IGNORE INTO rooms (user_id, agent_id) VALUES (?, ?)
    `, [userId, agentId]);

    await db.run(`
        UPDATE users SET active_room_id = (
            SELECT id FROM rooms WHERE user_id = ? AND agent_id = ?
        ) WHERE user_id = ?
    `, [userId, agentId, userId]);

    // Send chat interface
    const chatKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📸 Send Pic (15 credits)", callback_data: `chat_pic_${agentId}` }],
                [{ text: "💳 Balance", callback_data: "chat_balance" }],
                [{ text: "❌ Leave Chat", callback_data: "chat_leave" }]
            ]
        }
    };

    await bot.sendMessage(userId, `💬 You are now chatting with ${agent.name}.`, chatKeyboard);
}

// ----------------------------------------------------------------------
// HANDLE CHAT ACTIONS
// ----------------------------------------------------------------------
async function handleChatCallback(query) {
    const userId = query.from.id;
    const data = query.data;

    if (data === "chat_balance") {
        const user = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
        await bot.answerCallbackQuery(query.id, { text: `You have ${user?.credits || 0} credits.`, show_alert: true });
    }
    else if (data === "chat_leave") {
        await db.run('UPDATE users SET active_room_id = NULL WHERE user_id = ?', userId);
        await bot.sendMessage(userId, "You left the chat.", getMainMenu());
        await bot.answerCallbackQuery(query.id);
    }
    else if (data.startsWith("chat_pic_")) {
        const agentId = data.split('_')[2];
        const agent = await db.get('SELECT * FROM agents WHERE id = ?', agentId);
        if (!agent) return;

        const user = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
        if (user.credits < 15) {
            await bot.answerCallbackQuery(query.id, { text: "❌ Not enough credits.", show_alert: true });
            return;
        }

        await db.run('UPDATE users SET credits = credits - 15 WHERE user_id = ?', userId);

        if (agent.photo1_file_id) {
            await bot.sendPhoto(userId, agent.photo1_file_id, { caption: "Here's your private pic 😘" });
        } else {
            await bot.sendMessage(userId, "No photo available.");
        }
        await bot.answerCallbackQuery(query.id);
    }
}

// ----------------------------------------------------------------------
// COMMAND HANDLERS
// ----------------------------------------------------------------------

// /start – Entry point
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'User';

    // Check if user is already registered
    const user = await db.get('SELECT registered FROM users WHERE user_id = ?', userId);
    if (user && user.registered) {
        await bot.sendMessage(userId, `Welcome back, ${firstName}!`, getMainMenu());
    } else {
        await startRegistration(userId, firstName);
    }
});

// Handle text messages for registration flow
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const userId = msg.chat.id;

    // Check if user is in registration flow
    if (userState[userId]) {
        await handleRegistrationMessage(msg);
        return;
    }

    // Otherwise, ignore (or you can handle general chat)
});

// Handle callback queries
bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const data = query.data;

    // Registration callbacks
    if (userState[userId] && data.startsWith('looking_')) {
        await handleRegistrationCallback(query);
        return;
    }

    // Main menu navigation
    if (data === "browse_agents") {
        await showAgentList(userId);
        await bot.answerCallbackQuery(query.id);
    }
    else if (data === "my_credits") {
        const user = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
        await bot.answerCallbackQuery(query.id, { text: `Credits: ${user?.credits || 0}`, show_alert: true });
    }
    else if (data === "support") {
        await bot.sendMessage(userId, "Contact @admin for support.");
        await bot.answerCallbackQuery(query.id);
    }
    // Agent pagination
    else if (data.startsWith("agent_page_")) {
        const page = parseInt(data.split('_')[2]);
        await showAgentList(userId, page);
        await bot.answerCallbackQuery(query.id);
    }
    // Select agent
    else if (data.startsWith("select_agent_")) {
        const agentId = data.split('_')[2];
        await startChat(userId, agentId);
        await bot.answerCallbackQuery(query.id);
    }
    // Chat actions
    else if (data.startsWith("chat_")) {
        await handleChatCallback(query);
    }
});

// ----------------------------------------------------------------------
// ADMIN COMMANDS (unchanged except for storing file_id)
// ----------------------------------------------------------------------

// /create – Admin creates a new agent
bot.onText(/\/create/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    adminState[ADMIN_ID] = { step: 'CREATE_NAME' };
    bot.sendMessage(ADMIN_ID, "🆕 **Create New Model**\n\nPlease enter the **Name**:");
});

// /edit <name> – Admin edits an agent
bot.onText(/\/edit (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];
    const agent = await db.get('SELECT * FROM agents WHERE name = ?', name);
    if (!agent) return bot.sendMessage(ADMIN_ID, `❌ Agent "${name}" not found.`);
    adminState[ADMIN_ID] = { step: 'EDIT_AGE', agent_id: agent.id };
    bot.sendMessage(ADMIN_ID, `✏️ **Editing ${name}**\n\nEnter the **Age** (e.g. 24):`);
});

// /delete <name> – Admin deletes an agent
bot.onText(/\/delete (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];
    await db.run('DELETE FROM agents WHERE name = ?', name);
    bot.sendMessage(ADMIN_ID, `🗑️ Deleted ${name}.`);
});

// /list – List all agents
bot.onText(/\/list/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const agents = await db.all('SELECT * FROM agents');
    if (agents.length === 0) return bot.sendMessage(ADMIN_ID, "No agents found.");
    let text = "📋 **Current Models:**\n";
    agents.forEach(a => text += `- ${a.name} (Online: ${a.is_online ? '✅' : '🔴'})\n`);
    bot.sendMessage(ADMIN_ID, text);
});

// /online /offline
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

// Wipe commands (keep as before)
bot.onText(/\/wipe_all_data/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    bot.sendMessage(msg.chat.id, "⚠️ **WARNING** ⚠️\n\nThis will delete everything. Type `/confirm_wipe` to proceed.");
});
bot.onText(/\/confirm_wipe/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    await db.run('DELETE FROM users');
    await db.run('DELETE FROM agents');
    await db.run('DELETE FROM rooms');
    await db.run('DELETE FROM sqlite_sequence');
    bot.sendMessage(msg.chat.id, "✅ Database wiped.");
});
bot.onText(/\/reset_clients/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    await db.run('DELETE FROM users');
    await db.run('DELETE FROM rooms');
    bot.sendMessage(ADMIN_ID, "✅ Clients wiped, agents kept.");
});

// ----------------------------------------------------------------------
// ADMIN FLOW HANDLER (modified to store file_id)
// ----------------------------------------------------------------------
bot.on('message', async (msg) => {
    if (msg.chat.id !== ADMIN_ID || !adminState[ADMIN_ID]) return;
    const state = adminState[ADMIN_ID];

    // Handle CREATE_NAME
    if (state.step === 'CREATE_NAME') {
        try {
            const result = await db.run('INSERT INTO agents (name) VALUES (?)', msg.text);
            adminState[ADMIN_ID] = { step: 'EDIT_photos_1', agent_id: result.lastID };
            bot.sendMessage(ADMIN_ID, `✅ Created. Now send **Photo #1** (or type 'skip').`);
        } catch (e) {
            bot.sendMessage(ADMIN_ID, "❌ Name already exists.");
            delete adminState[ADMIN_ID];
        }
        return;
    }

    // Handle EDIT_AGE
    if (state.step === 'EDIT_AGE') {
        const age = parseInt(msg.text);
        if (!isNaN(age)) {
            await db.run('UPDATE agents SET age = ? WHERE id = ?', [age, state.agent_id]);
            adminState[ADMIN_ID] = { step: 'EDIT_photos_1', agent_id: state.agent_id };
            bot.sendMessage(ADMIN_ID, "✅ Age updated. Now send **Photo #1** (or 'skip').");
        } else {
            bot.sendMessage(ADMIN_ID, "⚠️ Please enter a number.");
        }
        return;
    }

    // Handle photos
    if (state.step.startsWith('EDIT_photos_')) {
        const idx = state.step.split('_')[2];
        const col = `photo${idx}_file_id`;

        if (msg.text && msg.text.toLowerCase() === 'skip') {
            // Advance to next step
            if (parseInt(idx) < 3) {
                adminState[ADMIN_ID] = { step: `EDIT_photos_${parseInt(idx)+1}`, agent_id: state.agent_id };
                bot.sendMessage(ADMIN_ID, `Send **Photo #${parseInt(idx)+1}** (or 'skip').`);
            } else {
                delete adminState[ADMIN_ID];
                bot.sendMessage(ADMIN_ID, "🎉 Agent setup complete!");
            }
            return;
        }

        if (msg.photo) {
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            await db.run(`UPDATE agents SET ${col} = ? WHERE id = ?`, [fileId, state.agent_id]);
            bot.sendMessage(ADMIN_ID, `✅ Photo ${idx} saved.`);

            // Advance
            if (parseInt(idx) < 3) {
                adminState[ADMIN_ID] = { step: `EDIT_photos_${parseInt(idx)+1}`, agent_id: state.agent_id };
                bot.sendMessage(ADMIN_ID, `Send **Photo #${parseInt(idx)+1}** (or 'skip').`);
            } else {
                delete adminState[ADMIN_ID];
                bot.sendMessage(ADMIN_ID, "🎉 Agent setup complete!");
            }
        } else {
            bot.sendMessage(ADMIN_ID, "Please send a photo or type 'skip'.");
        }
    }
});

// ----------------------------------------------------------------------
// REGULAR CHAT HANDLER (when user is in a room)
// ----------------------------------------------------------------------
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const userId = msg.chat.id;

    // Ignore if user is in registration or admin flow
    if (userState[userId]) return;
    if (userId === ADMIN_ID && adminState[ADMIN_ID]) return;

    // Check if user is in an active room
    const room = await db.get(`
        SELECT r.*, a.name, a.is_online, a.photo1_file_id
        FROM rooms r
        JOIN agents a ON r.agent_id = a.id
        WHERE r.user_id = ? AND r.id = (SELECT active_room_id FROM users WHERE user_id = ?)
    `, [userId, userId]);

    if (!room) return;

    // Deduct 1 credit for text message
    const user = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
    if (user.credits <= 0) {
        return bot.sendMessage(userId, "🔒 No credits. Top up to continue.");
    }
    await db.run('UPDATE users SET credits = credits - 1 WHERE user_id = ?', userId);

    if (room.is_online) {
        // Forward to admin
        const forwardMsg = `🔌 **${room.name}** (User: ${msg.from.first_name})\n🆔 ID: ${userId}\n\n"${msg.text}"`;
        bot.sendMessage(ADMIN_ID, forwardMsg);
    } else {
        // AI placeholder
        bot.sendChatAction(userId, 'typing');
        setTimeout(() => bot.sendMessage(userId, "I'm listening... tell me more."), 2000);
    }
});

console.log("🤖 Bot is running...");
