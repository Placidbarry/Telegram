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
    console.error("❌ Missing BOT_TOKEN or ADMIN_ID in environment.");
    process.exit(1);
}

// ----------------------------------------------------------------------
// BOT INIT (polling mode)
// ----------------------------------------------------------------------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🤖 Bot started (polling)");

// ----------------------------------------------------------------------
// DATABASE (async)
// ----------------------------------------------------------------------
let db;

(async () => {
    db = await open({ filename: './agency.db', driver: sqlite3.Database });

    // Users table – registration data
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            gender TEXT,
            interested TEXT,
            age INTEGER,
            country TEXT DEFAULT 'USA',
            registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Models table – pre‑defined 6 models (3 male, 3 female)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS models (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            gender TEXT,
            age INTEGER,
            country TEXT DEFAULT 'USA',
            photo_file_id TEXT
        );
    `);

    // Insert default models if table is empty
    const count = await db.get('SELECT COUNT(*) as c FROM models');
    if (count.c === 0) {
        const defaultModels = [
            // Male
            { name: 'Mike', gender: 'male', age: 27 },
            { name: 'John', gender: 'male', age: 28 },
            { name: 'David', gender: 'male', age: 26 },
            // Female
            { name: 'Emma', gender: 'female', age: 27 },
            { name: 'Sophia', gender: 'female', age: 28 },
            { name: 'Olivia', gender: 'female', age: 26 }
        ];
        for (const m of defaultModels) {
            await db.run(
                'INSERT INTO models (name, gender, age, country) VALUES (?, ?, ?, ?)',
                [m.name, m.gender, m.age, 'USA']
            );
        }
        console.log("✅ Default models inserted.");
    }

    console.log("✅ Database ready.");
})();

// ----------------------------------------------------------------------
// STATE MANAGEMENT (registration flow)
// ----------------------------------------------------------------------
const userState = {}; // { userId: { step: 'gender'|'interested'|'age'|'country', tempData } }

// Registration steps
const Steps = {
    GENDER: 'gender',
    INTERESTED: 'interested',
    AGE: 'age',
    COUNTRY: 'country'
};

// ----------------------------------------------------------------------
// COMMAND: /start – begin registration
// ----------------------------------------------------------------------
bot.onText(/\/start/, async (msg) => {
    const userId = msg.from.id;
    const firstName = msg.from.first_name || 'User';

    // Check if already registered
    const user = await db.get('SELECT * FROM users WHERE user_id = ?', userId);
    if (user) {
        // Already registered → show models directly
        return showModels(userId, user.interested);
    }

    // Start registration: ask gender
    userState[userId] = { step: Steps.GENDER, tempData: {} };
    bot.sendMessage(userId,
        `👋 Welcome, ${firstName}! Let's get you registered.\n\nPlease select your **gender**:`,
        {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '♂️ Male', callback_data: 'gender_male' }],
                    [{ text: '♀️ Female', callback_data: 'gender_female' }]
                ]
            }
        }
    );
});

// ----------------------------------------------------------------------
// CALLBACK QUERY HANDLER
// ----------------------------------------------------------------------
bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const data = query.data;

    // Acknowledge the callback
    bot.answerCallbackQuery(query.id);

    // Handle model selection
    if (data.startsWith('model_')) {
        const modelId = parseInt(data.split('_')[1]);
        return handleModelSelection(userId, modelId);
    }

    // Handle registration steps
    const state = userState[userId];
    if (!state) {
        return bot.sendMessage(userId, "Please use /start to begin.");
    }

    // Gender selection
    if (data === 'gender_male' || data === 'gender_female') {
        const gender = data === 'gender_male' ? 'male' : 'female';
        state.tempData.gender = gender;
        state.step = Steps.INTERESTED;
        bot.editMessageText(
            "You are interested in:",
            {
                chat_id: userId,
                message_id: query.message.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '♂️ Male', callback_data: 'interested_male' }],
                        [{ text: '♀️ Female', callback_data: 'interested_female' }]
                    ]
                }
            }
        );
    }
    // Interested selection
    else if (data === 'interested_male' || data === 'interested_female') {
        const interested = data === 'interested_male' ? 'male' : 'female';
        state.tempData.interested = interested;
        state.step = Steps.AGE;
        bot.editMessageText(
            "Please enter your **age** (e.g. 25):",
            {
                chat_id: userId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown'
            }
        );
    }
});

// ----------------------------------------------------------------------
// TEXT MESSAGE HANDLER (for age and country confirmation)
// ----------------------------------------------------------------------
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;

    const userId = msg.chat.id;
    const state = userState[userId];
    if (!state) return;

    // Age step
    if (state.step === Steps.AGE) {
        const age = parseInt(msg.text);
        if (isNaN(age) || age < 18 || age > 100) {
            return bot.sendMessage(userId, "❌ Please enter a valid age (18-100).");
        }
        state.tempData.age = age;
        state.step = Steps.COUNTRY;
        // Country is fixed to USA, just ask for confirmation
        bot.sendMessage(userId,
            "Your country is **USA** (only available).\n\nConfirm to finish registration:",
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Confirm USA', callback_data: 'country_confirm' }]
                    ]
                }
            }
        );
    }
});

// Handle country confirmation callback
bot.on('callback_query', async (query) => {
    const userId = query.from.id;
    const data = query.data;
    if (data !== 'country_confirm') return;

    bot.answerCallbackQuery(query.id);

    const state = userState[userId];
    if (!state || state.step !== Steps.COUNTRY) return;

    const { gender, interested, age } = state.tempData;
    // Save user to database
    await db.run(
        'INSERT INTO users (user_id, gender, interested, age, country) VALUES (?, ?, ?, ?, ?)',
        [userId, gender, interested, age, 'USA']
    );

    delete userState[userId];
    bot.editMessageText(
        "✅ Registration complete! Here are the available models:",
        {
            chat_id: userId,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: [] }
        }
    );

    // Show models based on interested gender
    await showModels(userId, interested);
});

// ----------------------------------------------------------------------
// SHOW MODELS (filtered by interested gender)
// ----------------------------------------------------------------------
async function showModels(userId, interestedGender) {
    const models = await db.all('SELECT * FROM models WHERE gender = ?', interestedGender);
    if (models.length === 0) {
        return bot.sendMessage(userId, "Sorry, no models available for your preference.");
    }

    // Send each model as a separate message with photo (if available) and select button
    for (const model of models) {
        const caption = `*${model.name}*, ${model.age} years old\n📍 ${model.country}`;
        const buttons = [
            [{ text: '💬 Select this model', callback_data: `model_${model.id}` }]
        ];

        if (model.photo_file_id) {
            await bot.sendPhoto(userId, model.photo_file_id, {
                caption,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        } else {
            await bot.sendMessage(userId, caption, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
        }
    }
}

// ----------------------------------------------------------------------
// HANDLE MODEL SELECTION
// ----------------------------------------------------------------------
async function handleModelSelection(userId, modelId) {
    const user = await db.get('SELECT * FROM users WHERE user_id = ?', userId);
    if (!user) {
        return bot.sendMessage(userId, "Please /start to register first.");
    }

    const model = await db.get('SELECT * FROM models WHERE id = ?', modelId);
    if (!model) {
        return bot.sendMessage(userId, "Model not found.");
    }

    // Notify admin
    const notification = `🆕 *New model request*\n\n*User:* ${userId}\n*Gender:* ${user.gender}\n*Interested in:* ${user.interested}\n*Age:* ${user.age}\n*Country:* ${user.country}\n\n*Selected model:* ${model.name} (${model.gender}, ${model.age})\n\nPlease reply to this message with the **private group invite link** for the user.`;
    const adminMsg = await bot.sendMessage(ADMIN_ID, notification, { parse_mode: 'Markdown' });

    // Store the request mapping (admin message id -> user id, model id) so we know who to send the link to
    // We'll use a simple in‑memory store (could be database, but simple map is fine for now)
    if (!global.pendingRequests) global.pendingRequests = new Map();
    global.pendingRequests.set(adminMsg.message_id, { userId, modelId });

    bot.sendMessage(userId, "⏳ Your request has been sent to the admin. You will receive a group invite link shortly.");
}

// ----------------------------------------------------------------------
// ADMIN REPLIES WITH GROUP LINK
// ----------------------------------------------------------------------
bot.on('message', async (msg) => {
    if (msg.chat.id !== ADMIN_ID || !msg.reply_to_message) return;

    const repliedMsgId = msg.reply_to_message.message_id;
    const request = global.pendingRequests?.get(repliedMsgId);
    if (!request) return;

    const link = msg.text.trim();
    // Simple validation – you might want to check if it's a valid t.me/joinchat/xxx link
    if (!link.startsWith('https://t.me/') && !link.startsWith('t.me/')) {
        return bot.sendMessage(ADMIN_ID, "❌ That doesn't look like a valid Telegram invite link. Please try again.");
    }

    // Send link to the user
    await bot.sendMessage(request.userId,
        `✅ Here is your private group link to chat with the model:\n${link}\n\nEnjoy your conversation!`
    );

    // Clean up
    global.pendingRequests.delete(repliedMsgId);
    bot.sendMessage(ADMIN_ID, "✅ Link forwarded to the user.");
});

// ----------------------------------------------------------------------
// ADMIN COMMAND: /setphoto <model_id> – update model's photo
// ----------------------------------------------------------------------
bot.onText(/\/setphoto (\d+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;

    const modelId = parseInt(match[1]);
    const model = await db.get('SELECT * FROM models WHERE id = ?', modelId);
    if (!model) {
        return bot.sendMessage(ADMIN_ID, `❌ Model with ID ${modelId} not found.`);
    }

    // Store state to expect a photo
    if (!global.adminPhotoState) global.adminPhotoState = {};
    global.adminPhotoState[ADMIN_ID] = { modelId };
    bot.sendMessage(ADMIN_ID, `📸 Please send the new photo for *${model.name}*.`, { parse_mode: 'Markdown' });
});

// Handle photo upload from admin
bot.on('photo', async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    if (!global.adminPhotoState?.[ADMIN_ID]) return;

    const { modelId } = global.adminPhotoState[ADMIN_ID];
    const fileId = msg.photo[msg.photo.length - 1].file_id;

    // Update database
    await db.run('UPDATE models SET photo_file_id = ? WHERE id = ?', [fileId, modelId]);

    delete global.adminPhotoState[ADMIN_ID];
    bot.sendMessage(ADMIN_ID, `✅ Photo updated for model ID ${modelId}.`);
});

// ----------------------------------------------------------------------
// ADMIN COMMAND: /models – list all models with IDs
// ----------------------------------------------------------------------
bot.onText(/\/models/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const models = await db.all('SELECT * FROM models');
    let text = "📋 *Models:*\n";
    models.forEach(m => {
        text += `ID ${m.id}: ${m.name} (${m.gender}, ${m.age}) – ${m.photo_file_id ? '✅ photo' : '❌ no photo'}\n`;
    });
    bot.sendMessage(ADMIN_ID, text, { parse_mode: 'Markdown' });
});

// ----------------------------------------------------------------------
// STARTUP MESSAGE
// ----------------------------------------------------------------------
console.log("✅ Bot is running. Admin ID:", ADMIN_ID);
