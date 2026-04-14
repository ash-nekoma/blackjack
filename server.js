require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(__dirname));

// --- MONGODB CONNECTION ---
mongoose.connect(process.env.MONGODB_URI).then(async () => {
    console.log('MongoDB Connected Successfully');
    
    // FIRST-TIME SETUP: Only creates these if the database is 100% empty.
    const adminConfig = await SystemConfig.findOne({ configName: 'admin_password' });
    if (!adminConfig) await new SystemConfig({ configName: 'admin_password', configValue: 'admin123' }).save();
    
    const modConfig = await SystemConfig.findOne({ configName: 'mod_password' });
    if (!modConfig) await new SystemConfig({ configName: 'mod_password', configValue: 'mod123' }).save();
    
    console.log('SYSTEM LOG: Security Credentials Initialized in Database.');
}).catch(err => console.error('MongoDB connection error:', err));

// --- DATABASE SCHEMAS ---
const SystemConfig = mongoose.model('SystemConfig', new mongoose.Schema({ configName: { type: String, unique: true }, configValue: { type: String } }));
const User = mongoose.model('User', new mongoose.Schema({
    username: { type: String, required: true, unique: true }, 
    password: { type: String, required: true },
    credits: { type: Number, default: 0 }, 
    status: { type: String, default: 'active' }, 
    nameColor: { type: String, default: '#f8fafc' }, 
    ipAddress: String, 
    tosAccepted: Boolean,
    lastRewardClaim: { type: Date, default: null }, 
    createdAt: { type: Date, default: Date.now }
}));

const Transaction = mongoose.model('Transaction', new mongoose.Schema({
    username: String, type: String, amount: Number, 
    status: { type: String, default: 'completed' }, date: { type: Date, default: Date.now }
}));

const GiftCode = mongoose.model('GiftCode', new mongoose.Schema({ 
    code: { type: String, unique: true }, amount: Number, usesLeft: Number,
    batchName: String, claimedBy: { type: String, default: null }, claimDate: { type: Date, default: null }
}));

// --- GAME LOGIC GLOBALS ---
const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades']; 
const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const rooms = { '3seat': createRoom(3), '5seat': createRoom(5) };

function createRoom(numSeats) {
    return {
        seats: Array(numSeats).fill(null), dealerCards: [], deck: [], 
        status: 'waiting', activeSeatIndex: -1, betEndTime: 0, nextRoundTime: 0, turnEndTime: 0,
        lobby: [], betTimerInterval: null, nextRoundInterval: null, turnTimerInterval: null, dealerInterval: null
    };
}

const diceGame = { status: 'betting', betEndTime: Date.now() + 15000, dice: [1, 1], bets: [], history: [] };
const coinGame = { status: 'betting', betEndTime: Date.now() + 15000, result: 'heads', bets: [], history: [] };
const PERYA_COLORS = ['red', 'blue', 'yellow', 'green', 'pink', 'white'];
const colorGame = { status: 'betting', betEndTime: Date.now() + 15000, dice: ['red', 'blue', 'yellow'], bets: [], history: [] };

const socketUserMap = {}; let diceLobby = []; let coinLobby = []; let colorLobby = [];
let strictHouseEdge = false; 
let gameLocks = { blackjack: false, dice: false, coin: false, color: false };

// --- ADMIN LOGGER ---
function getPHTTime() { return new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Manila' }); }
function adminLog(action) { io.to('admin_room').emit('admin_log', `▶ [${getPHTTime()}] ${action}`); }

// --- GAME LOOPS ---
setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(roomId => {
        let room = rooms[roomId]; let changed = false;
        room.seats.forEach((seat, i) => { 
            if (seat && seat.kickAt && now >= seat.kickAt) { room.seats[i] = null; changed = true; } 
        });
        if (changed) { 
            if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } 
            emitGameState(roomId); 
        }
    });
}, 1000);

setInterval(() => {
    const now = Date.now();
    
    // DICE LOOP
    if (diceGame.status === 'betting' && now >= diceGame.betEndTime) {
        diceGame.status = 'rolling'; 
        io.to('arcade_dice').emit('dice_state_update', { status: diceGame.status, timeLeft: 0, history: diceGame.history });
        
        setTimeout(async () => {
            let totalUnder = 0; let totalOver = 0;
            diceGame.bets.forEach(b => { if(b.choice==='under') totalUnder+=b.amount; if(b.choice==='over') totalOver+=b.amount; });
            
            let d1 = Math.floor(Math.random() * 6) + 1; let d2 = Math.floor(Math.random() * 6) + 1;
            if (strictHouseEdge && (totalUnder > 0 || totalOver > 0)) {
                if (totalUnder > totalOver && (d1+d2) < 7) { d1=4; d2=4; } 
                else if (totalOver > totalUnder && (d1+d2) > 7) { d1=2; d2=2; } 
            }
            
            diceGame.dice = [d1, d2]; const total = d1 + d2;
            diceGame.status = 'resolving'; diceGame.history.unshift(diceGame.dice); if(diceGame.history.length > 20) diceGame.history.pop();
            
            let winners = [];
            for (let b of diceGame.bets) {
                let won = false; let payout = 0;
                if (b.choice === 'under' && total < 7) { won = true; payout = b.amount * 2; }
                if (b.choice === 'over' && total > 7) { won = true; payout = b.amount * 2; }
                if (b.choice === 'seven' && total === 7) { won = true; payout = b.amount * 5; }
                if (won) {
                    const updatedUser = await User.findOneAndUpdate({ username: b.username }, { $inc: { credits: payout } }, {new: true}); 
                    await new Transaction({ username: b.username, type: 'HIGH-LOW DICE WIN', amount: payout }).save();
                    winners.push({ username: b.username, choice: b.choice, amount: payout });
                    io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits });
                }
            }
            io.to('arcade_dice').emit('dice_state_update', { status: diceGame.status, dice: diceGame.dice, total, winners, bets: diceGame.bets, history: diceGame.history });
            setTimeout(() => { diceGame.bets = []; diceGame.status = 'betting'; diceGame.betEndTime = Date.now() + 15000; io.to('arcade_dice').emit('dice_state_update', { status: diceGame.status, betEndTime: diceGame.betEndTime, history: diceGame.history }); }, 5000);
        }, 3000); 
    }

    // COIN LOOP
    if (coinGame.status === 'betting' && now >= coinGame.betEndTime) {
        coinGame.status = 'flipping'; 
        io.to('arcade_coin').emit('coin_state_update', { status: coinGame.status, timeLeft: 0, history: coinGame.history });
        
        setTimeout(async () => {
            let totalHeads = 0; let totalTails = 0;
            coinGame.bets.forEach(b => { if(b.choice==='heads') totalHeads+=b.amount; if(b.choice==='tails') totalTails+=b.amount; });
            
            let res = Math.random() < 0.5 ? 'heads' : 'tails';
            if (strictHouseEdge && (totalHeads > 0 || totalTails > 0)) { res = totalHeads > totalTails ? 'tails' : 'heads'; }

            coinGame.result = res; coinGame.status = 'resolving'; coinGame.history.unshift(coinGame.result); if(coinGame.history.length > 20) coinGame.history.pop();
            
            let winners = [];
            for (let b of coinGame.bets) {
                if (b.choice === coinGame.result) {
                    const payout = b.amount * 2;
                    const updatedUser = await User.findOneAndUpdate({ username: b.username }, { $inc: { credits: payout } }, {new: true}); 
                    await new Transaction({ username: b.username, type: 'COIN FLIP WIN', amount: payout }).save();
                    winners.push({ username: b.username, choice: b.choice, amount: payout });
                    io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits });
                }
            }
            io.to('arcade_coin').emit('coin_state_update', { status: coinGame.status, result: coinGame.result, winners, bets: coinGame.bets, history: coinGame.history });
            setTimeout(() => { coinGame.bets = []; coinGame.status = 'betting'; coinGame.betEndTime = Date.now() + 15000; io.to('arcade_coin').emit('coin_state_update', { status: coinGame.status, betEndTime: coinGame.betEndTime, history: coinGame.history }); }, 5000);
        }, 3000); 
    }

    // COLOR GAME LOOP
    if (colorGame.status === 'betting' && now >= colorGame.betEndTime) {
        colorGame.status = 'rolling'; 
        io.to('arcade_color').emit('color_state_update', { status: colorGame.status, timeLeft: 0, history: colorGame.history });
        
        setTimeout(async () => {
            colorGame.dice = [PERYA_COLORS[Math.floor(Math.random() * 6)], PERYA_COLORS[Math.floor(Math.random() * 6)], PERYA_COLORS[Math.floor(Math.random() * 6)]];
            colorGame.status = 'resolving'; colorGame.history.unshift(colorGame.dice); if(colorGame.history.length > 20) colorGame.history.pop();
            
            let winners = [];
            for (let b of colorGame.bets) {
                let matches = colorGame.dice.filter(c => c === b.choice).length;
                if (matches > 0) {
                    const payout = b.amount + (b.amount * matches);
                    const updatedUser = await User.findOneAndUpdate({ username: b.username }, { $inc: { credits: payout } }, {new: true}); 
                    await new Transaction({ username: b.username, type: 'COLOR GAME WIN', amount: payout }).save();
                    winners.push({ username: b.username, choice: b.choice, amount: payout });
                    io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits });
                }
            }
            io.to('arcade_color').emit('color_state_update', { status: colorGame.status, dice: colorGame.dice, winners, bets: colorGame.bets, history: colorGame.history });
            setTimeout(() => { colorGame.bets = []; colorGame.status = 'betting'; colorGame.betEndTime = Date.now() + 15000; io.to('arcade_color').emit('color_state_update', { status: colorGame.status, betEndTime: colorGame.betEndTime, history: colorGame.history }); }, 5000);
        }, 3000); 
    }
}, 1000);

function getNewDeck() { let deck = []; for (let i = 0; i < 6; i++) { for (let s of suits) { for (let v of values) { deck.push({ suit: s, value: v, weight: ['J','Q','K'].includes(v) ? 10 : (v==='A'?11:parseInt(v)) }); } } } return deck.sort(() => Math.random() - 0.5); }
function calculateValue(cards) { let val = 0; let aces = 0; cards.forEach(c => { val += c.weight; if(c.value==='A') aces++; }); while(val > 21 && aces > 0) { val -= 10; aces--; } return val; }

function emitGameState(roomId) {
    let room = rooms[roomId]; if (!room) return;
    const { betTimerInterval, nextRoundInterval, turnTimerInterval, dealerInterval, ...serializableRoom } = room;
    let safeState = JSON.parse(JSON.stringify(serializableRoom)); const now = Date.now();
    safeState.seats.forEach(s => { if (s && s.kickAt) s.kickTimeLeft = Math.max(0, s.kickAt - now); });
    if (safeState.betEndTime) safeState.betTimeLeft = Math.max(0, safeState.betEndTime - now);
    if (safeState.nextRoundTime) safeState.nextRoundTimeLeft = Math.max(0, safeState.nextRoundTime - now);
    if (safeState.turnEndTime) safeState.turnTimeLeft = Math.max(0, safeState.turnEndTime - now);
    if (safeState.status === 'playing' && safeState.dealerCards.length > 1) safeState.dealerCards[1] = { hidden: true };
    io.to(roomId).emit('game_state_update', safeState);
}

function startTurnTimer(roomId) {
    let room = rooms[roomId]; clearInterval(room.turnTimerInterval);
    room.turnTimerInterval = setInterval(() => { if (Date.now() >= room.turnEndTime) { clearInterval(room.turnTimerInterval); let seat = room.seats[room.activeSeatIndex]; if (seat && seat.hands[seat.currentHand]) seat.hands[seat.currentHand].status = 'stand'; moveToNextTurn(roomId); } }, 500);
}
function getGameTitle(roomId) { return roomId === '3seat' ? '3-SEAT BLACKJACK' : '5-SEAT BLACKJACK'; }

// --- ADMIN SECURITY & ECONOMY APIs ---
const checkAdminRole = async (req, res, next) => {
    try {
        const pass = req.headers['x-admin-pass'];
        const aConf = await SystemConfig.findOne({ configName: 'admin_password' });
        const mConf = await SystemConfig.findOne({ configName: 'mod_password' });
        
        if (pass === aConf.configValue) { req.role = 'admin'; next(); }
        else if (pass === mConf.configValue) { req.role = 'mod'; next(); }
        else { return res.status(403).json({ error: 'Unauthorized' }); }
    } catch (error) { res.status(500).json({ error: 'Database Error' }); }
};

app.post('/api/admin/login', async (req, res) => {
    const aConf = await SystemConfig.findOne({ configName: 'admin_password' });
    const mConf = await SystemConfig.findOne({ configName: 'mod_password' });
    
    if (req.body.password === aConf.configValue) {
        adminLog("MASTER ADMIN successfully logged in.");
        res.json({ success: true, role: 'admin' });
    } else if (req.body.password === mConf.configValue) {
        adminLog("MODERATOR successfully logged in.");
        res.json({ success: true, role: 'mod' });
    } else { res.status(401).json({ error: 'Invalid password.' }); }
});

app.post('/api/admin/change_password', checkAdminRole, async (req, res) => {
    if (req.role !== 'admin') return res.status(403).json({error: 'Forbidden'});
    const { targetRole, newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) return res.status(400).json({error: 'Password too short.'});
    
    const configName = targetRole === 'admin' ? 'admin_password' : 'mod_password';
    await SystemConfig.updateOne({ configName }, { configValue: newPassword });
    adminLog(`MASTER ADMIN changed the ${targetRole.toUpperCase()} password in the database.`);
    res.json({ success: true });
});

app.get('/api/admin/economy', checkAdminRole, async (req, res) => {
    const users = await User.find({}, '-password');
    const txs = await Transaction.find();
    const codes = await GiftCode.find();

    let deposits = 0; let withdrawals = 0; let promoIssued = 0; let totalBets = 0; let totalWins = 0; let circulating = 0;

    users.forEach(u => circulating += u.credits);
    txs.forEach(t => {
        if(t.status === 'completed') {
            if(t.type === 'BANK DEPOSIT') deposits += t.amount;
            if(t.type === 'BANK WITHDRAWAL') withdrawals += t.amount;
            if(['DAILY REWARD', 'GIFT CODE'].includes(t.type)) promoIssued += t.amount;
            if(t.type.includes('WIN') || (t.amount > 0 && !t.type.includes('BANK') && !['DAILY REWARD', 'GIFT CODE'].includes(t.type))) totalWins += t.amount;
        }
        if(t.amount < 0 && !t.type.includes('BANK')) totalBets += Math.abs(t.amount);
    });

    const vault = 1500000 + deposits - withdrawals;
    const ggr = totalBets - totalWins;
    const onlineUsers = [...new Set(Object.values(socketUserMap).map(u => u.username))];

    res.json({ 
        users, codes, 
        bankRequests: txs.filter(t=>t.status==='pending'), 
        economy: { baseVault: 1500000, deposits, withdrawals, vault, ggr, totalBets, totalWins, promoIssued, circulating }, 
        strictHouseEdge, onlineUsers, gameLocks
    });
});

app.post('/api/admin/user/status', checkAdminRole, async (req, res) => { 
    await User.updateOne({ username: req.body.username }, { status: req.body.status }); 
    adminLog(`Changed status of player ${req.body.username} to ${req.body.status.toUpperCase()}`);
    res.json({ success: true }); 
});

app.post('/api/admin/settings', checkAdminRole, async (req, res) => {
    if(req.role !== 'admin') return res.status(403).json({error: 'Forbidden'});
    strictHouseEdge = req.body.strictHouseEdge;
    adminLog(`House Edge RTP modifier set to: ${strictHouseEdge ? 'ON' : 'OFF'}`);
    res.json({ success: true });
});

app.post('/api/admin/tx/resolve', checkAdminRole, async (req, res) => {
    if(req.role !== 'admin') return res.status(403).json({error: 'Forbidden'});
    const { id, action } = req.body; 
    const tx = await Transaction.findById(id); 
    if (!tx || tx.status !== 'pending') return res.status(400).json({ error: 'Invalid TX' });
    
    let updatedUser;
    if (action === 'approve') { 
        tx.status = 'completed'; 
        if (tx.type === 'BANK DEPOSIT') { updatedUser = await User.findOneAndUpdate({ username: tx.username }, { $inc: { credits: tx.amount } }, { new: true }); } 
    } else { 
        tx.status = 'denied'; 
        if (tx.type === 'BANK WITHDRAWAL') { updatedUser = await User.findOneAndUpdate({ username: tx.username }, { $inc: { credits: tx.amount } }, { new: true }); } 
    }
    await tx.save(); 
    adminLog(`Admin ${action.toUpperCase()}ED bank request for ${tx.username} (${tx.amount} credits)`);
    if(updatedUser) io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); 
    res.json({ success: true });
});

app.post('/api/admin/giftcode', checkAdminRole, async (req, res) => { 
    if(req.role !== 'admin') return res.status(403).json({error: 'Forbidden'});
    const { batchName, amount, quantity } = req.body;
    for(let i=0; i<quantity; i++) {
        let code = Math.random().toString(36).substring(2, 8).toUpperCase();
        await new GiftCode({ code, amount, usesLeft: 1, batchName }).save();
    }
    adminLog(`Generated ${quantity} gift codes for batch: ${batchName}`);
    res.json({ success: true }); 
});

app.get('/api/admin/player_full/:username', checkAdminRole, async (req, res) => {
    const user = await User.findOne({ username: req.params.username }, '-password');
    const txs = await Transaction.find({ username: req.params.username }).sort({ date: -1 });
    res.json({ user, txs });
});

// --- PLAYER APIs ---
app.post('/api/signup', async (req, res) => { 
    try { 
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        await new User({ username: req.body.username, password: req.body.password, ipAddress: ip, tosAccepted: true, status: 'active' }).save(); 
        adminLog(`New account created: ${req.body.username} (IP: ${ip})`);
        res.status(201).json({ message: 'Account requested successfully.' }); 
    } catch (err) { res.status(400).json({ error: 'Username taken.' }); } 
});

app.post('/api/login', async (req, res) => {
    const user = await User.findOne({ username: req.body.username, password: req.body.password });
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' }); 
    if (user.status === 'banned') return res.status(401).json({ error: 'Account banned by administration.' });
    
    // Auto-active on login if not banned
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    user.ipAddress = ip; 
    if(user.status !== 'active') user.status = 'active';
    await user.save();
    
    adminLog(`${user.username} logged in.`);
    
    const now = new Date(); const lastClaim = user.lastRewardClaim ? new Date(user.lastRewardClaim) : new Date(0); 
    const msLeft = new Date(lastClaim.getTime() + 24 * 60 * 60 * 1000).getTime() - now.getTime();
    res.json({ username: user.username, credits: user.credits, status: user.status, createdAt: user.createdAt, cooldownSeconds: msLeft > 0 ? Math.floor(msLeft / 1000) : 0 });
});

app.post('/api/bank/request', async (req, res) => {
    const { username, type, amount } = req.body; let txType = type === 'deposit' ? 'BANK DEPOSIT' : 'BANK WITHDRAWAL'; let currentCredits = undefined;
    if (type === 'deposit') { if (amount < 10000 || amount > 100000) return res.status(400).json({ error: 'Limits: 10k - 100k.' }); } 
    else if (type === 'withdrawal') {
        if (amount < 50000 || amount > 100000) return res.status(400).json({ error: 'Limits: 50k - 100k.' });
        const user = await User.findOneAndUpdate({ username, credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
        if (!user) return res.status(400).json({ error: 'Insufficient funds.' }); currentCredits = user.credits;
    }
    adminLog(`Bank request submitted: ${username} requested ${txType} of ${amount}.`);
    await new Transaction({ username, type: txType, amount, status: 'pending' }).save(); res.json({ success: true, newCredits: currentCredits });
});

app.post('/api/bank/giftcode', async (req, res) => {
    const { username, code } = req.body; 
    const gc = await GiftCode.findOneAndUpdate({ code, usesLeft: { $gt: 0 } }, { $set: { usesLeft: 0, claimedBy: username, claimDate: new Date() } });
    if (!gc) return res.status(400).json({ error: 'Invalid or expired code.' });
    
    adminLog(`Gift code ${code} redeemed by ${username} for ${gc.amount} credits.`);
    await User.updateOne({ username }, { $inc: { credits: gc.amount } }); 
    await new Transaction({ username, type: 'GIFT CODE', amount: gc.amount, status: 'completed' }).save();
    res.json({ success: true, amount: gc.amount });
});

app.get('/api/profile/ledger/:username', async (req, res) => { const txs = await Transaction.find({ username: req.params.username }).sort({ date: -1 }).limit(50); res.json(txs); });

// --- SOCKET SYSTEM ---
io.on('connection', (socket) => {
    
    // ADMIN EYE IN THE SKY & CONTROLS
    socket.on('admin_join', () => { socket.join('admin_room'); socket.emit('game_lock_state', gameLocks); });
    
    socket.on('admin_action', ({ action, room, username, game, locked }) => {
        if(action === 'wipe_chat') {
            io.emit('chat_wiped', { room });
        } else if (action === 'kick_user') {
            const targetSocket = Object.keys(socketUserMap).find(id => socketUserMap[id].username === username);
            if(targetSocket) { io.to(targetSocket).emit('force_disconnect'); io.sockets.sockets.get(targetSocket)?.disconnect(); }
        } else if (action === 'toggle_game') {
            gameLocks[game] = locked;
            io.emit('game_lock_state', gameLocks);
            adminLog(`System Override: ${game.toUpperCase()} is now ${locked ? 'LOCKED' : 'UNLOCKED'}`);
        }
    });

    socket.on('admin_notify', ({ target, username, message }) => {
        adminLog(`Notification Sent to [${target.toUpperCase()}]: ${message}`);
        io.emit('system_notification', { target, username, message });
    });

    // ARCADE LOBBIES
    socket.on('enter_arcade', async ({ username, game }) => {
        const user = await User.findOne({ username }); if (!user) return;
        socket.join('arcade_' + game); socketUserMap[socket.id] = { username, arcadeGame: game, roomId: game };
        let lobby = game === 'dice' ? diceLobby : (game === 'color' ? colorLobby : coinLobby);
        if (!lobby.find(p => p.username === username)) lobby.push({ username, color: user.nameColor });
        io.to('arcade_' + game).emit('arcade_lobby_update', { game, lobby });
        adminLog(`[SPECTATOR] ${username} entered the ${game.toUpperCase()} room.`);
    });

    socket.on('leave_arcade', ({ username, game }) => {
        socket.leave('arcade_' + game);
        let lobby = game === 'dice' ? diceLobby : (game === 'color' ? colorLobby : coinLobby);
        lobby = lobby.filter(p => p.username !== username);
        if(game === 'dice') diceLobby = lobby; else if (game === 'color') colorLobby = lobby; else coinLobby = lobby;
        if(socketUserMap[socket.id]) { delete socketUserMap[socket.id].arcadeGame; delete socketUserMap[socket.id].roomId; }
        io.to('arcade_' + game).emit('arcade_lobby_update', { game, lobby });
        adminLog(`[SPECTATOR] ${username} left the ${game.toUpperCase()} room.`);
    });

    socket.on('send_chat', ({ roomId, username, message }) => { 
        if(roomId && username && message) {
            adminLog(`[CHAT] (${roomId}) ${username}: ${message}`); 
            if (['dice', 'coin', 'color'].includes(roomId)) io.to('arcade_' + roomId).emit('receive_chat', { roomId, username, message });
            else io.to(roomId).emit('receive_chat', { roomId, username, message }); 
        }
    });

    // --- ARCADE BETS ---
    socket.on('get_dice_state', () => { socket.emit('dice_state_update', { status: diceGame.status, betEndTime: diceGame.betEndTime, history: diceGame.history }); });
    socket.on('place_dice_bet', async ({ username, choice, amount }) => {
        if(gameLocks.dice) return socket.emit('arcade_error', 'Game is currently offline for maintenance.');
        if (diceGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are currently closed!');
        if (amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');
        let existingBet = diceGame.bets.filter(b=>b.username===username && b.choice===choice).reduce((sum,b)=>sum+b.amount,0);
        if(existingBet + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');

        const user = await User.findOneAndUpdate({ username, credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
        if (!user) return socket.emit('arcade_error', 'Insufficient credits');
        
        await new Transaction({ username, type: 'HIGH-LOW DICE', amount: -amount }).save();
        diceGame.bets.push({ username, choice, amount }); 
        adminLog(`[BET] ${username} bet ${amount} on DICE (${choice})`);
        io.emit('credit_update', { username: user.username, credits: user.credits }); 
        socket.emit('arcade_bet_placed', { game: 'dice', credits: user.credits, choice, totalChoiceBet: existingBet + amount });
    });

    socket.on('get_coin_state', () => { socket.emit('coin_state_update', { status: coinGame.status, betEndTime: coinGame.betEndTime, history: coinGame.history }); });
    socket.on('place_coin_bet', async ({ username, choice, amount }) => {
        if(gameLocks.coin) return socket.emit('arcade_error', 'Game is currently offline for maintenance.');
        if (coinGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are currently closed!');
        if (amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');
        let existingBet = coinGame.bets.filter(b=>b.username===username && b.choice===choice).reduce((sum,b)=>sum+b.amount,0);
        if(existingBet + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');

        const user = await User.findOneAndUpdate({ username, credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
        if (!user) return socket.emit('arcade_error', 'Insufficient credits');
        
        await new Transaction({ username, type: 'COIN FLIP', amount: -amount }).save();
        coinGame.bets.push({ username, choice, amount }); 
        adminLog(`[BET] ${username} bet ${amount} on COIN (${choice})`);
        io.emit('credit_update', { username: user.username, credits: user.credits });
        socket.emit('arcade_bet_placed', { game: 'coin', credits: user.credits, choice, totalChoiceBet: existingBet + amount });
    });

    socket.on('get_color_state', () => { socket.emit('color_state_update', { status: colorGame.status, betEndTime: colorGame.betEndTime, history: colorGame.history }); });
    socket.on('place_color_bet', async ({ username, choice, amount }) => {
        if(gameLocks.color) return socket.emit('arcade_error', 'Game is currently offline for maintenance.');
        if (colorGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are currently closed!');
        if (amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per color!');
        let existingBet = colorGame.bets.filter(b=>b.username===username && b.choice===choice).reduce((sum,b)=>sum+b.amount,0);
        if(existingBet + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per color!');

        const user = await User.findOneAndUpdate({ username, credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
        if (!user) return socket.emit('arcade_error', 'Insufficient credits');
        
        await new Transaction({ username, type: 'COLOR GAME', amount: -amount }).save();
        colorGame.bets.push({ username, choice, amount }); 
        adminLog(`[BET] ${username} bet ${amount} on COLOR (${choice})`);
        io.emit('credit_update', { username: user.username, credits: user.credits }); 
        socket.emit('arcade_bet_placed', { game: 'color', credits: user.credits, choice, totalChoiceBet: existingBet + amount });
    });

    // --- BLACKJACK SOCKETS ---
    socket.on('enter_room', async ({ username, roomId }) => {
        if (!rooms[roomId]) return; socket.join(roomId); socketUserMap[socket.id] = { username, roomId };
        const user = await User.findOne({ username }); 
        if (user && !rooms[roomId].lobby.find(p => p.username === username)) { rooms[roomId].lobby.push({ username: user.username, color: user.nameColor }); }
        adminLog(`[SPECTATOR] ${username} entered ${getGameTitle(roomId)}.`);
        emitGameState(roomId);
    });

    socket.on('leave_room', ({ username, roomId }) => {
        let room = rooms[roomId]; if (!room) return; socket.leave(roomId); room.lobby = room.lobby.filter(p => p.username !== username);
        const seatIndex = room.seats.findIndex(s => s && s.username === username);
        if (seatIndex !== -1) { room.seats[seatIndex] = null; if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } }
        if(socketUserMap[socket.id]) delete socketUserMap[socket.id]; 
        adminLog(`[SPECTATOR] ${username} left ${getGameTitle(roomId)}.`);
        emitGameState(roomId);
    });

    socket.on('join_seat', async ({ roomId, username, seatIndex }) => {
        let room = rooms[roomId]; if (!room || room.seats.some(s => s && s.username === username) || seatIndex < 0 || seatIndex >= room.seats.length || room.seats[seatIndex]) return;
        const user = await User.findOne({ username }); if (!user) return;
        room.seats[seatIndex] = { username: user.username, color: user.nameColor, socketId: socket.id, credits: user.credits, hands: [{ cards: [], bet: 0, status: 'waiting', value: 0 }], currentHand: 0, kickAt: Date.now() + 7000 };
        if (room.status === 'waiting') room.status = 'betting'; 
        adminLog(`[TABLE] ${username} sat down at ${getGameTitle(roomId)}.`);
        emitGameState(roomId);
    });

    socket.on('leave_seat', ({ roomId, username, seatIndex }) => {
        let room = rooms[roomId]; if (!room) return;
        if (room.seats[seatIndex] && room.seats[seatIndex].username === username) { room.seats[seatIndex] = null; if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } emitGameState(roomId); }
    });

    socket.on('place_bet', async ({ roomId, username, seatIndex, betAmount }) => {
        if(gameLocks[roomId]) return socket.emit('arcade_error', 'Table is currently offline for maintenance.');
        let room = rooms[roomId]; if (!room) return; const seat = room.seats[seatIndex]; if (!seat || seat.username !== username || room.status !== 'betting') return;
        if (betAmount >= 1000 && betAmount <= 50000) {
            const updatedUser = await User.findOneAndUpdate({ username: seat.username, credits: { $gte: betAmount } }, { $inc: { credits: -betAmount } }, { new: true });
            if (!updatedUser) return; 
            
            seat.credits = updatedUser.credits; seat.hands[0].bet = betAmount; seat.kickAt = null; 
            await new Transaction({ username: seat.username, type: getGameTitle(roomId), amount: -betAmount }).save();
            adminLog(`[BET] ${username} bet ${betAmount} at ${getGameTitle(roomId)}.`);
            
            io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); 
            room.betEndTime = Date.now() + 15000; clearInterval(room.betTimerInterval);
            
            if (room.seats.every(s => s !== null && s.hands[0].bet > 0)) { clearInterval(room.betTimerInterval); startGame(roomId); } 
            else { room.betTimerInterval = setInterval(() => { if (Date.now() >= room.betEndTime) { clearInterval(room.betTimerInterval); startGame(roomId); } }, 1000); emitGameState(roomId); }
        }
    });

    socket.on('player_action_hit', ({ roomId, username, seatIndex }) => { let room = rooms[roomId]; if (!room || room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return; const seat = room.seats[seatIndex]; const hand = seat.hands[seat.currentHand]; if (seat.username !== username || hand.status !== 'waiting') return; hand.cards.push(room.deck.pop()); hand.value = calculateValue(hand.cards); if (hand.value > 21) { hand.status = 'bust'; hand.result = 'bust'; moveToNextTurn(roomId); } else if (hand.value === 21) { hand.status = 'stand'; moveToNextTurn(roomId); } else { room.turnEndTime = Date.now() + 15000; startTurnTimer(roomId); emitGameState(roomId); } });
    socket.on('player_action_stand', ({ roomId, username, seatIndex }) => { let room = rooms[roomId]; if (!room || room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return; const seat = room.seats[seatIndex]; const hand = seat.hands[seat.currentHand]; if (seat.username !== username || hand.status !== 'waiting') return; hand.status = 'stand'; moveToNextTurn(roomId); });
    socket.on('player_action_double', async ({ roomId, username, seatIndex }) => { let room = rooms[roomId]; if (!room || room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return; const seat = room.seats[seatIndex]; const hand = seat.hands[seat.currentHand]; if (seat.username !== username || hand.status !== 'waiting' || hand.cards.length !== 2) return; const updatedUser = await User.findOneAndUpdate({ username: seat.username, credits: { $gte: hand.bet } }, { $inc: { credits: -hand.bet } }, { new: true }); if (!updatedUser) return; seat.credits = updatedUser.credits; await new Transaction({ username: seat.username, type: getGameTitle(roomId), amount: -hand.bet }).save(); io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); hand.bet *= 2; hand.cards.push(room.deck.pop()); hand.value = calculateValue(hand.cards); if (hand.value > 21) { hand.status = 'bust'; hand.result = 'bust'; } else { hand.status = 'stand'; } moveToNextTurn(roomId); });
    socket.on('player_action_split', async ({ roomId, username, seatIndex }) => { let room = rooms[roomId]; if (!room || room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return; const seat = room.seats[seatIndex]; if (seat.username !== username || seat.hands.length >= 2) return; const hand = seat.hands[seat.currentHand]; if (hand.status !== 'waiting' || hand.cards.length !== 2) return; if (hand.cards[0].weight === hand.cards[1].weight) { const updatedUser = await User.findOneAndUpdate({ username: seat.username, credits: { $gte: hand.bet } }, { $inc: { credits: -hand.bet } }, { new: true }); if (!updatedUser) return; seat.credits = updatedUser.credits; await new Transaction({ username: seat.username, type: getGameTitle(roomId), amount: -hand.bet }).save(); io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); const splitCard = hand.cards.pop(); const newHand = { cards: [splitCard], bet: hand.bet, status: 'waiting', value: 0 }; hand.cards.push(room.deck.pop()); newHand.cards.push(room.deck.pop()); hand.value = calculateValue(hand.cards); newHand.value = calculateValue(newHand.cards); if(hand.value === 21) hand.status = 'stand'; if(newHand.value === 21) newHand.status = 'stand'; seat.hands.push(newHand); if(hand.status === 'stand') moveToNextTurn(roomId); else { room.turnEndTime = Date.now() + 15000; startTurnTimer(roomId); emitGameState(roomId); } } });

    socket.on('claim_daily_reward_box', async ({ username, boxIndex }) => {
        try {
            const user = await User.findOne({ username }); if (!user) return; const now = new Date(); const lastClaim = user.lastRewardClaim ? new Date(user.lastRewardClaim) : new Date(0); const msIn24Hours = 24 * 60 * 60 * 1000;
            if (now.getTime() - lastClaim.getTime() >= msIn24Hours) {
                let prizes = [1000, 0, 0, 0, 5000, 10000]; prizes = prizes.sort(() => Math.random() - 0.5); const wonAmount = prizes[boxIndex]; user.lastRewardClaim = now;
                if (wonAmount > 0) { user.credits += wonAmount; await new Transaction({ username, type: 'DAILY REWARD', amount: wonAmount, status: 'completed' }).save(); adminLog(`${username} claimed ${wonAmount} Daily Reward.`); } await user.save();
                const msLeft = new Date(now.getTime() + msIn24Hours).getTime() - now.getTime(); const cooldownSeconds = Math.floor(msLeft / 1000);
                socket.emit('reward_box_opened', { success: true, wonAmount, allPrizes: prizes, credits: user.credits, cooldownSeconds });
                io.emit('credit_update', { username: user.username, credits: user.credits }); 
                Object.keys(rooms).forEach(rId => { const seat = rooms[rId].seats.find(s => s && s.username === username); if(seat) { seat.credits = user.credits; emitGameState(rId); } });
            } else { socket.emit('reward_box_opened', { success: false, message: 'Cooldown active' }); }
        } catch (e) { socket.emit('reward_box_opened', { success: false, message: 'Server sync error' }); }
    });

    socket.on('disconnect', () => {
        const data = socketUserMap[socket.id];
        if (data) {
            if (data.arcadeGame) {
                let g = data.arcadeGame; let lobby = g === 'dice' ? diceLobby : (g === 'color' ? colorLobby : coinLobby);
                lobby = lobby.filter(p => p.username !== data.username);
                if(g === 'dice') diceLobby = lobby; else if(g === 'color') colorLobby = lobby; else coinLobby = lobby;
                io.to('arcade_' + g).emit('arcade_lobby_update', { game: g, lobby });
            }
            if (data.roomId && rooms[data.roomId]) {
                let room = rooms[data.roomId]; room.lobby = room.lobby.filter(p => p.username !== data.username);
                const seatIndex = room.seats.findIndex(s => s && s.username === data.username);
                if (seatIndex !== -1) { room.seats[seatIndex] = null; if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } }
                emitGameState(data.roomId);
            }
            delete socketUserMap[socket.id];
        }
    });
});

// --- BLACKJACK RESOLUTION LOGIC ---
function startGame(roomId) {
    let room = rooms[roomId]; if (!room) return; room.status = 'playing'; room.deck = getNewDeck(); room.dealerCards = []; room.seats = room.seats.map(s => (s && s.hands[0].bet === 0) ? null : s);
    for (let i = 0; i < 2; i++) { room.seats.forEach(seat => { if (seat) seat.hands[0].cards.push(room.deck.pop()); }); room.dealerCards.push(room.deck.pop()); }
    room.seats.forEach(seat => { if (seat) { seat.hands[0].value = calculateValue(seat.hands[0].cards); if(seat.hands[0].value === 21) { seat.hands[0].status = 'blackjack'; } }});
    let dealerInitialValue = calculateValue(room.dealerCards); if (dealerInitialValue === 21) { room.dealerCards[1].hidden = false; resolveBets(roomId, 21); return; }
    room.activeSeatIndex = room.seats.findIndex(s => s && s.hands[0].status === 'waiting');
    if (room.activeSeatIndex === -1) { processDealerTurn(roomId); } else { room.turnEndTime = Date.now() + 15000; startTurnTimer(roomId); emitGameState(roomId); }
}
function moveToNextTurn(roomId) {
    let room = rooms[roomId]; if (!room) return; clearInterval(room.turnTimerInterval);  const seat = room.seats[room.activeSeatIndex];
    if (seat && seat.currentHand < seat.hands.length - 1) { seat.currentHand++; if (seat.hands[seat.currentHand].status !== 'waiting') return moveToNextTurn(roomId); room.turnEndTime = Date.now() + 15000; startTurnTimer(roomId); emitGameState(roomId); return; }
    let nextIndex = room.activeSeatIndex + 1; while (nextIndex < room.seats.length) { if (room.seats[nextIndex] && room.seats[nextIndex].hands[0].status === 'waiting') break; nextIndex++; }
    if (nextIndex >= room.seats.length) { processDealerTurn(roomId); } else { room.activeSeatIndex = nextIndex; room.turnEndTime = Date.now() + 15000; startTurnTimer(roomId); emitGameState(roomId); }
}
async function processDealerTurn(roomId) {
    let room = rooms[roomId]; if (!room) return; room.status = 'dealerTurn'; room.activeSeatIndex = -1; clearInterval(room.turnTimerInterval);
    if(room.dealerCards.length > 1) room.dealerCards[1].hidden = false; emitGameState(roomId);
    setTimeout(() => {
        let dealerValue = calculateValue(room.dealerCards); if (dealerValue >= 17) { resolveBets(roomId, dealerValue); return; }
        room.dealerInterval = setInterval(() => { if (dealerValue < 17) { room.dealerCards.push(room.deck.pop()); dealerValue = calculateValue(room.dealerCards); emitGameState(roomId); } else { clearInterval(room.dealerInterval); resolveBets(roomId, dealerValue); } }, 1000);
    }, 1500); 
}
async function resolveBets(roomId, dealerValue) {
    let room = rooms[roomId]; if (!room) return; room.status = 'resolving'; room.nextRoundTime = Date.now() + 5000; 
    for (const seat of room.seats) {
        if (seat) {
            for (const hand of seat.hands) {
                if (hand.bet > 0) {
                    let payout = 0;
                    if (hand.status === 'blackjack' && dealerValue !== 21) { payout = hand.bet * 2.5; hand.result = 'win-bj'; } 
                    else if (hand.status !== 'bust' && (dealerValue > 21 || hand.value > dealerValue)) { payout = hand.bet * 2; hand.result = 'win'; } 
                    else if (hand.status !== 'bust' && hand.value === dealerValue) { payout = hand.bet; hand.result = 'push'; } 
                    else if (hand.status === 'bust') { hand.result = 'bust'; } 
                    else { hand.result = 'lose'; }
                    if (payout > 0) { seat.credits += payout; const updatedUser = await User.findOneAndUpdate({ username: seat.username }, { $inc: { credits: payout } }, {new: true}); await new Transaction({ username: seat.username, type: getGameTitle(roomId)+" WIN", amount: payout }).save(); io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); }
                }
            }
        }
    }
    emitGameState(roomId); clearInterval(room.nextRoundInterval);
    room.nextRoundInterval = setInterval(() => {
        if (Date.now() >= room.nextRoundTime) {
            clearInterval(room.nextRoundInterval); room.dealerCards = [];
            room.seats.forEach(seat => { if(seat) { seat.hands = [{ cards: [], bet: 0, status: 'waiting', value: 0 }]; seat.currentHand = 0; seat.kickAt = Date.now() + 7000; } });
            const anyoneSeated = room.seats.some(s => s !== null); room.status = anyoneSeated ? 'betting' : 'waiting'; emitGameState(roomId);
        }
    }, 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino Server Live on ${PORT}`));
