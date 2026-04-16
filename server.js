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
    try {
        const adminConfig = await SystemConfig.findOne({ configName: 'admin_password' });
        if (!adminConfig) await new SystemConfig({ configName: 'admin_password', configValue: 'admin123' }).save();
        
        const modConfig = await SystemConfig.findOne({ configName: 'mod_password' });
        if (!modConfig) await new SystemConfig({ configName: 'mod_password', configValue: 'mod123' }).save();
        
        console.log('SYSTEM LOG: Security Credentials Initialized.');
    } catch(e) {
        console.error("DB Initialization Error:", e);
    }
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

const Ticket = mongoose.model('Ticket', new mongoose.Schema({
    username: String, 
    target: String, 
    type: String, 
    subject: String,
    messages: [{ sender: String, text: String, date: { type: Date, default: Date.now } }],
    status: { type: String, default: 'open' },
    unreadPlayer: { type: Boolean, default: true },
    unreadAdmin: { type: Boolean, default: false },
    readBy: { type: [String], default: [] },
    updatedAt: { type: Date, default: Date.now }
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

// THE NEW DERBY GLOBALS
const derbyGame = { status: 'betting', betEndTime: Date.now() + 15000, distances: [0,0,0,0,0,0], bets: [], history: [] };
const DERBY_MULT = [2, 3, 3, 5, 7, 10];
const DERBY_SPD = [2.0, 1.4, 1.4, 1.0, 0.7, 0.4];

const PERYA_COLORS = ['red', 'blue', 'yellow', 'green', 'pink', 'white'];
const colorGame = { status: 'betting', betEndTime: Date.now() + 15000, dice: ['red', 'blue', 'yellow'], bets: [], history: [] };

// --- COIN DUEL GLOBALS ---
let coinDuel = {
    seats: [null, null], // { username, color, score, choice, ready }
    status: 'waiting', // waiting, readying, flipping, resolved
    format: 1, // 1, 3, 5
    betAmount: 0,
    hostIndex: -1,
    result: null,
    message: 'WAITING FOR CHALLENGER',
    flipInterval: null
};

const socketUserMap = {}; let diceLobby = []; let derbyLobby = []; let colorLobby = [];
let strictHouseEdge = false; 
let gameLocks = { blackjack: false, dice: false, derby: false, color: false };

// --- ADMIN LOGGER ---
function getPHTTime() { 
    try { return new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Manila' }); } 
    catch(e) { return new Date().toLocaleTimeString(); } 
}
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
                    try {
                        const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + b.username + '$', 'i') }, { $inc: { credits: payout } }, {new: true}); 
                        if(updatedUser) {
                            await new Transaction({ username: updatedUser.username, type: 'HIGH-LOW DICE WIN', amount: payout }).save();
                            winners.push({ username: updatedUser.username, choice: b.choice, amount: payout });
                            io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits });
                        }
                    } catch(e) {}
                }
            }
            io.to('arcade_dice').emit('dice_state_update', { status: diceGame.status, dice: diceGame.dice, total, winners, bets: diceGame.bets, history: diceGame.history });
            setTimeout(() => { diceGame.bets = []; diceGame.status = 'betting'; diceGame.betEndTime = Date.now() + 15000; io.to('arcade_dice').emit('dice_state_update', { status: diceGame.status, betEndTime: diceGame.betEndTime, history: diceGame.history }); }, 5000);
        }, 3000); 
    }

    // NEW DERBY LOOP
    if (derbyGame.status === 'betting' && now >= derbyGame.betEndTime) {
        derbyGame.status = 'racing'; 
        derbyGame.distances = [0,0,0,0,0,0];
        io.to('arcade_derby').emit('derby_state_update', { status: derbyGame.status, timeLeft: 0, distances: derbyGame.distances, history: derbyGame.history });
        
        let raceInterval = setInterval(async () => {
            let finished = false;
            let winnerIndex = -1;

            let laneBets = [0,0,0,0,0,0];
            derbyGame.bets.forEach(b => laneBets[b.choice] += b.amount);

            for(let i=0; i<6; i++) {
                let speedMod = 1;
                // House Edge: Slightly slow down heavy-bet lanes to protect vault
                if(strictHouseEdge && laneBets[i] > 0) speedMod = 0.75; 
                
                // Add randomness plus a base speed weight
                derbyGame.distances[i] += Math.random() * DERBY_SPD[i] * speedMod * 4; 
                if (derbyGame.distances[i] >= 100) {
                    derbyGame.distances[i] = 100;
                    if(!finished) { finished = true; winnerIndex = i; }
                }
            }

            io.to('arcade_derby').emit('derby_race_tick', { distances: derbyGame.distances });

            if (finished) {
                clearInterval(raceInterval);
                derbyGame.status = 'resolving';
                derbyGame.history.unshift(winnerIndex);
                if(derbyGame.history.length > 20) derbyGame.history.pop();

                let winners = [];
                for (let b of derbyGame.bets) {
                    if (b.choice === winnerIndex) {
                        const payout = b.amount * DERBY_MULT[winnerIndex];
                        try {
                            const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + b.username + '$', 'i') }, { $inc: { credits: payout } }, {new: true}); 
                            if(updatedUser) {
                                await new Transaction({ username: updatedUser.username, type: 'DERBY WIN', amount: payout }).save();
                                winners.push({ username: updatedUser.username, choice: b.choice, amount: payout });
                                io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits });
                            }
                        } catch(e) {}
                    }
                }
                io.to('arcade_derby').emit('derby_state_update', { status: derbyGame.status, winner: winnerIndex, winners, bets: derbyGame.bets, history: derbyGame.history, distances: derbyGame.distances });
                
                setTimeout(() => { 
                    derbyGame.bets = []; 
                    derbyGame.status = 'betting'; 
                    derbyGame.distances = [0,0,0,0,0,0];
                    derbyGame.betEndTime = Date.now() + 15000; 
                    io.to('arcade_derby').emit('derby_state_update', { status: derbyGame.status, betEndTime: derbyGame.betEndTime, history: derbyGame.history, distances: derbyGame.distances }); 
                }, 5000);
            }
        }, 150); // Engine ticks fast to give chunky pixel movement
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
                    try {
                        const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + b.username + '$', 'i') }, { $inc: { credits: payout } }, {new: true}); 
                        if(updatedUser) {
                            await new Transaction({ username: updatedUser.username, type: 'COLOR GAME WIN', amount: payout }).save();
                            winners.push({ username: updatedUser.username, choice: b.choice, amount: payout });
                            io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits });
                        }
                    } catch(e) {}
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
        
        if (aConf && pass === aConf.configValue) { req.role = 'admin'; next(); }
        else if (mConf && pass === mConf.configValue) { req.role = 'mod'; next(); }
        else { return res.status(403).json({ error: 'Unauthorized' }); }
    } catch (error) { res.status(500).json({ error: 'Database Error' }); }
};

app.post('/api/admin/login', async (req, res) => {
    try {
        const aConf = await SystemConfig.findOne({ configName: 'admin_password' });
        const mConf = await SystemConfig.findOne({ configName: 'mod_password' });
        
        if (aConf && req.body.password === aConf.configValue) {
            adminLog("MASTER ADMIN successfully logged in.");
            res.json({ success: true, role: 'admin' });
        } else if (mConf && req.body.password === mConf.configValue) {
            adminLog("MODERATOR successfully logged in.");
            res.json({ success: true, role: 'mod' });
        } else { res.status(401).json({ error: 'Invalid password.' }); }
    } catch(e) { res.status(500).json({ error: 'Database loading, please try again.' }); }
});

app.post('/api/admin/change_password', checkAdminRole, async (req, res) => {
    try {
        if (req.role !== 'admin') return res.status(403).json({error: 'Forbidden'});
        const { targetRole, newPassword } = req.body;
        if (!newPassword || newPassword.length < 4) return res.status(400).json({error: 'Password too short.'});
        
        const configName = targetRole === 'admin' ? 'admin_password' : 'mod_password';
        await SystemConfig.updateOne({ configName }, { configValue: newPassword });
        adminLog(`MASTER ADMIN changed the ${targetRole.toUpperCase()} password.`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server Error' }); }
});

app.get('/api/admin/economy', checkAdminRole, async (req, res) => {
    try {
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
    } catch (e) { res.status(500).json({ error: 'Data Fetch Error' }); }
});

app.post('/api/admin/user/status', checkAdminRole, async (req, res) => { 
    try {
        await User.updateOne({ username: new RegExp('^' + req.body.username + '$', 'i') }, { status: req.body.status }); 
        adminLog(`Changed status of player ${req.body.username} to ${req.body.status.toUpperCase()}`);
        res.json({ success: true }); 
    } catch (e) { res.status(500).json({ error: 'Server Error' }); }
});

app.post('/api/admin/settings', checkAdminRole, async (req, res) => {
    try {
        if(req.role !== 'admin') return res.status(403).json({error: 'Forbidden'});
        strictHouseEdge = req.body.strictHouseEdge;
        adminLog(`House Edge RTP modifier set to: ${strictHouseEdge ? 'ON' : 'OFF'}`);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server Error' }); }
});

app.post('/api/admin/tx/resolve', checkAdminRole, async (req, res) => {
    try {
        if(req.role !== 'admin') return res.status(403).json({error: 'Forbidden'});
        const { id, action } = req.body; 
        const tx = await Transaction.findById(id); 
        if (!tx || tx.status !== 'pending') return res.status(400).json({ error: 'Invalid TX' });
        
        let updatedUser;
        if (action === 'approve') { 
            tx.status = 'completed'; 
            if (tx.type === 'BANK DEPOSIT') { updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + tx.username + '$', 'i') }, { $inc: { credits: tx.amount } }, { new: true }); } 
        } else { 
            tx.status = 'denied'; 
            if (tx.type === 'BANK WITHDRAWAL') { updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + tx.username + '$', 'i') }, { $inc: { credits: tx.amount } }, { new: true }); } 
        }
        await tx.save(); 
        adminLog(`Admin ${action.toUpperCase()}ED bank request for ${tx.username} (${tx.amount} credits)`);
        if(updatedUser) io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); 
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: 'Server Error' }); }
});

app.post('/api/admin/giftcode', checkAdminRole, async (req, res) => { 
    try {
        if(req.role !== 'admin') return res.status(403).json({error: 'Forbidden'});
        const { batchName, amount, quantity } = req.body;
        for(let i=0; i<quantity; i++) {
            let code = Math.random().toString(36).substring(2, 8).toUpperCase();
            await new GiftCode({ code, amount, usesLeft: 1, batchName }).save();
        }
        adminLog(`Generated ${quantity} gift codes for batch: ${batchName}`);
        res.json({ success: true }); 
    } catch (e) { res.status(500).json({ error: 'Server Error' }); }
});

app.get('/api/admin/player_full/:username', checkAdminRole, async (req, res) => {
    try {
        const user = await User.findOne({ username: new RegExp('^' + req.params.username + '$', 'i') }, '-password');
        const txs = await Transaction.find({ username: new RegExp('^' + req.params.username + '$', 'i') }).sort({ date: -1 });
        res.json({ user, txs });
    } catch (e) { res.status(500).json({ error: 'Server Error' }); }
});

// --- PLAYER APIs ---
app.post('/api/signup', async (req, res) => { 
    try { 
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        
        const existing = await User.findOne({ username: new RegExp('^' + req.body.username + '$', 'i') });
        if(existing) return res.status(400).json({ error: 'Username taken.' });

        await new User({ username: req.body.username, password: req.body.password, ipAddress: ip, tosAccepted: true, status: 'pending' }).save(); 
        adminLog(`New account requested: ${req.body.username} (IP: ${ip})`);
        res.status(201).json({ message: 'Account requested successfully.' }); 
    } catch (err) { res.status(400).json({ error: 'Username taken.' }); } 
});

app.post('/api/login', async (req, res) => {
    try {
        const user = await User.findOne({ username: new RegExp('^' + req.body.username + '$', 'i'), password: req.body.password });
        if (!user) return res.status(401).json({ error: 'Invalid credentials.' }); 
        if (user.status === 'pending') return res.status(401).json({ error: 'Account pending Admin approval.' });
        if (user.status === 'banned') return res.status(401).json({ error: 'Account banned by administration.' });
        
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        user.ipAddress = ip; 
        await user.save();
        
        adminLog(`${user.username} logged in.`);
        
        const now = new Date(); const lastClaim = user.lastRewardClaim ? new Date(user.lastRewardClaim) : new Date(0); 
        const msLeft = new Date(lastClaim.getTime() + 24 * 60 * 60 * 1000).getTime() - now.getTime();
        res.json({ username: user.username, credits: user.credits, status: user.status, createdAt: user.createdAt, cooldownSeconds: msLeft > 0 ? Math.floor(msLeft / 1000) : 0 });
    } catch(e) { res.status(500).json({ error: 'Server loading...' }); }
});

app.post('/api/bank/request', async (req, res) => {
    try {
        const { username, type, amount } = req.body; let txType = type === 'deposit' ? 'BANK DEPOSIT' : 'BANK WITHDRAWAL'; let currentCredits = undefined;
        if (type === 'deposit') { if (amount < 10000 || amount > 100000) return res.status(400).json({ error: 'Limits: 10k - 100k.' }); } 
        else if (type === 'withdrawal') {
            if (amount < 50000 || amount > 100000) return res.status(400).json({ error: 'Limits: 50k - 100k.' });
            const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i'), credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
            if (!user) return res.status(400).json({ error: 'Insufficient funds.' }); currentCredits = user.credits;
        }
        adminLog(`Bank request submitted: ${username} requested ${txType} of ${amount}.`);
        await new Transaction({ username, type: txType, amount, status: 'pending' }).save(); res.json({ success: true, newCredits: currentCredits });
    } catch(e) { res.status(500).json({ error: 'Server Error' }); }
});

app.post('/api/bank/giftcode', async (req, res) => {
    try {
        const { username, code } = req.body; 
        const gc = await GiftCode.findOneAndUpdate({ code, usesLeft: { $gt: 0 } }, { $set: { usesLeft: 0, claimedBy: username, claimDate: new Date() } });
        if (!gc) return res.status(400).json({ error: 'Invalid or expired code.' });
        
        adminLog(`Gift code ${code} redeemed by ${username} for ${gc.amount} credits.`);
        await User.updateOne({ username: new RegExp('^' + username + '$', 'i') }, { $inc: { credits: gc.amount } }); 
        await new Transaction({ username, type: 'GIFT CODE', amount: gc.amount, status: 'completed' }).save();
        res.json({ success: true, amount: gc.amount });
    } catch(e) { res.status(500).json({ error: 'Server Error' }); }
});

app.get('/api/profile/ledger/:username', async (req, res) => { 
    try {
        const txs = await Transaction.find({ username: new RegExp('^' + req.params.username + '$', 'i') }).sort({ date: -1 }).limit(50); res.json(txs); 
    } catch(e) { res.status(500).json({ error: 'Server Error' }); }
});

// --- SOCKET SYSTEM ---
io.on('connection', (socket) => {
    
    socket.on('admin_join', () => { socket.join('admin_room'); socket.emit('game_lock_state', gameLocks); });
    
    socket.on('admin_action', ({ action, room, username, game, locked }) => {
        try {
            if(action === 'wipe_chat') {
                io.emit('chat_wiped', { room });
            } else if (action === 'kick_user') {
                const targetSocket = Object.keys(socketUserMap).find(id => socketUserMap[id].username.toLowerCase() === username.toLowerCase());
                if(targetSocket) { io.to(targetSocket).emit('force_disconnect'); io.sockets.sockets.get(targetSocket)?.disconnect(); }
            } else if (action === 'toggle_game') {
                gameLocks[game] = locked;
                io.emit('game_lock_state', gameLocks);
                adminLog(`System Override: ${game ? game.toUpperCase() : 'GAME'} is now ${locked ? 'LOCKED' : 'UNLOCKED'}`);
            }
        } catch (e) {}
    });

    // --- NOTIFICATION / TICKET SYSTEM ---
    socket.on('req_inbox', async ({ username }) => {
        try {
            const tickets = await Ticket.find({ $or: [{ username: new RegExp('^' + username + '$', 'i') }, { username: 'GLOBAL' }] }).sort({ updatedAt: -1 });
            socket.emit('inbox_data', tickets);
        } catch(e){}
    });

    socket.on('read_ticket', async ({ id, username }) => {
        try { 
            const t = await Ticket.findById(id);
            if(t) {
                if(t.username === 'GLOBAL') {
                    if(!t.readBy.includes(username)) { t.readBy.push(username); await t.save(); }
                } else {
                    t.unreadPlayer = false; await t.save(); 
                }
            }
        } catch(e){}
    });

    socket.on('player_create_ticket', async ({ username, subject, text }) => {
        try {
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') });
            if(!user) return;
            const t = new Ticket({ username: user.username, target: 'specific', type: 'support', subject, messages: [{ sender: user.username, text }], unreadPlayer: false, unreadAdmin: true });
            await t.save();
            adminLog(`New support ticket from ${user.username}: ${subject}`);
            io.emit('admin_inbox_update');
            const tickets = await Ticket.find({ $or: [{ username: user.username }, { username: 'GLOBAL' }] }).sort({ updatedAt: -1 });
            socket.emit('inbox_data', tickets);
        } catch(e){}
    });

    socket.on('player_reply', async ({ id, username, text }) => {
        try {
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') });
            if(!user) return;
            const t = await Ticket.findById(id);
            if(t && t.status === 'open' && t.type !== 'announcement') {
                t.messages.push({ sender: user.username, text });
                t.unreadAdmin = true; t.updatedAt = Date.now();
                await t.save();
                socket.emit('ticket_updated', t);
                io.emit('admin_inbox_update'); 
            }
        } catch(e){}
    });

    socket.on('del_ticket', async ({ id, username }) => {
        try {
            const t = await Ticket.findById(id);
            if(t && t.username !== 'GLOBAL') {
                await Ticket.findByIdAndDelete(id);
            }
            const tickets = await Ticket.find({ $or: [{ username: new RegExp('^' + username + '$', 'i') }, { username: 'GLOBAL' }] }).sort({ updatedAt: -1 });
            socket.emit('inbox_data', tickets);
        } catch(e){}
    });

    // Admin Ticket Controls
    socket.on('req_admin_inbox', async () => {
        try {
            const tickets = await Ticket.find().sort({ updatedAt: -1 });
            socket.emit('admin_inbox_data', tickets);
        } catch(e){}
    });

    socket.on('admin_read_ticket', async ({ id }) => {
        try { await Ticket.findByIdAndUpdate(id, { unreadAdmin: false }); io.emit('admin_inbox_update'); } catch(e){}
    });

    socket.on('admin_reply', async ({ id, text }) => {
        try {
            const t = await Ticket.findById(id);
            if(t && t.status === 'open' && t.type !== 'announcement') {
                t.messages.push({ sender: 'ADMIN', text });
                t.unreadPlayer = true; t.updatedAt = Date.now();
                await t.save();
                io.emit('admin_inbox_update');
                io.emit('new_mail', { username: t.username });
            }
        } catch(e){}
    });

    socket.on('admin_close_ticket', async ({ id }) => {
        try {
            const t = await Ticket.findByIdAndUpdate(id, { status: 'closed' }, { new: true });
            if(t) {
                adminLog(`Closed conversation for ${t.username}`);
                io.emit('admin_inbox_update');
                io.emit('new_mail', { username: t.username }); 
            }
        } catch(e){}
    });

    socket.on('admin_notify', async ({ target, username, type, subject, message }) => {
        try {
            if (target === 'all') {
                if(type === 'announcement') {
                    const t = new Ticket({ username: 'GLOBAL', target, type, subject, messages: [{ sender: 'ADMIN', text: message }] });
                    await t.save();
                    adminLog(`Global Announcement Broadcasted: ${subject}`);
                    io.emit('system_notification', { target, type, subject, message });
                    io.emit('new_mail', { username: 'GLOBAL' });
                } else {
                    const allUsers = await User.find({});
                    for(let u of allUsers) {
                        await new Ticket({ username: u.username, target: 'specific', type, subject, messages: [{ sender: 'ADMIN', text: message }], unreadPlayer: true, unreadAdmin: false }).save();
                    }
                    adminLog(`Mass Message sent to ALL ${allUsers.length} players in the database.`);
                    io.emit('system_notification', { target, type, subject, message });
                    io.emit('new_mail', { target: 'all' });
                }
                io.emit('admin_inbox_update');
                
            } else if (target === 'active') {
                const onlineUsernames = [...new Set(Object.values(socketUserMap).map(u => u.username))];
                for(let u of onlineUsernames) {
                    await new Ticket({ username: u, target: 'specific', type, subject, messages: [{ sender: 'ADMIN', text: message }], unreadPlayer: true, unreadAdmin: false }).save();
                }
                adminLog(`Broadcast sent to ${onlineUsernames.length} Active Players: ${onlineUsernames.join(', ')}`);
                io.emit('system_notification', { target, type, subject, message });
                io.emit('new_mail', { target: 'active' });
                io.emit('admin_inbox_update');
                
            } else if (target === 'specific_online' || target === 'specific_all') {
                const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') });
                if(user) {
                    const t = new Ticket({ username: user.username, target: 'specific', type, subject, messages: [{ sender: 'ADMIN', text: message }], unreadPlayer: true, unreadAdmin: false });
                    await t.save();
                    adminLog(`Sent direct ${type} to ${user.username}: ${subject}`);
                    io.emit('new_mail', { username: user.username }); 
                    io.emit('admin_inbox_update');
                }
            }
        } catch(e){}
    });

    // ARCADE LOBBIES
    socket.on('enter_arcade', async ({ username, game }) => {
        try {
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); if (!user) return;
            socket.join('arcade_' + game); socketUserMap[socket.id] = { username: user.username, arcadeGame: game, roomId: game };
            let lobby = game === 'dice' ? diceLobby : (game === 'color' ? colorLobby : derbyLobby);
            if (!lobby.find(p => p.username === user.username)) lobby.push({ username: user.username, color: user.nameColor });
            io.to('arcade_' + game).emit('arcade_lobby_update', { game, lobby });
            adminLog(`[SPECTATOR] ${user.username} entered the ${game ? game.toUpperCase() : 'ARCADE'} room.`);
            
            // Auto-emit coin duels if entering derby room (which shares UI with coin duel)
            if(game === 'derby') {
                socket.emit('coin_duel_state_update', coinDuel);
            }
        } catch(e) {}
    });

    socket.on('leave_arcade', ({ username, game }) => {
        socket.leave('arcade_' + game);
        const searchUser = new RegExp('^' + username + '$', 'i');
        let lobby = game === 'dice' ? diceLobby : (game === 'color' ? colorLobby : derbyLobby);
        lobby = lobby.filter(p => !searchUser.test(p.username));
        if(game === 'dice') diceLobby = lobby; else if (game === 'color') colorLobby = lobby; else derbyLobby = lobby;
        
        if(game === 'derby') {
            // Eject from duel room if seated
            const seatIdx = coinDuel.seats.findIndex(s => s && s.username.toLowerCase() === username.toLowerCase());
            if(seatIdx !== -1) handleCoinDuelLeave(seatIdx);
        }

        if(socketUserMap[socket.id]) { delete socketUserMap[socket.id].arcadeGame; delete socketUserMap[socket.id].roomId; }
        io.to('arcade_' + game).emit('arcade_lobby_update', { game, lobby });
        adminLog(`[SPECTATOR] ${username} left the ${game ? game.toUpperCase() : 'ARCADE'} room.`);
    });

    socket.on('send_chat', ({ roomId, username, message }) => { 
        if(roomId && username && message) {
            adminLog(`[CHAT] (${roomId}) ${username}: ${message}`); 
            if (['dice', 'derby', 'color'].includes(roomId)) io.to('arcade_' + roomId).emit('receive_chat', { roomId, username, message });
            else io.to(roomId).emit('receive_chat', { roomId, username, message }); 
        }
    });

    // --- ARCADE BETS (DICE, COLOR) ---
    socket.on('get_dice_state', () => { socket.emit('dice_state_update', { status: diceGame.status, betEndTime: diceGame.betEndTime, history: diceGame.history }); });
    socket.on('place_dice_bet', async ({ username, choice, amount }) => {
        try {
            if(gameLocks.dice) return socket.emit('arcade_error', 'Game is currently offline for maintenance.');
            if (diceGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are currently closed!');
            if (amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');
            let existingBetAmt = diceGame.bets.filter(b=>b.username.toLowerCase()===username.toLowerCase() && b.choice===choice).reduce((sum,b)=>sum+b.amount,0);
            if(existingBetAmt + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');

            const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i'), credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
            if (!user) return socket.emit('arcade_error', 'Insufficient credits');
            
            await new Transaction({ username: user.username, type: 'HIGH-LOW DICE', amount: -amount }).save();
            
            let existingBetObj = diceGame.bets.find(b => b.username.toLowerCase() === user.username.toLowerCase() && b.choice === choice);
            if (existingBetObj) existingBetObj.amount += amount;
            else diceGame.bets.push({ username: user.username, choice, amount }); 
            
            adminLog(`[BET] ${user.username} bet ${amount} on DICE (${choice})`);
            io.emit('credit_update', { username: user.username, credits: user.credits }); 
            socket.emit('arcade_bet_placed', { game: 'dice', credits: user.credits, choice, totalChoiceBet: existingBetAmt + amount });
        } catch(e) { socket.emit('arcade_error', 'Server sync error.'); }
    });

    // --- NEW DERBY LOGIC ---
    socket.on('get_derby_state', () => { socket.emit('derby_state_update', { status: derbyGame.status, betEndTime: derbyGame.betEndTime, distances: derbyGame.distances, history: derbyGame.history }); });
    socket.on('place_derby_bet', async ({ username, choice, amount }) => {
        try {
            if(gameLocks.derby) return socket.emit('arcade_error', 'Game is currently offline for maintenance.');
            if (derbyGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are currently closed!');
            if (amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per lane!');
            
            let choiceIdx = parseInt(choice);
            let existingBetAmt = derbyGame.bets.filter(b=>b.username.toLowerCase()===username.toLowerCase() && b.choice===choiceIdx).reduce((sum,b)=>sum+b.amount,0);
            if(existingBetAmt + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per lane!');

            const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i'), credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
            if (!user) return socket.emit('arcade_error', 'Insufficient credits');
            
            await new Transaction({ username: user.username, type: '8-BIT DERBY', amount: -amount }).save();
            
            let existingBetObj = derbyGame.bets.find(b => b.username.toLowerCase() === user.username.toLowerCase() && b.choice === choiceIdx);
            if (existingBetObj) existingBetObj.amount += amount;
            else derbyGame.bets.push({ username: user.username, choice: choiceIdx, amount }); 
            
            adminLog(`[BET] ${user.username} bet ${amount} on DERBY LANE ${choiceIdx + 1}`);
            io.emit('credit_update', { username: user.username, credits: user.credits });
            socket.emit('arcade_bet_placed', { game: 'derby', credits: user.credits, choice: choiceIdx, totalChoiceBet: existingBetAmt + amount });
        } catch(e) { socket.emit('arcade_error', 'Server sync error.'); }
    });

    socket.on('get_color_state', () => { socket.emit('color_state_update', { status: colorGame.status, betEndTime: colorGame.betEndTime, history: colorGame.history }); });
    socket.on('place_color_bet', async ({ username, choice, amount }) => {
        try {
            if(gameLocks.color) return socket.emit('arcade_error', 'Game is currently offline for maintenance.');
            if (colorGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are currently closed!');
            if (amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per color!');
            let existingBetAmt = colorGame.bets.filter(b=>b.username.toLowerCase()===username.toLowerCase() && b.choice===choice).reduce((sum,b)=>sum+b.amount,0);
            if(existingBetAmt + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per color!');

            const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i'), credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
            if (!user) return socket.emit('arcade_error', 'Insufficient credits');
            
            await new Transaction({ username: user.username, type: 'COLOR GAME', amount: -amount }).save();
            
            let existingBetObj = colorGame.bets.find(b => b.username.toLowerCase() === user.username.toLowerCase() && b.choice === choice);
            if (existingBetObj) existingBetObj.amount += amount;
            else colorGame.bets.push({ username: user.username, choice, amount }); 
            
            adminLog(`[BET] ${user.username} bet ${amount} on COLOR (${choice})`);
            io.emit('credit_update', { username: user.username, credits: user.credits }); 
            socket.emit('arcade_bet_placed', { game: 'color', credits: user.credits, choice, totalChoiceBet: existingBetAmt + amount });
        } catch(e) { socket.emit('arcade_error', 'Server sync error.'); }
    });

    // --- COIN DUEL PVP ROOM ---
    socket.on('join_coin_duel_seat', async ({ username, seatIndex }) => {
        try {
            if(seatIndex < 0 || seatIndex > 1) return;
            if(coinDuel.seats.some(s => s && s.username.toLowerCase() === username.toLowerCase())) return socket.emit('arcade_error', 'You are already seated.');
            if(coinDuel.seats[seatIndex]) return socket.emit('arcade_error', 'Seat taken.');
            
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') });
            if(!user) return;

            coinDuel.seats[seatIndex] = { username: user.username, color: user.nameColor, score: 0, choice: 'heads', ready: false };
            
            if(coinDuel.hostIndex === -1) {
                coinDuel.hostIndex = seatIndex;
                coinDuel.message = 'HOST CONFIGURING MATCH';
            } else {
                coinDuel.message = 'WAITING FOR READY';
                const hostChoice = coinDuel.seats[coinDuel.hostIndex].choice;
                coinDuel.seats[seatIndex].choice = hostChoice === 'heads' ? 'tails' : 'heads';
            }
            
            adminLog(`[DUEL] ${user.username} sat at duel seat ${seatIndex+1}`);
            io.to('arcade_derby').emit('coin_duel_state_update', coinDuel);
        } catch(e) {}
    });

    socket.on('leave_coin_duel_seat', ({ username, seatIndex }) => {
        const seat = coinDuel.seats[seatIndex];
        if (seat && seat.username.toLowerCase() === username.toLowerCase()) {
            handleCoinDuelLeave(seatIndex);
        }
    });

    socket.on('update_coin_duel_settings', async ({ username, format, betAmount, choice }) => {
        const seatIndex = coinDuel.seats.findIndex(s => s && s.username.toLowerCase() === username.toLowerCase());
        if(seatIndex === -1 || seatIndex !== coinDuel.hostIndex || coinDuel.status !== 'waiting') return;
        
        if(betAmount < 0 || betAmount > 100000) return socket.emit('arcade_error', 'Invalid bet limits (0-100k).');
        if(![1, 3, 5].includes(format)) return;

        const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') });
        if (!user || user.credits < betAmount) {
            return socket.emit('arcade_error', 'You have insufficient credits to wager this amount.');
        }

        coinDuel.format = format;
        coinDuel.betAmount = betAmount;
        coinDuel.seats[seatIndex].choice = choice;
        
        const otherIndex = seatIndex === 0 ? 1 : 0;
        if(coinDuel.seats[otherIndex]) {
            coinDuel.seats[otherIndex].choice = choice === 'heads' ? 'tails' : 'heads';
            coinDuel.seats[otherIndex].ready = false; 
        }
        
        io.to('arcade_derby').emit('coin_duel_state_update', coinDuel);
    });

    socket.on('ready_coin_duel', async ({ username }) => {
        const seatIndex = coinDuel.seats.findIndex(s => s && s.username.toLowerCase() === username.toLowerCase());
        if(seatIndex === -1 || coinDuel.status !== 'waiting') return;

        coinDuel.seats[seatIndex].ready = !coinDuel.seats[seatIndex].ready;
        io.to('arcade_derby').emit('coin_duel_state_update', coinDuel);

        if(coinDuel.seats[0] && coinDuel.seats[0].ready && coinDuel.seats[1] && coinDuel.seats[1].ready) {
            coinDuel.status = 'readying';
            coinDuel.message = 'LOCKING IN BETS...';
            io.to('arcade_derby').emit('coin_duel_state_update', coinDuel);

            if(coinDuel.betAmount > 0) {
                const u1 = await User.findOne({ username: new RegExp('^' + coinDuel.seats[0].username + '$', 'i') });
                const u2 = await User.findOne({ username: new RegExp('^' + coinDuel.seats[1].username + '$', 'i') });

                if(!u1 || u1.credits < coinDuel.betAmount) {
                    coinDuel.message = `${coinDuel.seats[0].username.toUpperCase()} HAS INSUFFICIENT CREDITS.`;
                    coinDuel.status = 'waiting'; coinDuel.seats[0].ready = false; coinDuel.seats[1].ready = false;
                    return io.to('arcade_derby').emit('coin_duel_state_update', coinDuel);
                }
                if(!u2 || u2.credits < coinDuel.betAmount) {
                    coinDuel.message = `${coinDuel.seats[1].username.toUpperCase()} HAS INSUFFICIENT CREDITS.`;
                    coinDuel.status = 'waiting'; coinDuel.seats[0].ready = false; coinDuel.seats[1].ready = false;
                    return io.to('arcade_derby').emit('coin_duel_state_update', coinDuel);
                }

                await User.updateOne({ username: u1.username }, { $inc: { credits: -coinDuel.betAmount } });
                await User.updateOne({ username: u2.username }, { $inc: { credits: -coinDuel.betAmount } });
                await new Transaction({ username: u1.username, type: 'DUEL ROOM BET', amount: -coinDuel.betAmount }).save();
                await new Transaction({ username: u2.username, type: 'DUEL ROOM BET', amount: -coinDuel.betAmount }).save();
                io.emit('credit_update', { username: u1.username, credits: u1.credits - coinDuel.betAmount });
                io.emit('credit_update', { username: u2.username, credits: u2.credits - coinDuel.betAmount });
                adminLog(`[DUEL] ${u1.username} vs ${u2.username} match started. Pot: ${coinDuel.betAmount * 2}`);
            }

            coinDuel.status = 'flipping';
            runDuelFlipSequence();
        }
    });

    // --- BLACKJACK SOCKETS ---
    socket.on('enter_room', async ({ username, roomId }) => {
        try {
            if (!rooms[roomId]) return; socket.join(roomId); 
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); 
            if (user) {
                socketUserMap[socket.id] = { username: user.username, roomId };
                if(!rooms[roomId].lobby.find(p => p.username === user.username)) { rooms[roomId].lobby.push({ username: user.username, color: user.nameColor }); }
                adminLog(`[SPECTATOR] ${user.username} entered ${getGameTitle(roomId)}.`);
            }
            emitGameState(roomId);
        } catch(e) {}
    });

    socket.on('leave_room', ({ username, roomId }) => {
        let room = rooms[roomId]; if (!room) return; socket.leave(roomId); room.lobby = room.lobby.filter(p => p.username.toLowerCase() !== username.toLowerCase());
        const seatIndex = room.seats.findIndex(s => s && s.username.toLowerCase() === username.toLowerCase());
        if (seatIndex !== -1) { room.seats[seatIndex] = null; if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } }
        if(socketUserMap[socket.id]) delete socketUserMap[socket.id]; 
        adminLog(`[SPECTATOR] ${username} left ${getGameTitle(roomId)}.`);
        emitGameState(roomId);
    });

    socket.on('join_seat', async ({ roomId, username, seatIndex }) => {
        try {
            let room = rooms[roomId]; if (!room || room.seats.some(s => s && s.username.toLowerCase() === username.toLowerCase()) || seatIndex < 0 || seatIndex >= room.seats.length || room.seats[seatIndex]) return;
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); if (!user) return;
            room.seats[seatIndex] = { username: user.username, color: user.nameColor, socketId: socket.id, credits: user.credits, hands: [{ cards: [], bet: 0, status: 'waiting', value: 0 }], currentHand: 0, kickAt: Date.now() + 7000 };
            if (room.status === 'waiting') room.status = 'betting'; 
            adminLog(`[TABLE] ${user.username} sat down at ${getGameTitle(roomId)}.`);
            emitGameState(roomId);
        } catch(e) {}
    });

    socket.on('leave_seat', ({ roomId, username, seatIndex }) => {
        let room = rooms[roomId]; if (!room) return;
        if (room.seats[seatIndex] && room.seats[seatIndex].username.toLowerCase() === username.toLowerCase()) { room.seats[seatIndex] = null; if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } emitGameState(roomId); }
    });

    socket.on('place_bet', async ({ roomId, username, seatIndex, betAmount }) => {
        try {
            if(gameLocks[roomId]) return socket.emit('arcade_error', 'Table is currently offline for maintenance.');
            let room = rooms[roomId]; if (!room) return; const seat = room.seats[seatIndex]; if (!seat || seat.username.toLowerCase() !== username.toLowerCase() || room.status !== 'betting') return;
            if (betAmount >= 1000 && betAmount <= 50000) {
                const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + seat.username + '$', 'i'), credits: { $gte: betAmount } }, { $inc: { credits: -betAmount } }, { new: true });
                if (!updatedUser) return; 
                
                seat.credits = updatedUser.credits; seat.hands[0].bet = betAmount; seat.kickAt = null; 
                await new Transaction({ username: updatedUser.username, type: getGameTitle(roomId), amount: -betAmount }).save();
                adminLog(`[BET] ${updatedUser.username} bet ${betAmount} at ${getGameTitle(roomId)}.`);
                
                io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); 
                room.betEndTime = Date.now() + 15000; clearInterval(room.betTimerInterval);
                
                if (room.seats.every(s => s !== null && s.hands[0].bet > 0)) { clearInterval(room.betTimerInterval); startGame(roomId); } 
                else { room.betTimerInterval = setInterval(() => { if (Date.now() >= room.betEndTime) { clearInterval(room.betTimerInterval); startGame(roomId); } }, 1000); emitGameState(roomId); }
            }
        } catch(e) {}
    });

    socket.on('player_action_hit', ({ roomId, username, seatIndex }) => { let room = rooms[roomId]; if (!room || room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return; const seat = room.seats[seatIndex]; const hand = seat.hands[seat.currentHand]; if (seat.username.toLowerCase() !== username.toLowerCase() || hand.status !== 'waiting') return; hand.cards.push(room.deck.pop()); hand.value = calculateValue(hand.cards); if (hand.value > 21) { hand.status = 'bust'; hand.result = 'bust'; moveToNextTurn(roomId); } else if (hand.value === 21) { hand.status = 'stand'; moveToNextTurn(roomId); } else { room.turnEndTime = Date.now() + 15000; startTurnTimer(roomId); emitGameState(roomId); } });
    socket.on('player_action_stand', ({ roomId, username, seatIndex }) => { let room = rooms[roomId]; if (!room || room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return; const seat = room.seats[seatIndex]; const hand = seat.hands[seat.currentHand]; if (seat.username.toLowerCase() !== username.toLowerCase() || hand.status !== 'waiting') return; hand.status = 'stand'; moveToNextTurn(roomId); });
    socket.on('player_action_double', async ({ roomId, username, seatIndex }) => { try { let room = rooms[roomId]; if (!room || room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return; const seat = room.seats[seatIndex]; const hand = seat.hands[seat.currentHand]; if (seat.username.toLowerCase() !== username.toLowerCase() || hand.status !== 'waiting' || hand.cards.length !== 2) return; const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + seat.username + '$', 'i'), credits: { $gte: hand.bet } }, { $inc: { credits: -hand.bet } }, { new: true }); if (!updatedUser) return; seat.credits = updatedUser.credits; await new Transaction({ username: updatedUser.username, type: getGameTitle(roomId), amount: -hand.bet }).save(); io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); hand.bet *= 2; hand.cards.push(room.deck.pop()); hand.value = calculateValue(hand.cards); if (hand.value > 21) { hand.status = 'bust'; hand.result = 'bust'; } else { hand.status = 'stand'; } moveToNextTurn(roomId); } catch(e){} });
    socket.on('player_action_split', async ({ roomId, username, seatIndex }) => { try { let room = rooms[roomId]; if (!room || room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return; const seat = room.seats[seatIndex]; if (seat.username.toLowerCase() !== username.toLowerCase() || seat.hands.length >= 2) return; const hand = seat.hands[seat.currentHand]; if (hand.status !== 'waiting' || hand.cards.length !== 2) return; if (hand.cards[0].weight === hand.cards[1].weight) { const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + seat.username + '$', 'i'), credits: { $gte: hand.bet } }, { $inc: { credits: -hand.bet } }, { new: true }); if (!updatedUser) return; seat.credits = updatedUser.credits; await new Transaction({ username: updatedUser.username, type: getGameTitle(roomId), amount: -hand.bet }).save(); io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); const splitCard = hand.cards.pop(); const newHand = { cards: [splitCard], bet: hand.bet, status: 'waiting', value: 0 }; hand.cards.push(room.deck.pop()); newHand.cards.push(room.deck.pop()); hand.value = calculateValue(hand.cards); newHand.value = calculateValue(newHand.cards); if(hand.value === 21) hand.status = 'stand'; if(newHand.value === 21) newHand.status = 'stand'; seat.hands.push(newHand); if(hand.status === 'stand') moveToNextTurn(roomId); else { room.turnEndTime = Date.now() + 15000; startTurnTimer(roomId); emitGameState(roomId); } } } catch(e){} });

    socket.on('claim_daily_reward_box', async ({ username, boxIndex }) => {
        try {
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); if (!user) return; const now = new Date(); const lastClaim = user.lastRewardClaim ? new Date(user.lastRewardClaim) : new Date(0); const msIn24Hours = 24 * 60 * 60 * 1000;
            if (now.getTime() - lastClaim.getTime() >= msIn24Hours) {
                let prizes = [1000, 0, 0, 0, 5000, 10000]; prizes = prizes.sort(() => Math.random() - 0.5); 
                let wonAmount = prizes[boxIndex]; if(typeof wonAmount !== 'number' || isNaN(wonAmount)) wonAmount = 0;
                user.lastRewardClaim = now;
                
                if (wonAmount > 0) { user.credits += wonAmount; await new Transaction({ username: user.username, type: 'DAILY REWARD', amount: wonAmount, status: 'completed' }).save(); adminLog(`${user.username} claimed ${wonAmount} Daily Reward.`); } await user.save();
                const msLeft = new Date(now.getTime() + msIn24Hours).getTime() - now.getTime(); const cooldownSeconds = Math.floor(msLeft / 1000);
                socket.emit('reward_box_opened', { success: true, wonAmount, allPrizes: prizes, credits: user.credits, cooldownSeconds });
                io.emit('credit_update', { username: user.username, credits: user.credits }); 
                Object.keys(rooms).forEach(rId => { const seat = rooms[rId].seats.find(s => s && s.username === user.username); if(seat) { seat.credits = user.credits; emitGameState(rId); } });
            } else { socket.emit('reward_box_opened', { success: false, message: 'Cooldown active' }); }
        } catch (e) { socket.emit('reward_box_opened', { success: false, message: 'Server sync error' }); }
    });

    socket.on('disconnect', () => {
        const data = socketUserMap[socket.id];
        if (data) {
            if (data.arcadeGame) {
                let g = data.arcadeGame; let lobby = g === 'dice' ? diceLobby : (g === 'color' ? colorLobby : derbyLobby);
                lobby = lobby.filter(p => p.username !== data.username);
                if(g === 'dice') diceLobby = lobby; else if(g === 'color') colorLobby = lobby; else derbyLobby = lobby;
                io.to('arcade_' + g).emit('arcade_lobby_update', { game: g, lobby });

                if(g === 'derby') {
                    const seatIdx = coinDuel.seats.findIndex(s => s && s.username.toLowerCase() === data.username.toLowerCase());
                    if(seatIdx !== -1) handleCoinDuelLeave(seatIdx);
                }
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

// --- COIN DUEL LOGIC ---
async function handleCoinDuelLeave(seatIndex) {
    const seat = coinDuel.seats[seatIndex];
    if(!seat) return;

    if(coinDuel.status === 'flipping' && coinDuel.betAmount > 0) {
        const otherIndex = seatIndex === 0 ? 1 : 0;
        const otherSeat = coinDuel.seats[otherIndex];
        
        await refundDuelSeat(seat.username, coinDuel.betAmount);
        if(otherSeat) await refundDuelSeat(otherSeat.username, coinDuel.betAmount);
        
        adminLog(`[DUEL ABORTED] ${seat.username} left mid-game. Bets refunded.`);
    }

    coinDuel.seats[seatIndex] = null;
    if(coinDuel.seats.every(s => s === null)) {
        coinDuel = { seats: [null, null], status: 'waiting', format: 1, betAmount: 0, hostIndex: -1, result: null, message: 'WAITING FOR CHALLENGER', flipInterval: null };
    } else {
        coinDuel.hostIndex = seatIndex === 0 ? 1 : 0;
        coinDuel.status = 'waiting';
        coinDuel.message = 'CHALLENGER ABANDONED.';
        coinDuel.seats[coinDuel.hostIndex].ready = false;
        coinDuel.seats[coinDuel.hostIndex].score = 0;
    }
    io.to('arcade_derby').emit('coin_duel_state_update', coinDuel);
}

async function refundDuelSeat(username, amount) {
    const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i') }, { $inc: { credits: amount } }, { new: true });
    if(user) {
        await new Transaction({ username: user.username, type: 'DUEL REFUND', amount: amount }).save();
        io.emit('credit_update', { username: user.username, credits: user.credits });
    }
}

function runDuelFlipSequence() {
    coinDuel.timer = 3;
    coinDuel.message = 'FLIPPING IN 3...';
    io.to('arcade_derby').emit('coin_duel_state_update', coinDuel);

    let countdown = setInterval(() => {
        coinDuel.timer--;
        if(coinDuel.timer > 0) {
            coinDuel.message = `FLIPPING IN ${coinDuel.timer}...`;
            io.to('arcade_derby').emit('coin_duel_state_update', coinDuel);
        } else {
            clearInterval(countdown);
            coinDuel.message = 'FLIPPING...';
            io.to('arcade_derby').emit('coin_duel_state_update', coinDuel);

            setTimeout(async () => {
                let res = Math.random() < 0.5 ? 'heads' : 'tails';
                coinDuel.result = res;
                coinDuel.status = 'resolving';

                let roundWinnerIndex = -1;
                if(coinDuel.seats[0].choice === res) roundWinnerIndex = 0;
                if(coinDuel.seats[1].choice === res) roundWinnerIndex = 1;

                if(roundWinnerIndex !== -1) {
                    coinDuel.seats[roundWinnerIndex].score++;
                    coinDuel.message = `${coinDuel.seats[roundWinnerIndex].username.toUpperCase()} SCORES!`;
                }

                io.to('arcade_derby').emit('coin_duel_state_update', coinDuel);

                // Check if match won
                let matchWinner = null;
                if(coinDuel.seats[0].score >= coinDuel.format) matchWinner = 0;
                if(coinDuel.seats[1].score >= coinDuel.format) matchWinner = 1;

                setTimeout(async () => {
                    if(matchWinner !== null) {
                        coinDuel.status = 'finished';
                        const winner = coinDuel.seats[matchWinner];
                        coinDuel.message = `${winner.username.toUpperCase()} WINS THE DUEL!`;
                        
                        if(coinDuel.betAmount > 0) {
                            const winAmount = coinDuel.betAmount * 2;
                            try {
                                const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + winner.username + '$', 'i') }, { $inc: { credits: winAmount } }, {new: true}); 
                                if(updatedUser) {
                                    await new Transaction({ username: updatedUser.username, type: 'DUEL ROOM WIN', amount: winAmount }).save();
                                    io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits });
                                }
                            } catch(e){}
                        }
                        io.to('arcade_derby').emit('coin_duel_state_update', coinDuel);

                        setTimeout(() => {
                            if(coinDuel.status === 'finished') {
                                coinDuel.status = 'waiting';
                                coinDuel.result = null;
                                coinDuel.message = 'WAITING FOR READY';
                                if(coinDuel.seats[0]) { coinDuel.seats[0].ready = false; coinDuel.seats[0].score = 0; }
                                if(coinDuel.seats[1]) { coinDuel.seats[1].ready = false; coinDuel.seats[1].score = 0; }
                                io.to('arcade_derby').emit('coin_duel_state_update', coinDuel);
                            }
                        }, 5000);

                    } else {
                        if(coinDuel.status !== 'finished') {
                            coinDuel.status = 'flipping';
                            coinDuel.result = null;
                            runDuelFlipSequence();
                        }
                    }
                }, 3000);

            }, 2000);
        }
    }, 1000);
}

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
                    if (payout > 0) { 
                        seat.credits += payout; 
                        try {
                            const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + seat.username + '$', 'i') }, { $inc: { credits: payout } }, {new: true}); 
                            if(updatedUser) {
                                await new Transaction({ username: updatedUser.username, type: getGameTitle(roomId)+" WIN", amount: payout }).save(); 
                                io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); 
                            }
                        } catch(e){}
                    }
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
