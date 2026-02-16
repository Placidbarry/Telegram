/**
 * SYNC HEARTS AGENCY — INLINE VERSION
 * No payments, no web app, no API. Pure inline keyboard flow.
 * Features: Registration, filtered model browsing, one‑time group links.
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

if (!BOT_TOKEN || !ADMIN_ID) {
    console.error("❌ Missing BOT_TOKEN or ADMIN_ID in .env");
    process.exit(1);
}

// ----------------------------------------------------------------------
// TELEGRAM BOT (polling for simplicity – can be switched to webhook)
// ----------------------------------------------------------------------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

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
            gender TEXT,
            interested_in TEXT,
            age INTEGER,
            country TEXT,
            has_used_link INTEGER DEFAULT 0
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            age INTEGER,
            location TEXT,
            gender TEXT,
            photo1 TEXT,
            photo2 TEXT,
            photo3 TEXT
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS model_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id INTEGER,
            link TEXT,
            is_used INTEGER DEFAULT 0,
            used_by INTEGER,
            used_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(agent_id) REFERENCES agents(id)
        );
    `);

    console.log('✅ Database ready.');

    // Seed 6 models (3 male, 3 female) if none exist
    const count = await db.get('SELECT COUNT(*) as c FROM agents');
    if (count.c === 0) {
        const maleNames = ['Alex', 'Marco', 'James'];
        const femaleNames = ['Emma', 'Sophia', 'Isabella'];
        for (let name of maleNames) {
            await db.run(
                'INSERT INTO agents (name, age, location, gender) VALUES (?, 27, "New York", "male")',
                name
            );
        }
        for (let name of femaleNames) {
            await db.run(
                'INSERT INTO agents (name, age, location, gender) VALUES (?, 26, "Paris", "female")',
                name
            );
        }
        console.log('🌱 Seeded 6 default models.');
    }
})();

// ----------------------------------------------------------------------
// STATE MANAGEMENT (registration flow)
// ----------------------------------------------------------------------
const userState = {};        // { userId: { step, tempData } }
const adminState = {};       // for editing flow (unchanged)

// ----------------------------------------------------------------------
// HELPER FUNCTIONS
// ----------------------------------------------------------------------
async function isRegistered(userId) {
    const user = await db.get('SELECT user_id FROM users WHERE user_id = ?', userId);
    return !!user;
}

async function getUser(userId) {
    return db.get('SELECT * FROM users WHERE user_id = ?', userId);
}

// Show main menu after registration
async function showMainMenu(chatId) {
    bot.sendMessage(chatId, '🏠 *Main Menu*', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔍 Browse Models', callback_data: 'browse_models' }]
            ]
        }
    });
}

// ----------------------------------------------------------------------
// REGISTRATION FLOW
// ----------------------------------------------------------------------
async function startRegistration(userId, firstName, username) {
    userState[userId] = { step: 'gender' };
    await db.run(
        `INSERT INTO users (user_id, first_name, username) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO NOTHING`,
        [userId, firstName, username]
    );
    bot.sendMessage(userId, '👤 *Registration*\nPlease select your gender:', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '♂️ Male', callback_data: 'reg_gender_male' },
                 { text: '♀️ Female', callback_data: 'reg_gender_female' }]
            ]
        }
    });
}

// ----------------------------------------------------------------------
// COMMAND HANDLERS
// ----------------------------------------------------------------------
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'User';
    const username = msg.from.username || '';

    if (await isRegistered(userId)) {
        showMainMenu(userId);
    } else {
        startRegistration(userId, firstName, username);
    }
});

// Admin commands (only for ADMIN_ID)
bot.onText(/\/create/, (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    adminState[ADMIN_ID] = { step: 'CREATE_NAME' };
    bot.sendMessage(ADMIN_ID, "🆕 **Create New Model**\n\nEnter the **Name**:");
});

bot.onText(/\/edit (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];
    const agent = await db.get('SELECT * FROM agents WHERE name = ?', name);
    if (!agent) return bot.sendMessage(ADMIN_ID, `❌ Agent "${name}" not found.`);
    adminState[ADMIN_ID] = { step: 'EDIT_AGE', agent_id: agent.id };
    bot.sendMessage(ADMIN_ID, `✏️ Editing ${name}\n\nEnter the **Age** (e.g. 27):`);
});

bot.onText(/\/delete (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];
    await db.run('DELETE FROM agents WHERE name = ?', name);
    bot.sendMessage(ADMIN_ID, `🗑️ Deleted: ${name}`);
});

bot.onText(/\/list/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const agents = await db.all('SELECT name, gender, age, location FROM agents');
    if (!agents.length) return bot.sendMessage(ADMIN_ID, 'No models.');
    const lines = agents.map(a => `- ${a.name} (${a.gender}, ${a.age}, ${a.location})`);
    bot.sendMessage(ADMIN_ID, `📋 *Models:*\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
});

// Add a group link for a model
bot.onText(/\/addlink (.+) (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const [name, link] = [match[1], match[2]];
    const agent = await db.get('SELECT id FROM agents WHERE name = ?', name);
    if (!agent) return bot.sendMessage(ADMIN_ID, '❌ Model not found.');
    await db.run(
        'INSERT INTO model_links (agent_id, link) VALUES (?, ?)',
        [agent.id, link]
    );
    bot.sendMessage(ADMIN_ID, `✅ Link added for ${name}.`);
});

// List links for a model
bot.onText(/\/links (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const name = match[1];
    const agent = await db.get('SELECT id FROM agents WHERE name = ?', name);
    if (!agent) return bot.sendMessage(ADMIN_ID, '❌ Model not found.');
    const links = await db.all(
        'SELECT link, is_used, used_by FROM model_links WHERE agent_id = ?',
        agent.id
    );
    if (!links.length) return bot.sendMessage(ADMIN_ID, 'No links for this model.');
    const lines = links.map((l, i) => 
        `${i+1}. ${l.link} — ${l.is_used ? 'used' : 'available'}`
    );
    bot.sendMessage(ADMIN_ID, `🔗 *Links for ${name}:*\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
});

// ----------------------------------------------------------------------
// CALLBACK QUERY HANDLER (inline keyboards)
// ----------------------------------------------------------------------
bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const data = query.data;
    const chatId = query.message.chat.id;

    // Registration flow callbacks
    if (data.startsWith('reg_gender_')) {
        const gender = data.split('_')[2]; // male / female
        userState[userId].gender = gender;
        userState[userId].step = 'interested';
        bot.editMessageText('Who are you interested in?', {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: {
                inline_keyboard: [
                    [{ text: '♂️ Male', callback_data: 'reg_interested_male' },
                     { text: '♀️ Female', callback_data: 'reg_interested_female' }]
                ]
            }
        });
        return;
    }

    if (data.startsWith('reg_interested_')) {
        const interested = data.split('_')[2]; // male / female
        userState[userId].interested_in = interested;
        userState[userId].step = 'age';
        bot.editMessageText('Enter your age (e.g. 25):', {
            chat_id: chatId,
            message_id: query.message.message_id
        });
        return;
    }

    // Browse models
    if (data === 'browse_models') {
        const user = await getUser(userId);
        if (!user) return bot.sendMessage(chatId, 'Please /start first.');

        const agents = await db.all(
            'SELECT id, name, age, location, photo1 FROM agents WHERE gender = ?',
            user.interested_in
        );
        if (!agents.length) {
            return bot.sendMessage(chatId, 'No models available for your preference.');
        }

        // Send each model as a separate message with photo and inline button
        for (const agent of agents) {
            const caption = `${agent.name}, ${agent.age}, ${agent.location}`;
            const keyboard = {
                inline_keyboard: [[
                    { text: '💬 Chat with her/him', callback_data: `chat_${agent.id}` }
                ]]
            };
            if (agent.photo1) {
                await bot.sendPhoto(chatId, agent.photo1, {
                    caption,
                    reply_markup: keyboard
                });
            } else {
                await bot.sendMessage(chatId, caption, { reply_markup: keyboard });
            }
        }
        return;
    }

    // Chat request (model selected)
    if (data.startsWith('chat_')) {
        const agentId = data.split('_')[1];
        const user = await getUser(userId);
        if (!user) return bot.sendMessage(chatId, 'Please /start first.');

        if (user.has_used_link) {
            return bot.sendMessage(chatId, '⚠️ You have already used a chat link. You cannot request another.');
        }

        // Find an unused link for this model
        const link = await db.get(
            'SELECT * FROM model_links WHERE agent_id = ? AND is_used = 0 ORDER BY created_at LIMIT 1',
            agentId
        );
        if (!link) {
            return bot.sendMessage(chatId, 'Sorry, no available link for this model right now. Try later.');
        }

        // Mark link as used
        await db.run(
            'UPDATE model_links SET is_used = 1, used_by = ?, used_at = datetime("now") WHERE id = ?',
            [userId, link.id]
        );
        await db.run('UPDATE users SET has_used_link = 1 WHERE user_id = ?', userId);

        // Send link to user
        bot.sendMessage(chatId, `✅ Here is your one‑time link to chat with the model:\n${link.link}\n\nClick to join the group.`);

        // Notify admin
        const agent = await db.get('SELECT name FROM agents WHERE id = ?', agentId);
        bot.sendMessage(
            ADMIN_ID,
            `🔔 *Link Used*\nUser: ${user.first_name} (@${user.username || 'no username'})\nModel: ${agent.name}\nLink: ${link.link}`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    // Fallback
    bot.answerCallbackQuery(query.id);
});

// ----------------------------------------------------------------------
// TEXT MESSAGE HANDLER (for registration age/country, admin editing)
// ----------------------------------------------------------------------
bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/')) return; // commands handled above

    const userId = msg.chat.id;

    // Admin editing flow (unchanged, but photo handling modified to store file_id)
    if (userId === ADMIN_ID && adminState[ADMIN_ID]) {
        await handleAdminFlow(msg);
        return;
    }

    // User registration: age and country
    if (userState[userId] && userState[userId].step === 'age') {
        const age = parseInt(msg.text);
        if (isNaN(age) || age < 18 || age > 100) {
            return bot.sendMessage(userId, '⚠️ Please enter a valid age (18–100).');
        }
        userState[userId].age = age;
        userState[userId].step = 'country';
        bot.sendMessage(userId, '📌 Enter your country (e.g. United States):');
        return;
    }

    if (userState[userId] && userState[userId].step === 'country') {
        const country = msg.text;
        // Save all registration data to DB
        const data = userState[userId];
        await db.run(
            `UPDATE users SET gender = ?, interested_in = ?, age = ?, country = ? WHERE user_id = ?`,
            [data.gender, data.interested_in, data.age, country, userId]
        );
        delete userState[userId];
        bot.sendMessage(userId, '✅ Registration complete!');
        showMainMenu(userId);
        return;
    }

    // Any other text: ignore (or could be handled as fallback)
});

// ----------------------------------------------------------------------
// ADMIN EDITING FLOW (adapted to store file_id instead of local files)
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
                bot.sendMessage(ADMIN_ID, `✅ Created **${name}**.\nNow send **Photo #1** (or type 'skip'):`);
            } catch (e) {
                bot.sendMessage(ADMIN_ID, `❌ Name "${name}" already exists.`);
                delete adminState[ADMIN_ID];
            }
            return;
        }

        if (state.step === 'EDIT_AGE') {
            const age = parseInt(msg.text);
            if (!isNaN(age)) {
                await db.run('UPDATE agents SET age = ? WHERE id = ?', [age, state.agent_id]);
                adminState[ADMIN_ID] = { step: 'EDIT_photos_1', agent_id: state.agent_id };
                bot.sendMessage(ADMIN_ID, "✅ Age updated.\nNow send **Photo #1** (or 'skip'):");
            } else {
                bot.sendMessage(ADMIN_ID, "⚠️ Please enter a number.");
            }
            return;
        }

        if (state.step.startsWith('EDIT_photos_')) {
            const photoNum = state.step.split('_')[2]; // "1", "2", "3"
            if (msg.text && msg.text.toLowerCase() === 'skip') {
                return advancePhotoStep(state.agent_id, parseInt(photoNum));
            }
            if (msg.photo) {
                const fileId = msg.photo[msg.photo.length - 1].file_id;
                await db.run(`UPDATE agents SET photo${photoNum} = ? WHERE id = ?`, [fileId, state.agent_id]);
                bot.sendMessage(ADMIN_ID, `✅ Photo ${photoNum} saved.`);
                return advancePhotoStep(state.agent_id, parseInt(photoNum));
            } else {
                bot.sendMessage(ADMIN_ID, "⚠️ Please send a photo or type 'skip'.");
            }
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
        bot.sendMessage(ADMIN_ID, "🎉 **Model setup complete!**");
    }
}

// ----------------------------------------------------------------------
// START
// ----------------------------------------------------------------------
console.log('🤖 Bot is running...');
