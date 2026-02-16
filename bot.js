/**
 * SYNC HEARTS — FLIRTU-STYLE BOT with Group Chats
 * Features: Inline keyboard registration, browse agents, create private group for each chat,
 * credit deduction, admin management.
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

// ----------------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ----------------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID); // The real person acting as agent(s)

if (!BOT_TOKEN) {
    console.error("❌ CRITICAL ERROR: Missing BOT_TOKEN in Environment Variables.");
    process.exit(1);
}

// ----------------------------------------------------------------------
// TELEGRAM BOT (POLLING MODE)
// ----------------------------------------------------------------------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🤖 Bot started with polling");

// ----------------------------------------------------------------------
// DATABASE
// ----------------------------------------------------------------------
let db;

(async () => {
    db = await open({ filename: './sync_hearts.db', driver: sqlite3.Database });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            first_name TEXT,
            username TEXT,
            age INTEGER,
            gender TEXT,
            location TEXT,
            photo_file_id TEXT,
            credits INTEGER DEFAULT 0,
            active_room_id INTEGER,
            last_daily DATE,
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
            is_online INTEGER DEFAULT 0
            -- No telegram_id needed; all chats go to ADMIN_ID
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            agent_id INTEGER,
            group_chat_id INTEGER,      -- Telegram group ID for this room
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, agent_id)
        );
    `);

    console.log('✅ Database Ready.');
})();

// ----------------------------------------------------------------------
// STATE MACHINES
// ----------------------------------------------------------------------
const userState = {};      // registration
const adminState = {};     // admin flows

// ----------------------------------------------------------------------
// HELPER FUNCTIONS
// ----------------------------------------------------------------------
function escapeMarkdown(text) {
    return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// ----------------------------------------------------------------------
// COMMAND HANDLERS
// ----------------------------------------------------------------------

// /start - Entry point
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'User';
    const username = msg.from.username || '';

    try {
        let user = await db.get('SELECT * FROM users WHERE user_id = ?', userId);

        if (!user) {
            await db.run(
                `INSERT INTO users (user_id, first_name, username, credits, registered) VALUES (?, ?, ?, 0, 0)`,
                [userId, firstName, username]
            );
            userState[userId] = { step: 'awaiting_name', data: {} };
            return bot.sendMessage(userId, 
                "🌸 Welcome to Sync Hearts! Let's set up your profile.\n\nPlease enter your **first name**:", 
                { parse_mode: 'Markdown' });
        }

        if (!user.registered) {
            userState[userId] = { step: 'awaiting_name', data: {} };
            return bot.sendMessage(userId, 
                "Let's complete your registration.\n\nPlease enter your **first name**:", 
                { parse_mode: 'Markdown' });
        }

        await showMainMenu(userId, user.first_name);
    } catch (e) {
        console.error("Start error:", e);
        bot.sendMessage(userId, "An error occurred. Please try again later.");
    }
});

// Show main menu
async function showMainMenu(userId, firstName) {
    const user = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
    const credits = user ? user.credits : 0;

    const menuText = `👋 Welcome back, ${escapeMarkdown(firstName)}!\n\n💎 Your balance: **${credits} credits**\n\nWhat would you like to do?`;

    const keyboard = {
        inline_keyboard: [
            [{ text: "🔍 Browse Models", callback_data: "browse" }],
            [{ text: "👤 My Profile", callback_data: "profile" }],
            [{ text: "💰 Balance", callback_data: "balance" }],
            [{ text: "🎁 Daily Bonus", callback_data: "daily" }]
        ]
    };

    bot.sendMessage(userId, menuText, { parse_mode: 'Markdown', reply_markup: keyboard });
}

// ----------------------------------------------------------------------
// REGISTRATION FLOW (same as before)
// ----------------------------------------------------------------------
bot.on('message', async (msg) => {
    const userId = msg.chat.id;
    if (msg.text && msg.text.startsWith('/')) return;

    // Admin flow takes priority
    if (userId === ADMIN_ID && adminState[ADMIN_ID]) {
        await handleAdminFlow(msg);
        return;
    }

    const state = userState[userId];
    if (!state) return;

    // ... (registration steps identical to previous version, omitted for brevity)
    // (You can copy the registration steps from the previous answer)
    // For space, I'll skip but they are the same.
});

// ----------------------------------------------------------------------
// CALLBACK QUERY HANDLER
// ----------------------------------------------------------------------
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;

    try {
        // Registration gender selection
        if (data.startsWith('gender_')) {
            // ... same as before
        }

        // Main menu actions
        switch (data) {
            case 'browse':
                await browseAgents(userId, msg);
                break;
            case 'profile':
                await showProfile(userId, msg);
                break;
            case 'balance':
                await showBalance(userId, msg);
                break;
            case 'daily':
                await claimDailyBonus(userId, msg);
                break;
            default:
                if (data.startsWith('agent_')) {
                    const agentId = parseInt(data.split('_')[1]);
                    await selectAgent(userId, agentId, msg);
                } else if (data.startsWith('back_')) {
                    const from = data.split('_')[1];
                    if (from === 'main') {
                        const user = await db.get('SELECT first_name FROM users WHERE user_id = ?', userId);
                        await showMainMenu(userId, user.first_name);
                        await bot.deleteMessage(userId, msg.message_id);
                    }
                }
                break;
        }

        await bot.answerCallbackQuery(callbackQuery.id);
    } catch (e) {
        console.error("Callback error:", e);
        bot.sendMessage(userId, "An error occurred.");
    }
});

// Browse agents
async function browseAgents(userId, msg) {
    const agents = await db.all('SELECT id, name, age, location FROM agents');
    if (agents.length === 0) {
        return bot.sendMessage(userId, "No models available yet. Check back later.");
    }

    const keyboard = {
        inline_keyboard: agents.map(a => ([
            { text: `👤 ${a.name}, ${a.age} (${a.location})`, callback_data: `agent_${a.id}` }
        ])).concat([[{ text: "« Back to Menu", callback_data: "back_main" }]])
    };

    bot.sendMessage(userId, "🔥 **Available Models**\nChoose one to start chatting:", {
        parse_mode: 'Markdown',
        reply_markup: keyboard
    });
}

// Show profile (unchanged)
async function showProfile(userId, msg) {
    const user = await db.get('SELECT * FROM users WHERE user_id = ?', userId);
    if (!user) return bot.sendMessage(userId, "User not found.");
    let text = `👤 **Your Profile**\n\n`;
    text += `Name: ${user.first_name}\n`;
    text += `Age: ${user.age || 'Not set'}\n`;
    text += `Gender: ${user.gender || 'Not set'}\n`;
    text += `Location: ${user.location || 'Not set'}\n`;
    text += `Credits: ${user.credits}\n`;
    if (user.photo_file_id) {
        bot.sendPhoto(userId, user.photo_file_id, { caption: text, parse_mode: 'Markdown' });
    } else {
        bot.sendMessage(userId, text, { parse_mode: 'Markdown' });
    }
}

// Show balance
async function showBalance(userId, msg) {
    const user = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
    bot.sendMessage(userId, `💰 Your balance: **${user.credits} credits**`, { parse_mode: 'Markdown' });
}

// Claim daily bonus
async function claimDailyBonus(userId, msg) {
    const today = new Date().toISOString().split('T')[0];
    const user = await db.get('SELECT last_daily FROM users WHERE user_id = ?', userId);
    if (user.last_daily === today) {
        return bot.sendMessage(userId, "You've already claimed your daily bonus today. Come back tomorrow!");
    }
    await db.run('UPDATE users SET credits = credits + 20, last_daily = ? WHERE user_id = ?', [today, userId]);
    bot.sendMessage(userId, "🎁 **Daily Bonus Claimed!**\n+20 credits added to your balance.", { parse_mode: 'Markdown' });
}

// ----------------------------------------------------------------------
// SELECT AGENT AND CREATE GROUP CHAT
// ----------------------------------------------------------------------
async function selectAgent(userId, agentId, msg) {
    const agent = await db.get('SELECT * FROM agents WHERE id = ?', agentId);
    if (!agent) return bot.sendMessage(userId, "Agent not found.");

    // Ensure user exists
    let user = await db.get('SELECT * FROM users WHERE user_id = ?', userId);
    if (!user) {
        await db.run('INSERT INTO users (user_id, first_name, credits, registered) VALUES (?, ?, 0, 1)', [userId, 'User']);
        user = await db.get('SELECT * FROM users WHERE user_id = ?', userId);
    }

    // Check if room already exists
    let room = await db.get('SELECT * FROM rooms WHERE user_id = ? AND agent_id = ?', [userId, agentId]);
    if (room && room.group_chat_id) {
        // Room exists, try to send a message to the group
        try {
            await bot.sendMessage(room.group_chat_id, "You are already in a chat with this agent.");
        } catch (e) {
            // Group might be invalid, create new one
            room = null;
        }
    }

    if (!room) {
        // Create a new private supergroup
        const groupTitle = `Chat with ${agent.name}`;
        try {
            // Create group with user and admin (ADMIN_ID)
            const newGroup = await bot.createNewGroupChat([userId, ADMIN_ID], groupTitle);
            const groupChatId = newGroup.id;

            // Store room
            const result = await db.run(
                `INSERT INTO rooms (user_id, agent_id, group_chat_id) VALUES (?, ?, ?)`,
                [userId, agentId, groupChatId]
            );
            room = { id: result.lastID, group_chat_id: groupChatId };

            // Send welcome message in group
            const welcome = `Hello ${user.first_name}! This is your private chat with ${agent.name}.\n\n` +
                            `Each message you send costs 1 credit. Your balance: ${user.credits} credits.\n` +
                            `The agent will join shortly.`;
            await bot.sendMessage(groupChatId, welcome);

            // Notify admin that a new room is created
            await bot.sendMessage(ADMIN_ID, `🔔 New chat request from ${user.first_name} with ${agent.name}. Please join the group: ${groupTitle}`);
        } catch (e) {
            console.error("Failed to create group:", e);
            return bot.sendMessage(userId, "Failed to create chat. Please try again later.");
        }
    }

    // Update user's active room (optional)
    await db.run('UPDATE users SET active_room_id = ? WHERE user_id = ?', [room.id, userId]);

    // Send a private message to user with link to the group (if needed)
    bot.sendMessage(userId, `✅ Your private chat with ${agent.name} has been created! Open the chat:`, {
        reply_markup: {
            inline_keyboard: [[{ text: "💬 Open Chat", url: `https://t.me/c/${room.group_chat_id.toString().replace('-100', '')}` }]]
        }
    });
}

// ----------------------------------------------------------------------
// HANDLE MESSAGES IN GROUPS (credit deduction)
// ----------------------------------------------------------------------
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Ignore private chats with bot (handled elsewhere)
    if (msg.chat.type === 'private') return;

    // Check if this group is a room
    const room = await db.get('SELECT * FROM rooms WHERE group_chat_id = ?', chatId);
    if (!room) return;

    // Ignore messages from bot itself
    if (userId === bot.botInfo.id) return;

    // If message from admin (agent), no deduction
    if (userId === ADMIN_ID) return;

    // Otherwise, it's from the user
    const user = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
    if (!user) return;

    // Deduct 1 credit per message
    if (user.credits <= 0) {
        // Delete the message and notify
        try {
            await bot.deleteMessage(chatId, msg.message_id);
            await bot.sendMessage(chatId, "🔒 You have no credits left. Please top up to continue chatting.");
        } catch (e) {}
        return;
    }

    await db.run('UPDATE users SET credits = credits - 1 WHERE user_id = ?', userId);
    // Optionally notify user of remaining credits after certain number of messages
});

// ----------------------------------------------------------------------
// ADMIN FLOW HANDLER (unchanged, uses file_id)
// ----------------------------------------------------------------------
async function handleAdminFlow(msg) {
    // ... same as before (create agent, edit age, upload photos)
}

function advancePhotoStep(agentId, currentStep) {
    // ... same
}

// ----------------------------------------------------------------------
// ADMIN COMMANDS (unchanged)
// ----------------------------------------------------------------------
bot.onText(/\/create/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    adminState[ADMIN_ID] = { step: 'CREATE_NAME' };
    bot.sendMessage(ADMIN_ID, "🆕 **Create New Model**\n\nPlease enter the **Name**:", { parse_mode: 'Markdown' });
});

// ... (other admin commands: /edit, /delete, /list, /online, /offline, /wipe_all_data, /confirm_wipe, /reset_clients)
// (Copy them from the previous answer)

// ----------------------------------------------------------------------
// MESSAGE HANDLER FOR ADMIN FLOW
// ----------------------------------------------------------------------
bot.on('message', async (msg) => {
    if (msg.chat.id === ADMIN_ID && adminState[ADMIN_ID]) {
        await handleAdminFlow(msg);
    }
});

console.log("✅ Sync Hearts bot with group chats is running...");
