/**
 * FLIRTU-STYLE BOT — INLINE KEYBOARD VERSION
 * Features: User registration, Browse agents, Chat with credits, Admin management
 * No web app, pure Telegram inline keyboards.
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
console.log("🤖 Bot started with polling");

// ----------------------------------------------------------------------
// DATABASE
// ----------------------------------------------------------------------
let db;

(async () => {
    db = await open({ filename: './flirtu.db', driver: sqlite3.Database });

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
            photo_file_id TEXT,
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
// USER STATE MACHINE (for registration)
// ----------------------------------------------------------------------
const userState = {}; // { userId: { step: 'awaiting_name', data: {} } }

// ----------------------------------------------------------------------
// ADMIN STATE MACHINE (unchanged)
// ----------------------------------------------------------------------
const adminState = {};

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
        // Check if user exists and is registered
        let user = await db.get('SELECT * FROM users WHERE user_id = ?', userId);

        if (!user) {
            // New user: insert placeholder and start registration
            await db.run(
                `INSERT INTO users (user_id, first_name, username, credits, registered) VALUES (?, ?, ?, 0, 0)`,
                [userId, firstName, username]
            );
            userState[userId] = { step: 'awaiting_name', data: {} };
            return bot.sendMessage(userId, "🌸 Welcome to Flirtu! Let's set up your profile.\n\nPlease enter your **first name**:", { parse_mode: 'Markdown' });
        }

        if (!user.registered) {
            // User exists but not fully registered (e.g., interrupted flow)
            userState[userId] = { step: 'awaiting_name', data: {} };
            return bot.sendMessage(userId, "Let's complete your registration.\n\nPlease enter your **first name**:", { parse_mode: 'Markdown' });
        }

        // Registered user → show main menu
        await showMainMenu(userId, firstName);
    } catch (e) {
        console.error("Start error:", e);
        bot.sendMessage(userId, "An error occurred. Please try again later.");
    }
});

// Show main menu with inline keyboard
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
// REGISTRATION FLOW
// ----------------------------------------------------------------------
bot.on('message', async (msg) => {
    const userId = msg.chat.id;
    if (msg.text && msg.text.startsWith('/')) return; // ignore commands

    // 1. Check admin editing flow first
    if (userId === ADMIN_ID && adminState[ADMIN_ID]) {
        await handleAdminFlow(msg);
        return;
    }

    // 2. Check user registration state
    const state = userState[userId];
    if (!state) return; // not in registration

    try {
        switch (state.step) {
            case 'awaiting_name':
                const name = msg.text;
                if (!name || name.length < 2) {
                    return bot.sendMessage(userId, "Please enter a valid name (at least 2 characters).");
                }
                state.data.name = name;
                state.step = 'awaiting_age';
                return bot.sendMessage(userId, "Great! Now enter your **age** (e.g., 25):", { parse_mode: 'Markdown' });

            case 'awaiting_age':
                const age = parseInt(msg.text);
                if (isNaN(age) || age < 18 || age > 100) {
                    return bot.sendMessage(userId, "Please enter a valid age between 18 and 100.");
                }
                state.data.age = age;
                state.step = 'awaiting_gender';
                const genderKeyboard = {
                    inline_keyboard: [
                        [{ text: "👨 Male", callback_data: "gender_male" }, { text: "👩 Female", callback_data: "gender_female" }]
                    ]
                };
                return bot.sendMessage(userId, "Select your **gender**:", { parse_mode: 'Markdown', reply_markup: genderKeyboard });

            case 'awaiting_location':
                const location = msg.text;
                if (!location) {
                    return bot.sendMessage(userId, "Please enter your location (city or country).");
                }
                state.data.location = location;
                state.step = 'awaiting_photo';
                return bot.sendMessage(userId, "Finally, send me a **profile photo** (optional, you can skip with /skip).");

            case 'awaiting_photo':
                if (msg.text && msg.text.toLowerCase() === '/skip') {
                    // Skip photo
                    await completeRegistration(userId, state.data, null);
                    delete userState[userId];
                } else if (msg.photo) {
                    const fileId = msg.photo[msg.photo.length - 1].file_id;
                    await completeRegistration(userId, state.data, fileId);
                    delete userState[userId];
                } else {
                    bot.sendMessage(userId, "Please send a photo or type /skip.");
                }
                return;
        }
    } catch (e) {
        console.error("Registration error:", e);
        bot.sendMessage(userId, "An error occurred. Please restart with /start.");
        delete userState[userId];
    }
});

// Complete registration, save to DB, give starting credits
async function completeRegistration(userId, data, photoFileId) {
    await db.run(
        `UPDATE users SET 
         first_name = ?, age = ?, gender = ?, location = ?, photo_file_id = ?, credits = 50, registered = 1
         WHERE user_id = ?`,
        [data.name, data.age, data.gender, data.location, photoFileId, userId]
    );

    // Notify admin about new user
    const userInfo = await db.get('SELECT * FROM users WHERE user_id = ?', userId);
    let adminMsg = `🆕 **New User Registered**\n\nName: ${userInfo.first_name}\nAge: ${userInfo.age}\nGender: ${userInfo.gender}\nLocation: ${userInfo.location}`;
    if (photoFileId) adminMsg += `\nPhoto received.`;
    bot.sendMessage(ADMIN_ID, adminMsg, { parse_mode: 'Markdown' });

    // Welcome user
    bot.sendMessage(userId, `✅ **Registration complete!**\n💰 You received **50 free credits**.\n\nUse /start to begin.`);
    await showMainMenu(userId, data.name);
}

// ----------------------------------------------------------------------
// CALLBACK QUERY HANDLER
// ----------------------------------------------------------------------
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;

    try {
        // Handle registration gender selection
        if (data.startsWith('gender_')) {
            const gender = data.split('_')[1]; // 'male' or 'female'
            const state = userState[userId];
            if (state && state.step === 'awaiting_gender') {
                state.data.gender = gender;
                state.step = 'awaiting_location';
                await bot.answerCallbackQuery(callbackQuery.id, { text: `Gender set to ${gender}` });
                await bot.editMessageText("Great! Now enter your **location** (city or country):", {
                    chat_id: userId,
                    message_id: msg.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [] } // remove keyboard
                });
            } else {
                await bot.answerCallbackQuery(callbackQuery.id, { text: "Session expired. Use /start" });
            }
            return;
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

// Browse agents - show list with inline buttons
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

// Show user profile
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

// Claim daily bonus (simple: once per day)
async function claimDailyBonus(userId, msg) {
    const today = new Date().toISOString().split('T')[0];
    const user = await db.get('SELECT last_daily FROM users WHERE user_id = ?', userId);

    if (user.last_daily === today) {
        return bot.sendMessage(userId, "You've already claimed your daily bonus today. Come back tomorrow!");
    }

    await db.run('UPDATE users SET credits = credits + 20, last_daily = ? WHERE user_id = ?', [today, userId]);
    bot.sendMessage(userId, "🎁 **Daily Bonus Claimed!**\n+20 credits added to your balance.", { parse_mode: 'Markdown' });
}

// Select agent and create room
async function selectAgent(userId, agentId, msg) {
    const agent = await db.get('SELECT * FROM agents WHERE id = ?', agentId);
    if (!agent) return bot.sendMessage(userId, "Agent not found.");

    // Ensure user exists (should, but just in case)
    let user = await db.get('SELECT * FROM users WHERE user_id = ?', userId);
    if (!user) {
        // very unlikely, but create minimal
        await db.run('INSERT INTO users (user_id, first_name, credits, registered) VALUES (?, ?, 0, 1)', [userId, 'User']);
        user = await db.get('SELECT * FROM users WHERE user_id = ?', userId);
    }

    // Create or get room
    await db.run(`
        INSERT OR IGNORE INTO rooms (user_id, agent_id) VALUES (?, ?)
    `, [userId, agent.id]);

    await db.run(`
        UPDATE users SET active_room_id = (
            SELECT id FROM rooms WHERE user_id = ? AND agent_id = ?
        ) WHERE user_id = ?
    `, [userId, agent.id, userId]);

    // Send agent intro and chat keyboard
    const intro = `💬 **Connected with ${agent.name}**\n\nYou can now chat. Each message costs 1 credit.\nUse the buttons below for special actions.`;

    const keyboard = {
        keyboard: [
            ['📸 Pic (15)', '🎥 Video (50)'],
            ['🎁 Gift (5)', '💳 Balance'],
            ['❌ Leave Chat']
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    };

    bot.sendMessage(userId, intro, { parse_mode: 'Markdown', reply_markup: keyboard });
}

// ----------------------------------------------------------------------
// REGULAR CHAT HANDLER (when user in a room)
// ----------------------------------------------------------------------
bot.on('message', async (msg) => {
    const userId = msg.chat.id;
    if (msg.text && msg.text.startsWith('/')) return; // commands handled separately
    if (userState[userId]) return; // registration in progress

    // Admin replying to a user (via reply)
    if (userId === ADMIN_ID && msg.reply_to_message) {
        const match = msg.reply_to_message.text.match(/🆔 ID: (\d+)/);
        if (match) {
            bot.sendMessage(match[1], msg.text);
        }
        return;
    }

    // User chatting
    try {
        const user = await db.get(`
            SELECT u.credits, a.name, a.is_online, a.photo_file_id, u.active_room_id
            FROM users u
            JOIN rooms r ON u.active_room_id = r.id
            JOIN agents a ON r.agent_id = a.id
            WHERE u.user_id = ?
        `, userId);

        if (!user) return; // not in a room

        // Handle special buttons
        if (msg.text === '❌ Leave Chat') {
            await db.run('UPDATE users SET active_room_id = NULL WHERE user_id = ?', userId);
            return bot.sendMessage(userId, "👋 Chat closed.", { reply_markup: { remove_keyboard: true } });
        }

        if (msg.text === '💳 Balance') {
            const c = await db.get('SELECT credits FROM users WHERE user_id = ?', userId);
            return bot.sendMessage(userId, `Credits: ${c.credits}`);
        }

        if (msg.text && msg.text.includes('📸 Pic')) {
            if (user.credits < 15) return bot.sendMessage(userId, "❌ Low balance.");
            await db.run('UPDATE users SET credits = credits - 15 WHERE user_id = ?', userId);

            if (user.photo_file_id) {
                bot.sendMessage(userId, "😘 *Sending private pic...*", { parse_mode: 'Markdown' });
                setTimeout(() => bot.sendPhoto(userId, user.photo_file_id), 1000);
            } else {
                bot.sendMessage(userId, "No photo available.");
            }
            return;
        }

        // Placeholder for other actions
        if (msg.text && (msg.text.includes('🎥 Video') || msg.text.includes('🎁 Gift'))) {
            return bot.sendMessage(userId, "This feature is coming soon!");
        }

        // Regular text message – deduct 1 credit
        if (user.credits <= 0) return bot.sendMessage(userId, "🔒 No credits. Use /start to return to menu.");
        await db.run('UPDATE users SET credits = credits - 1 WHERE user_id = ?', userId);

        if (user.is_online) {
            // Forward to admin
            const forward = `🔌 **${user.name}** (User: ${msg.from.first_name})\n🆔 ID: ${userId}\n\n"${msg.text}"`;
            bot.sendMessage(ADMIN_ID, forward);
        } else {
            // AI placeholder
            bot.sendChatAction(userId, 'typing');
            setTimeout(() => bot.sendMessage(userId, "I'm listening... tell me more."), 2000);
        }
    } catch (e) {
        console.error("Chat error:", e);
    }
});

// ----------------------------------------------------------------------
// ADMIN COMMANDS (mostly unchanged, but adapt to file_id)
// ----------------------------------------------------------------------

// /create - Admin creates a new agent
bot.onText(/\/create/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    adminState[ADMIN_ID] = { step: 'CREATE_NAME' };
    bot.sendMessage(ADMIN_ID, "🆕 **Create New Model**\n\nPlease enter the **Name**:", { parse_mode: 'Markdown' });
});

// /edit, /delete, /list, /online, /offline, /wipe, /reset – same as before but adapt photo handling
// For brevity, I'll keep them as before, but modify photo storage to file_id instead of filename.

// ... (admin commands similar to original, but in downloadTelegramFile we now just store file_id)
// We'll rewrite the admin photo handling to store file_id directly.

// For admin flow, we need to modify handleAdminFlow to store file_id instead of downloading.
// Let's create a simplified version.

// Admin state machine (updated for file_id)
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
            const colName = `photo${photoIndex}_file_id`;

            if (msg.text && msg.text.toLowerCase() === 'skip') {
                return advancePhotoStep(state.agent_id, parseInt(photoIndex));
            }

            if (msg.photo) {
                const fileId = msg.photo[msg.photo.length - 1].file_id;
                await db.run(`UPDATE agents SET ${colName} = ? WHERE id = ?`, [fileId, state.agent_id]);
                bot.sendMessage(ADMIN_ID, `✅ Photo ${photoIndex} Saved.`);
                return advancePhotoStep(state.agent_id, parseInt(photoIndex));
            }

            bot.sendMessage(ADMIN_ID, "⚠️ Please send a photo (compressed) or type 'skip'.");
        }
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
        delete adminState[ADMIN_ID];
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

// Keep existing admin commands: /edit, /delete, /list, /online, /offline, /wipe_all_data, /confirm_wipe, /reset_clients
// They remain unchanged except for referencing correct columns.

// (Copy the admin command handlers from original, adjusting column names if needed)
// For brevity, I'll include them with minimal changes.

// /edit <name> - Admin edits an existing agent
bot.onText(/\/edit (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];

    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");

        const agent = await db.get('SELECT * FROM agents WHERE name = ?', name);
        if (!agent) return bot.sendMessage(ADMIN_ID, `❌ Agent "${name}" not found.`);

        adminState[ADMIN_ID] = { step: 'EDIT_AGE', agent_id: agent.id };
        bot.sendMessage(ADMIN_ID, `✏️ **Editing ${name}**\n\nEnter the **Age** (e.g. 24):`, { parse_mode: 'Markdown' });
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

// /delete <name> - Admin deletes an agent
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

// /list - List all agents
bot.onText(/\/list/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");

        const agents = await db.all('SELECT * FROM agents');
        if (agents.length === 0) return bot.sendMessage(ADMIN_ID, "No agents found. Use /create");

        let text = "📋 **Current Models:**\n";
        agents.forEach(a => text += `- ${a.name} (Online: ${a.is_online ? '✅' : '🔴'})\n`);
        bot.sendMessage(ADMIN_ID, text, { parse_mode: 'Markdown' });
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

// /online <name> - Set agent online
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

// /offline <name> - Set agent offline
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

// /wipe_all_data - Dangerous: wipe everything
bot.onText(/\/wipe_all_data/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    bot.sendMessage(msg.chat.id, "⚠️ **WARNING** ⚠️\n\nThis will delete:\n- All Users & Credits\n- All Created Agents\n- All Chat Rooms\n\nType `/confirm_wipe` to proceed.");
});

// /confirm_wipe - Actually wipe
bot.onText(/\/confirm_wipe/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");

        await db.run('DELETE FROM users');
        await db.run('DELETE FROM agents');
        await db.run('DELETE FROM rooms');
        await db.run('DELETE FROM sqlite_sequence WHERE name="users"');
        await db.run('DELETE FROM sqlite_sequence WHERE name="agents"');
        await db.run('DELETE FROM sqlite_sequence WHERE name="rooms"');

        bot.sendMessage(msg.chat.id, "✅ **Database Wiped Successfully.**\n\nSystem is fresh. You can now `/create` new models.");
        console.log("Database wiped by Admin.");
    } catch (error) {
        bot.sendMessage(msg.chat.id, `❌ Error wiping DB: ${error.message}`);
    }
});

// /reset_clients - Wipe only users and rooms, keep agents
bot.onText(/\/reset_clients/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");

        await db.run('DELETE FROM users');
        await db.run('DELETE FROM rooms');
        bot.sendMessage(ADMIN_ID, "✅ **Clients Wiped.**\nAll user accounts and chats deleted.\nModels are SAFE.");
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

// ----------------------------------------------------------------------
// MESSAGE HANDLER FOR ADMIN FLOW
// ----------------------------------------------------------------------
bot.on('message', async (msg) => {
    if (msg.chat.id === ADMIN_ID && adminState[ADMIN_ID]) {
        await handleAdminFlow(msg);
    }
});

console.log("✅ Bot is running...");
