/**
 * SYNC HEARTS AGENCY — SIMPLIFIED EDITION
 * Features: Inline keyboard navigation, model browsing by gender preference,
 *           group invite links per model, admin model management.
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

// ----------------------------------------------------------------------
// EXPRESS SETUP
// ----------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;

// Create upload directory if it doesn't exist
const UPLOAD_DIR = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
app.use('/uploads', express.static(UPLOAD_DIR));

// Simple "Coming Soon" page for the web app (still referenced but not used)
app.get('/', (req, res) => {
    res.send('<h1>Coming up soon</h1>');
});

// ----------------------------------------------------------------------
// ENVIRONMENT VARIABLES
// ----------------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
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

// Set webhook
const webhookUrl = `${SERVER_URL}/bot${BOT_TOKEN}`;
bot.setWebHook(webhookUrl);
console.log(`🔗 Webhook set to: ${webhookUrl}`);

// Route for Telegram updates
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

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
            registered INTEGER DEFAULT 0
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS models (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            age INTEGER,
            gender TEXT,
            photo1 TEXT,
            photo2 TEXT,
            photo3 TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS model_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            model_id INTEGER,
            link TEXT,
            used INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(model_id) REFERENCES models(id) ON DELETE CASCADE
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

// List of countries for inline selection
const COUNTRIES = [
    "USA", "Canada", "UK", "Australia", "Germany", "France", "Italy", "Spain",
    "Netherlands", "Sweden", "Norway", "Denmark", "Finland", "Switzerland",
    "Austria", "Belgium", "Ireland", "Portugal", "Greece", "Poland", "Czech Republic",
    "Hungary", "Romania", "Bulgaria", "Russia", "Ukraine", "Turkey", "Israel",
    "UAE", "Saudi Arabia", "India", "Pakistan", "Bangladesh", "China", "Japan",
    "South Korea", "Thailand", "Vietnam", "Malaysia", "Singapore", "Philippines",
    "Indonesia", "Brazil", "Mexico", "Argentina", "Colombia", "Chile", "Peru",
    "South Africa", "Nigeria", "Kenya", "Egypt", "Morocco"
];

// ----------------------------------------------------------------------
// STATE MACHINES
// ----------------------------------------------------------------------
// User states for registration
const userState = {};

// Admin states for model management
const adminState = {};

// ----------------------------------------------------------------------
// COMMAND HANDLERS
// ----------------------------------------------------------------------

// /start - Welcome with main menu
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'User';
    const username = msg.from.username || '';

    try {
        if (!db) return bot.sendMessage(userId, "System initializing, please try later.");

        // Insert or update user basic info
        await db.run(
            `INSERT INTO users (user_id, first_name, username, registered)
             VALUES (?, ?, ?, 0)
             ON CONFLICT(user_id) DO UPDATE SET first_name = ?, username = ?`,
            [userId, firstName, username, firstName, username]
        );

        const user = await db.get('SELECT registered FROM users WHERE user_id = ?', userId);

        const inlineKeyboard = [];
        if (!user.registered) {
            inlineKeyboard.push([{ text: "📝 Register", callback_data: "register" }]);
        } else {
            inlineKeyboard.push([{ text: "🔍 Browse Models", callback_data: "browse" }]);
            inlineKeyboard.push([{ text: "👤 My Profile", callback_data: "profile" }]);
        }

        bot.sendMessage(userId,
            `🔥 **Welcome, ${firstName}!**\n\nUse the buttons below to navigate.`,
            {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: inlineKeyboard }
            }
        );
    } catch (e) {
        console.error("Start Error:", e);
    }
});

// ----------------------------------------------------------------------
// ADMIN COMMANDS
// ----------------------------------------------------------------------

// /addmodel - Start creating a new model
bot.onText(/\/addmodel/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    adminState[ADMIN_ID] = { step: 'CREATE_NAME' };
    bot.sendMessage(ADMIN_ID, "🆕 **Create New Model**\n\nEnter the model's name:");
});

// /editmodel <id> - Edit an existing model
bot.onText(/\/editmodel (\d+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const modelId = parseInt(match[1]);

    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");

        const model = await db.get('SELECT * FROM models WHERE id = ?', modelId);
        if (!model) return bot.sendMessage(ADMIN_ID, `❌ Model ID ${modelId} not found.`);

        adminState[ADMIN_ID] = { step: 'EDIT_AGE', model_id: modelId };
        bot.sendMessage(ADMIN_ID, `✏️ **Editing ${model.name} (ID: ${modelId})**\n\nEnter new age (or /cancel):`);
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

// /deletemodel <id> - Delete a model and its links
bot.onText(/\/deletemodel (\d+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const modelId = parseInt(match[1]);

    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");

        const model = await db.get('SELECT * FROM models WHERE id = ?', modelId);
        if (!model) return bot.sendMessage(ADMIN_ID, `❌ Model ID ${modelId} not found.`);

        await db.run('DELETE FROM models WHERE id = ?', modelId);
        // Links cascade deleted
        bot.sendMessage(ADMIN_ID, `🗑️ Deleted model **${model.name}** (ID: ${modelId}).`);
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

// /listmodels - List all models
bot.onText(/\/listmodels/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");

        const models = await db.all('SELECT id, name, age, gender FROM models');
        if (models.length === 0) return bot.sendMessage(ADMIN_ID, "No models found. Use /addmodel");

        let text = "📋 **Models:**\n";
        models.forEach(m => text += `- ID: ${m.id} | ${m.name} (${m.age}, ${m.gender})\n`);
        bot.sendMessage(ADMIN_ID, text);
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

// /addlink <model_id> <link> - Add a new chat link to a model
bot.onText(/\/addlink (\d+) (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const modelId = parseInt(match[1]);
    const link = match[2];

    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");

        const model = await db.get('SELECT * FROM models WHERE id = ?', modelId);
        if (!model) return bot.sendMessage(ADMIN_ID, `❌ Model ID ${modelId} not found.`);

        // Count existing links for this model
        const count = await db.get('SELECT COUNT(*) as cnt FROM model_links WHERE model_id = ?', modelId);
        if (count.cnt >= 5) {
            return bot.sendMessage(ADMIN_ID, `❌ Model ${model.name} already has 5 links. Remove some first.`);
        }

        await db.run('INSERT INTO model_links (model_id, link) VALUES (?, ?)', [modelId, link]);
        bot.sendMessage(ADMIN_ID, `✅ Added link to ${model.name}.`);
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

// /removelink <link_id> - Remove a link
bot.onText(/\/removelink (\d+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const linkId = parseInt(match[1]);

    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");

        const link = await db.get('SELECT * FROM model_links WHERE id = ?', linkId);
        if (!link) return bot.sendMessage(ADMIN_ID, `❌ Link ID ${linkId} not found.`);

        await db.run('DELETE FROM model_links WHERE id = ?', linkId);
        bot.sendMessage(ADMIN_ID, `✅ Removed link ID ${linkId}.`);
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

// /listlinks <model_id> - Show links for a model
bot.onText(/\/listlinks (\d+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const modelId = parseInt(match[1]);

    try {
        if (!db) return bot.sendMessage(ADMIN_ID, "Database not ready.");

        const model = await db.get('SELECT * FROM models WHERE id = ?', modelId);
        if (!model) return bot.sendMessage(ADMIN_ID, `❌ Model ID ${modelId} not found.`);

        const links = await db.all('SELECT id, link, used FROM model_links WHERE model_id = ?', modelId);
        if (links.length === 0) {
            return bot.sendMessage(ADMIN_ID, `No links for ${model.name}. Use /addlink to add.`);
        }

        let text = `🔗 **Links for ${model.name}:**\n`;
        links.forEach(l => text += `ID: ${l.id} | Used: ${l.used ? '✅' : '❌'} | ${l.link}\n`);
        bot.sendMessage(ADMIN_ID, text);
    } catch (e) {
        bot.sendMessage(ADMIN_ID, `❌ Error: ${e.message}`);
    }
});

// ----------------------------------------------------------------------
// CALLBACK QUERY HANDLER
// ----------------------------------------------------------------------
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;

    // Answer callback to remove loading state
    bot.answerCallbackQuery(callbackQuery.id);

    try {
        if (!db) return bot.sendMessage(userId, "System initializing, please try later.");

        // Handle registration steps
        if (data === 'register') {
            userState[userId] = { step: 'gender' };
            return bot.sendMessage(userId, "Please select your gender:", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "♂️ Male", callback_data: "set_gender_male" }],
                        [{ text: "♀️ Female", callback_data: "set_gender_female" }]
                    ]
                }
            });
        }

        if (data.startsWith('set_gender_')) {
            const gender = data.split('_')[2];
            if (userState[userId] && userState[userId].step === 'gender') {
                userState[userId].gender = gender;
                userState[userId].step = 'interested';
                return bot.sendMessage(userId, "You are interested in:", {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "♂️ Male", callback_data: "set_interested_male" }],
                            [{ text: "♀️ Female", callback_data: "set_interested_female" }]
                        ]
                    }
                });
            }
        }

        if (data.startsWith('set_interested_')) {
            const interested = data.split('_')[2];
            if (userState[userId] && userState[userId].step === 'interested') {
                userState[userId].interested = interested;
                userState[userId].step = 'age';
                return bot.sendMessage(userId, "Please enter your age (e.g., 25):");
            }
        }

        // Handle country selection
        if (data.startsWith('country_')) {
            const country = data.substring(8); // remove 'country_'
            if (userState[userId] && userState[userId].step === 'country') {
                userState[userId].country = country;
                // Save user registration
                const user = userState[userId];
                await db.run(
                    `UPDATE users SET gender = ?, interested_in = ?, age = ?, country = ?, registered = 1
                     WHERE user_id = ?`,
                    [user.gender, user.interested, user.age, country, userId]
                );
                delete userState[userId];

                // Send confirmation and main menu
                const inlineKeyboard = [
                    [{ text: "🔍 Browse Models", callback_data: "browse" }],
                    [{ text: "👤 My Profile", callback_data: "profile" }]
                ];
                return bot.sendMessage(userId,
                    "✅ Registration complete! You can now browse models.",
                    { reply_markup: { inline_keyboard: inlineKeyboard } }
                );
            }
        }

        // Handle browse
        if (data === 'browse') {
            const user = await db.get('SELECT interested_in FROM users WHERE user_id = ?', userId);
            if (!user || !user.registered) {
                return bot.sendMessage(userId, "Please register first using /start.");
            }

            const interested = user.interested_in;
            const models = await db.all('SELECT id, name, age, gender FROM models WHERE gender = ?', interested);
            if (models.length === 0) {
                return bot.sendMessage(userId, "No models available matching your interest.");
            }

            // Build inline keyboard with models
            const buttons = models.map(m => ([
                { text: `${m.name} (${m.age})`, callback_data: `model_${m.id}` }
            ]));
            bot.sendMessage(userId, "Select a model to view profile:", {
                reply_markup: { inline_keyboard: buttons }
            });
        }

        // Handle model selection
        if (data.startsWith('model_')) {
            const modelId = parseInt(data.split('_')[1]);
            const model = await db.get('SELECT * FROM models WHERE id = ?', modelId);
            if (!model) return bot.sendMessage(userId, "Model not found.");

            // Prepare photos
            const photos = [];
            if (model.photo1) photos.push(`${SERVER_URL}/uploads/${model.photo1}`);
            if (model.photo2) photos.push(`${SERVER_URL}/uploads/${model.photo2}`);
            if (model.photo3) photos.push(`${SERVER_URL}/uploads/${model.photo3}`);

            const caption = `*${model.name}*, ${model.age}\nGender: ${model.gender}`;

            if (photos.length > 0) {
                // Send first photo with caption, and additional photos separately
                await bot.sendPhoto(userId, photos[0], { caption, parse_mode: 'Markdown' });
                for (let i = 1; i < photos.length; i++) {
                    await bot.sendPhoto(userId, photos[i]);
                }
            } else {
                await bot.sendMessage(userId, caption, { parse_mode: 'Markdown' });
            }

            // Show Chat button
            bot.sendMessage(userId, "Want to chat with this model?", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "💬 Chat", callback_data: `chat_${modelId}` }],
                        [{ text: "🔙 Back to models", callback_data: "browse" }]
                    ]
                }
            });
        }

        // Handle chat request
        if (data.startsWith('chat_')) {
            const modelId = parseInt(data.split('_')[1]);
            const model = await db.get('SELECT name FROM models WHERE id = ?', modelId);
            if (!model) return bot.sendMessage(userId, "Model not found.");

            // Find an unused link for this model
            const link = await db.get('SELECT * FROM model_links WHERE model_id = ? AND used = 0 ORDER BY created_at LIMIT 1', modelId);
            if (!link) {
                // Notify admin that links are exhausted
                bot.sendMessage(ADMIN_ID, `⚠️ No unused links for model **${model.name}** (ID: ${modelId}). Please add more.`, { parse_mode: 'Markdown' });
                return bot.sendMessage(userId, "Sorry, no chat links available at the moment. Please try later.");
            }

            // Mark link as used
            await db.run('UPDATE model_links SET used = 1 WHERE id = ?', link.id);

            // Send link to user
            bot.sendMessage(userId, `Click to join group and chat with ${model.name}: ${link.link}`);

            // Notify admin that a link was used
            bot.sendMessage(ADMIN_ID, `🔗 Link used for model **${model.name}** (ID: ${modelId}) by user ${userId}.`, { parse_mode: 'Markdown' });
        }

        // Handle profile view
        if (data === 'profile') {
            const user = await db.get('SELECT first_name, username, gender, interested_in, age, country FROM users WHERE user_id = ?', userId);
            if (!user) return bot.sendMessage(userId, "You are not registered. Use /start.");

            const text = `👤 *Your Profile*\n\nName: ${user.first_name}\nUsername: @${user.username}\nGender: ${user.gender}\nInterested in: ${user.interested_in}\nAge: ${user.age}\nCountry: ${user.country}`;
            bot.sendMessage(userId, text, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        console.error("Callback error:", e);
        bot.sendMessage(userId, "An error occurred. Please try again.");
    }
});

// ----------------------------------------------------------------------
// MESSAGE HANDLER (for non-command, non-callback messages)
// ----------------------------------------------------------------------
bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/')) return; // commands handled separately

    const userId = msg.chat.id;

    // Handle admin flow (model creation/editing)
    if (userId === ADMIN_ID && adminState[ADMIN_ID]) {
        await handleAdminFlow(msg);
        return;
    }

    // Handle user registration steps (age input)
    if (userState[userId] && userState[userId].step === 'age') {
        const age = parseInt(msg.text);
        if (isNaN(age) || age < 18 || age > 100) {
            return bot.sendMessage(userId, "Please enter a valid age (18-100).");
        }
        userState[userId].age = age;
        userState[userId].step = 'country';

        // Show country selection as inline keyboard (paginated if needed)
        const countryButtons = [];
        for (let i = 0; i < COUNTRIES.length; i += 2) {
            const row = [];
            row.push({ text: COUNTRIES[i], callback_data: `country_${COUNTRIES[i]}` });
            if (i + 1 < COUNTRIES.length) {
                row.push({ text: COUNTRIES[i + 1], callback_data: `country_${COUNTRIES[i + 1]}` });
            }
            countryButtons.push(row);
        }
        return bot.sendMessage(userId, "Please select your country:", {
            reply_markup: { inline_keyboard: countryButtons }
        });
    }
});

// ----------------------------------------------------------------------
// ADMIN FLOW HANDLER
// ----------------------------------------------------------------------
async function handleAdminFlow(msg) {
    const state = adminState[ADMIN_ID];
    if (!state) return;

    try {
        // CREATE_NAME
        if (state.step === 'CREATE_NAME') {
            const name = msg.text;
            try {
                const result = await db.run('INSERT INTO models (name) VALUES (?)', name);
                adminState[ADMIN_ID] = { step: 'CREATE_AGE', model_id: result.lastID, name };
                bot.sendMessage(ADMIN_ID, `✅ Created **${name}**.\n\nEnter age:`);
            } catch (e) {
                bot.sendMessage(ADMIN_ID, `❌ Name "${name}" already exists. Try another.`);
                delete adminState[ADMIN_ID];
            }
            return;
        }

        // CREATE_AGE
        if (state.step === 'CREATE_AGE') {
            const age = parseInt(msg.text);
            if (isNaN(age)) return bot.sendMessage(ADMIN_ID, "Please enter a number.");
            await db.run('UPDATE models SET age = ? WHERE id = ?', [age, state.model_id]);
            adminState[ADMIN_ID].step = 'CREATE_GENDER';
            bot.sendMessage(ADMIN_ID, "Age saved. Now select gender:", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Male", callback_data: "admin_set_gender_male" }],
                        [{ text: "Female", callback_data: "admin_set_gender_female" }]
                    ]
                }
            });
            return;
        }

        // EDIT_AGE
        if (state.step === 'EDIT_AGE') {
            const age = parseInt(msg.text);
            if (isNaN(age)) return bot.sendMessage(ADMIN_ID, "Please enter a number.");
            await db.run('UPDATE models SET age = ? WHERE id = ?', [age, state.model_id]);
            adminState[ADMIN_ID].step = 'EDIT_GENDER';
            bot.sendMessage(ADMIN_ID, "Age updated. Now select new gender (or /skip to keep):", {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "Male", callback_data: "admin_set_gender_male" }],
                        [{ text: "Female", callback_data: "admin_set_gender_female" }],
                        [{ text: "Skip", callback_data: "admin_skip_gender" }]
                    ]
                }
            });
            return;
        }

        // Photo upload steps (1,2,3)
        if (state.step.startsWith('PHOTO_')) {
            const photoIndex = parseInt(state.step.split('_')[1]); // 1,2,3
            const colName = `photo${photoIndex}`;

            if (msg.text && msg.text.toLowerCase() === 'skip') {
                // Move to next photo or finish
                if (photoIndex < 3) {
                    adminState[ADMIN_ID].step = `PHOTO_${photoIndex + 1}`;
                    bot.sendMessage(ADMIN_ID, `📸 Send Photo #${photoIndex + 1} (or 'skip'):`);
                } else {
                    delete adminState[ADMIN_ID];
                    bot.sendMessage(ADMIN_ID, "✅ Model setup complete.");
                }
                return;
            }

            if (msg.photo) {
                const fileId = msg.photo[msg.photo.length - 1].file_id;
                const fileName = `model_${state.model_id}_p${photoIndex}_${Date.now()}.jpg`;

                const success = await downloadTelegramFile(fileId, fileName);
                if (success) {
                    await db.run(`UPDATE models SET ${colName} = ? WHERE id = ?`, [fileName, state.model_id]);
                    bot.sendMessage(ADMIN_ID, `✅ Photo ${photoIndex} saved.`);

                    if (photoIndex < 3) {
                        adminState[ADMIN_ID].step = `PHOTO_${photoIndex + 1}`;
                        bot.sendMessage(ADMIN_ID, `📸 Send Photo #${photoIndex + 1} (or 'skip'):`);
                    } else {
                        delete adminState[ADMIN_ID];
                        bot.sendMessage(ADMIN_ID, "✅ Model setup complete.");
                    }
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

// Handle admin callback queries for gender selection during creation/editing
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;

    if (userId !== ADMIN_ID) return; // Only admin

    bot.answerCallbackQuery(callbackQuery.id);

    if (!adminState[ADMIN_ID]) return;

    const state = adminState[ADMIN_ID];

    if (data === 'admin_set_gender_male' || data === 'admin_set_gender_female') {
        const gender = data.split('_')[3];
        if (state.step === 'CREATE_GENDER') {
            await db.run('UPDATE models SET gender = ? WHERE id = ?', [gender, state.model_id]);
            adminState[ADMIN_ID].step = 'PHOTO_1';
            bot.sendMessage(ADMIN_ID, `Gender set to ${gender}. Now send Photo #1 (or 'skip'):`);
        } else if (state.step === 'EDIT_GENDER') {
            await db.run('UPDATE models SET gender = ? WHERE id = ?', [gender, state.model_id]);
            adminState[ADMIN_ID].step = 'PHOTO_1';
            bot.sendMessage(ADMIN_ID, `Gender updated to ${gender}. Now send Photo #1 (or 'skip'):`);
        }
    } else if (data === 'admin_skip_gender') {
        if (state.step === 'EDIT_GENDER') {
            adminState[ADMIN_ID].step = 'PHOTO_1';
            bot.sendMessage(ADMIN_ID, "Gender unchanged. Now send Photo #1 (or 'skip'):");
        }
    }
});

// ----------------------------------------------------------------------
// START SERVER
// ----------------------------------------------------------------------
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
