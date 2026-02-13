// ====================================================================
// BOT.JS - Sync Hearts Agency Backend (The Brain)
// ====================================================================

const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

// ================= CONFIGURATION =================
// 🔴 1. REPLACE with your Telegram Bot Token
const BOT_TOKEN = '8577711169:AAE8Av0ADtel8-4IbreUJe_08g-DenIhHXw'; 

// 🔴 2. REPLACE with your Personal Telegram ID (Get from @userinfobot)
const ADMIN_ID = 7640605912; 

// 🔴 3. REPLACE with your GitHub Page URL (The Mini App)
const WEBAPP_URL = 'https://placidbarry.github.io/sync-hearts-app/'; 

// ================= DATABASE SETUP =================
let db;

async function initDb() {
    db = await open({
        filename: './agency.db',
        driver: sqlite3.Database
    });

    // Create Users Table
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            user_id INTEGER PRIMARY KEY,
            username TEXT,
            first_name TEXT,
            age INTEGER,
            country TEXT,
            gender_pref TEXT,
            credits INTEGER DEFAULT 0,
            current_agent TEXT DEFAULT NULL,
            registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Create Transactions Table (Log)
    await db.exec(`
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action_type TEXT,
            cost INTEGER,
            agent_id TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);
    
    console.log('✅ Database connected and ready.');
}

initDb();

// ================= BOT INITIALIZATION =================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// 1. HANDLE /START (Launch App)
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    // Check if user exists, if not, create basic entry
    const user = await db.get('SELECT * FROM users WHERE user_id = ?', chatId);
    
    if (!user) {
        // We will fill details when they register in the App
        await db.run('INSERT OR IGNORE INTO users (user_id, credits) VALUES (?, 0)', chatId);
    }

    const welcomeMsg = `
🔥 **Welcome to Sync Hearts Agency**

Connect with elite companions in a private, secure environment.
💎 **Register now to get 50 FREE Coins.**

Click below to enter:
    `;

    await bot.sendMessage(chatId, welcomeMsg, {
        reply_markup: {
            inline_keyboard: [[
                { text: "💋 Enter Agency", web_app: { url: WEBAPP_URL } }
            ]]
        }
    });
});

// 2. RECEIVE DATA FROM MINI APP (app.js)
bot.on('message', async (msg) => {
    if (!msg.web_app_data) return;

    const chatId = msg.chat.id;
    const data = JSON.parse(msg.web_app_data.data);
    
    // CASE A: NEW USER REGISTRATION
    if (data.action === 'register_new_user') {
        const u = data.user_data;
        
        // Update DB with profile and give 50 Bonus Credits
        await db.run(`
            UPDATE users 
            SET username = ?, first_name = ?, age = ?, country = ?, gender_pref = ?, credits = ?
            WHERE user_id = ?
        `, [u.username, u.firstName, u.age, u.country, u.lookingFor, 50, chatId]);

        await bot.sendMessage(chatId, `✅ **Registration Complete!**\n\n💰 You received **50 Coins**.\n\nYou can now chat with our agents. Select one in the app!`);
        
        // Notify Admin
        bot.sendMessage(ADMIN_ID, `🔔 **New User Registered**\nName: ${u.firstName}\nAge: ${u.age}\nCountry: ${u.country}`);
    }

    // CASE B: INTERACTION (Gifts, Pics, Chats)
    if (data.action === 'interaction') {
        const cost = data.cost;
        const agentName = data.agent_name;
        const subType = data.sub_type;

        // 1. Verify Balance in DB (Security check)
        const user = await db.get('SELECT credits FROM users WHERE user_id = ?', chatId);
        
        if (!user || user.credits < cost) {
            return bot.sendMessage(chatId, `❌ **Transaction Failed**\nYou do not have enough credits on the server.`);
        }

        // 2. Deduct Credits
        await db.run('UPDATE users SET credits = credits - ? WHERE user_id = ?', [cost, chatId]);
        
        // 3. Set Current Agent (So future texts go to this agent context)
        await db.run('UPDATE users SET current_agent = ? WHERE user_id = ?', [agentName, chatId]);

        // 4. Log Transaction
        await db.run('INSERT INTO transactions (user_id, action_type, cost, agent_id) VALUES (?, ?, ?, ?)', 
            [chatId, subType, cost, data.agent_id]);

        // 5. Respond to User
        let replyText = "";
        if(subType === 'flower') replyText = `🌹 **Sent!** ${agentName} loved the flowers.`;
        if(subType === 'naughty') replyText = `😈 **Ooh...** ${agentName} blushed.`;
        if(subType === 'pic') replyText = `📸 **Request Sent.** ${agentName} is checking her camera roll...`;
        if(subType === 'video') replyText = `🎥 **Video Requested.** Please wait...`;
        if(subType === 'text') replyText = `💬 **Chat Open.** You can now type here to talk to ${agentName}. (1 coin per message)`;

        await bot.sendMessage(chatId, replyText);

        // 6. ALERT ADMIN (So you can reply)
        const adminAlert = `💰 **INCOME: ${cost} Coins**\nUser: ${msg.from.first_name}\nAction: ${subType}\nAgent: ${agentName}\n\nType a reply to send back.`;
        await bot.sendMessage(ADMIN_ID, adminAlert);
    }
    
    // CASE C: NAVIGATION REQUESTS
    if (data.action === 'open_wallet') {
        bot.sendMessage(chatId, "💎 **Coin Store**\n\nTo buy coins, please contact support or use /buy (Integration coming soon).");
    }
});

// 3. HANDLE TEXT CHAT (The Relay System)
bot.on('message', async (msg) => {
    // Ignore commands, web app data, or bot messages
    if (msg.text && !msg.text.startsWith('/') && !msg.web_app_data && !msg.from.is_bot && msg.chat.id !== ADMIN_ID) {
        const userId = msg.chat.id;

        // 1. Get User Data
        const user = await db.get('SELECT credits, current_agent, first_name FROM users WHERE user_id = ?', userId);

        if (!user) return; // Should allow /start
        if (!user.current_agent) {
            return bot.sendMessage(userId, "Please open the App and select an Agent to chat with first!");
        }

        // 2. Cost for Text (1 Coin)
        const COST_PER_MSG = 1;

        if (user.credits < COST_PER_MSG) {
            return bot.sendMessage(userId, "❌ **Out of Credits**\nYou need 1 coin to send a message. Please buy more.");
        }

        // 3. Deduct Credit
        await db.run('UPDATE users SET credits = credits - ? WHERE user_id = ?', [COST_PER_MSG, userId]);

        // 4. FORWARD TO ADMIN (Hidden Relay)
        // We format it so you know who it is and who they are talking to
        const forwardText = `📨 **Msg from ${user.first_name}**\nTo Agent: **${user.current_agent}**\nCredits Left: ${user.credits - 1}\n\n"${msg.text}"\n\n(Reply to this message to answer)`;
        
        // We send a message to Admin. We allow Admin to "Reply" to it.
        // We use force_reply to make it easy, or just tracking the ID.
        // Simple method: We append the UserID at the bottom invisible or just track it.
        // Better method: Send message, and when Admin replies to THAT message, we route it back.
        
        const sentMsg = await bot.sendMessage(ADMIN_ID, forwardText);
        // Save the mapping: AdminMessageID -> TargetUserID
        // For simplicity in this file, we assume you reply using the "Reply" feature in Telegram.
    }
});

// 4. ADMIN REPLIES (Sending messages back as the Agent)
bot.on('message', async (msg) => {
    if (msg.chat.id === ADMIN_ID && msg.reply_to_message) {
        
        // Parse the original message to find the User ID
        // The original message format was: "Msg from Name... \n... "
        // This is a simple parser. For production, store MessageIDs in DB.
        
        const originalText = msg.reply_to_message.text;
        
        // Attempt to extract User Name or ID context. 
        // NOTE: In a robust app, we store (AdminMsgId -> UserID) in a DB table.
        // Here is a simplified logic: The Admin manually types "/reply USERID Message" OR
        // we assume the "Last Active User". 
        
        // Let's implement a robust "Reply via ID" or simplistic "Reply to last".
        // To make this file copy-pasteable and simple, we will use a "Reply Command" or 
        // we can store the ID in the text message hidden? No.
        
        // **STRATEGY:** Since you are the only Admin, we will add the UserID to the forwarded message footer.
        // Admin: Replies to the bot message.
        
        // Let's look at the forwardText again: "Msg from User..."
        // We need the ID.
        
        // UPDATED FORWARDING LOGIC (Modify the function above mentally):
        // We will send the UserID in the message to Admin so we can parse it back.
    }
});

// FIXING THE ADMIN REPLY LOGIC (Overwrite the listeners above)
// We need a specific way to map replies.

bot.removeAllListeners('message'); // Clear previous to prevent duplicates in this explanation

// --- FINAL CONNECTED LOGIC ---

bot.on('message', async (msg) => {
    // 1. Web App Data
    if (msg.web_app_data) {
        const data = JSON.parse(msg.web_app_data.data);
        const chatId = msg.chat.id;

        if (data.action === 'register_new_user') {
            const u = data.user_data;
            await db.run(`INSERT OR REPLACE INTO users (user_id, username, first_name, age, country, gender_pref, credits) VALUES (?, ?, ?, ?, ?, ?, ?)`, 
                [chatId, u.username, u.firstName, u.age, u.country, u.lookingFor, 50]);
            await bot.sendMessage(chatId, `✅ **Registration Successful!** 50 Coins added.`);
            await bot.sendMessage(ADMIN_ID, `🆕 New User: ${u.firstName} (${u.country})`);
        }
        else if (data.action === 'interaction') {
            // Check credits
            const user = await db.get('SELECT credits FROM users WHERE user_id = ?', chatId);
            if (!user || user.credits < data.cost) {
                return bot.sendMessage(chatId, `❌ **Insufficient Funds** (Server).`);
            }
            // Deduct
            await db.run('UPDATE users SET credits = credits - ?, current_agent = ? WHERE user_id = ?', [data.cost, data.agent_name, chatId]);
            
            // Notify User
            let reply = `✅ **${data.sub_type.toUpperCase()} sent** to ${data.agent_name}. (-${data.cost} coins)`;
            if(data.sub_type === 'text') reply = `💬 **Connected to ${data.agent_name}.** Type your message now. (1 coin/msg)`;
            await bot.sendMessage(chatId, reply);

            // Notify Admin
            // Format: "ID: 12345 | Action: flower | Agent: Sophia"
            await bot.sendMessage(ADMIN_ID, `ID: ${chatId}\nUser: ${msg.from.first_name}\nAgent: ${data.agent_name}\nAction: ${data.sub_type}\nCost: ${data.cost}`);
        }
        return;
    }

    // 2. Admin Replies (You talking back)
    if (msg.chat.id === ADMIN_ID && msg.reply_to_message) {
        // We expect the original message to contain "ID: 12345" in the first line
        const lines = msg.reply_to_message.text.split('\n');
        const idLine = lines[0]; // "ID: 12345" or "Msg from..."
        
        let targetUserId = null;

        if (idLine.startsWith('ID: ')) {
            targetUserId = idLine.split(' ')[1];
        } else if (idLine.includes('Msg from')) {
             // Parse logic if we use the chat forward format
             // For safety, let's just use the ID format in forwards
        }

        if (targetUserId) {
            // Send YOUR text to the User
            await bot.sendMessage(targetUserId, msg.text);
            await bot.sendMessage(ADMIN_ID, `✅ Sent to ${targetUserId}`);
        } else {
            bot.sendMessage(ADMIN_ID, "⚠️ Could not find User ID in the message you replied to.");
        }
        return;
    }

    // 3. User Text Chat (Client talking to Agent)
    if (msg.chat.id !== ADMIN_ID && !msg.from.is_bot && msg.text && !msg.text.startsWith('/')) {
        const userId = msg.chat.id;
        const user = await db.get('SELECT credits, current_agent, first_name FROM users WHERE user_id = ?', userId);

        if (!user || user.credits < 1) {
            return bot.sendMessage(userId, "❌ **No Credits.** Please buy more to chat.");
        }

        if (!user.current_agent) {
             return bot.sendMessage(userId, "⚠️ Please open the App and select a companion first.");
        }

        // Deduct 1 coin
        await db.run('UPDATE users SET credits = credits - 1 WHERE user_id = ?', userId);

        // Forward to Admin in a format Admin can Reply to
        // "ID: 12345" must be on top for our Reply logic to work
        const adminMsg = `ID: ${userId}\nFrom: ${user.first_name}\nTo Agent: ${user.current_agent}\nCredits: ${user.credits - 1}\n\n${msg.text}`;
        
        await bot.sendMessage(ADMIN_ID, adminMsg);
    }
});

// ================= ADMIN COMMANDS =================
// Give credits manually: /add 123456789 100
bot.onText(/\/add (.+) (.+)/, async (msg, match) => {
    if (msg.chat.id !== ADMIN_ID) return;
    const targetId = match[1];
    const amount = parseInt(match[2]);
    
    await db.run('UPDATE users SET credits = credits + ? WHERE user_id = ?', [amount, targetId]);
    bot.sendMessage(ADMIN_ID, `✅ Added ${amount} coins to ${targetId}`);
    bot.sendMessage(targetId, `🎁 **Start Bonus!** Admin added ${amount} coins to your wallet.`);
});
