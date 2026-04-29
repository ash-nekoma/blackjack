require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
// Increase maxHttpBufferSize to handle audio blobs (e.g., 5MB)
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 5e6 });

app.use(express.json());
app.use(express.static(__dirname));

// --- MONGODB CONNECTION ---
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/casinoroyale').then(async () => {
    console.log('MongoDB Connected Successfully');
    try {
        const adminConfig = await SystemConfig.findOne({ configName: 'admin_password' });
        if (!adminConfig) await new SystemConfig({ configName: 'admin_password', configValue: 'admin123' }).save();
        const modConfig = await SystemConfig.findOne({ configName: 'mod_password' });
        if (!modConfig) await new SystemConfig({ configName: 'mod_password', configValue: 'mod123' }).save();
        console.log('SYSTEM LOG: Security Credentials Initialized.');
    } catch(e) { console.error("DB Error:", e); }
}).catch(err => console.error('MongoDB connection error:', err));

// --- DATABASE SCHEMAS ---
const SystemConfig = mongoose.model('SystemConfig', new mongoose.Schema({ configName: { type: String, unique: true }, configValue: { type: String } }));
const User = mongoose.model('User', new mongoose.Schema({
    username: { type: String, required: true, unique: true }, password: { type: String, required: true },
    credits: { type: Number, default: 0 }, status: { type: String, default: 'active' }, nameColor: { type: String, default: '#f8fafc' }, 
    ipAddress: String, tosAccepted: Boolean, lastRewardClaim: { type: Date, default: null }, createdAt: { type: Date, default: Date.now },
    inventory: { type: [String], default: ['Starter Token', 'Retro Badge'] }
}));

const Transaction = mongoose.model('Transaction', new mongoose.Schema({
    username: String, type: String, amount: Number, status: { type: String, default: 'completed' }, date: { type: Date, default: Date.now }
}));

const GiftCode = mongoose.model('GiftCode', new mongoose.Schema({ 
    code: { type: String, unique: true }, amount: Number, usesLeft: Number,
    batchName: String, claimedBy: { type: String, default: null }, claimDate: { type: Date, default: null }
}));

const Ticket = mongoose.model('Ticket', new mongoose.Schema({
    username: String, target: String, type: String, subject: String,
    messages: [{ sender: String, text: String, date: { type: Date, default: Date.now } }],
    status: { type: String, default: 'open' }, unreadPlayer: { type: Boolean, default: true },
    unreadAdmin: { type: Boolean, default: false }, readBy: { type: [String], default: [] }, updatedAt: { type: Date, default: Date.now }
}));

const GameRound = mongoose.model('GameRound', new mongoose.Schema({
    game: String, roundId: String, timestamp: { type: Date, default: Date.now },
    result: mongoose.Schema.Types.Mixed, players: [{ username: String, choice: String, bet: Number, win: Number }]
}));

// --- GAME LOGIC GLOBALS ---
const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades']; const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const rooms = { '3seat': createRoom(3), '5seat': createRoom(5) };

function createRoom(numSeats) {
    return { seats: Array(numSeats).fill(null), dealerCards: [], deck: [], status: 'waiting', activeSeatIndex: -1, betEndTime: 0, nextRoundTime: 0, turnEndTime: 0, lobby: [], betTimerInterval: null, nextRoundInterval: null, turnTimerInterval: null, dealerInterval: null };
}

const diceGame = { status: 'betting', betEndTime: Date.now() + 15000, dice: [1, 1], bets: [], history: [] };

const DERBY_PROFILES = [ { m: 2, s: 1.5 }, { m: 3, s: 1.2 }, { m: 3, s: 1.2 }, { m: 5, s: 0.9 }, { m: 7, s: 0.7 }, { m: 10, s: 0.4 } ];
const derbyGame = { status: 'betting', betEndTime: Date.now() + 15000, distances: [0,0,0,0,0,0], speeds: [0,0,0,0,0,0], bets: [], history: [], laneProfiles: [] };
function shuffleDerby() { derbyGame.laneProfiles = [...DERBY_PROFILES].sort(() => Math.random() - 0.5); } shuffleDerby(); 

const PERYA_COLORS = ['red', 'blue', 'yellow', 'green', 'pink', 'white'];
const colorGame = { status: 'betting', betEndTime: Date.now() + 15000, dice: ['red', 'blue', 'yellow'], bets: [], history: [] };

const cupsGame = { status: 'shuffling', stateEndTime: Date.now() + 3000, betEndTime: 0, winningCup: 0, bets: [], history: [] };

let pvpDuel = { seats: [null, null], status: 'waiting', type: 'coin', format: 1, betAmount: 0, slices: 4, hostIndex: -1, result: null, winSliceIndex: 0, message: 'WAITING FOR PLAYERS', timerInterval: null };

let activeAuctions = []; 

const socketUserMap = {}; let diceLobby = []; let derbyLobby = []; let colorLobby = []; let pvpLobby = []; let cupsLobby = [];
let strictHouseEdge = false; let gameLocks = { blackjack: false, dice: false, derby: false, color: false, cups: false };

function getPHTTime() { try { return new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Manila' }); } catch(e) { return new Date().toLocaleTimeString(); } }
function adminLog(action) { io.to('admin_room').emit('admin_log', `▶ [${getPHTTime()}] ${action}`); }

async function sendSystemMail(username, subject, text) {
    const t = new Ticket({ username, target: 'specific', type: 'message', subject, messages: [{ sender: 'SYSTEM', text }], unreadPlayer: true, unreadAdmin: false });
    await t.save(); io.emit('new_mail', { username });
}

// --- GAME & MARKET LOOPS ---
setInterval(() => {
    const now = Date.now();
    
    // ROOMS LOOP
    Object.keys(rooms).forEach(roomId => {
        let room = rooms[roomId]; let changed = false;
        room.seats.forEach((seat, i) => { if (seat && seat.kickAt && now >= seat.kickAt) { room.seats[i] = null; changed = true; } });
        if (changed) { if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } emitGameState(roomId); }
    });

    // MARKET AUCTION LOOP
    for (let i = activeAuctions.length - 1; i >= 0; i--) {
        let auc = activeAuctions[i];
        if (now >= auc.endTime) {
            activeAuctions.splice(i, 1);
            if (auc.highestBidder) {
                User.updateOne({username: new RegExp('^' + auc.highestBidder + '$', 'i')}, {$push: {inventory: auc.item}}).exec();
                User.updateOne({username: new RegExp('^' + auc.seller + '$', 'i')}, {$inc: {credits: auc.currentBid}}).exec();
                sendSystemMail(auc.highestBidder, 'AUCTION WON', `You won the auction for ${auc.item} for ${auc.currentBid} CR. It has been added to your inventory.`);
                sendSystemMail(auc.seller, 'ITEM SOLD', `Your ${auc.item} successfully sold to ${auc.highestBidder} for ${auc.currentBid} CR.`);
            } else {
                User.updateOne({username: new RegExp('^' + auc.seller + '$', 'i')}, {$push: {inventory: auc.item}}).exec();
                sendSystemMail(auc.seller, 'AUCTION EXPIRED', `No one bid on your ${auc.item}. It has been returned to your inventory.`);
            }
            io.emit('market_update', activeAuctions);
        }
    }
}, 1000);

setInterval(() => {
    const now = Date.now();
    
    // DICE LOOP
    if (diceGame.status === 'betting' && now >= diceGame.betEndTime) {
        diceGame.status = 'rolling'; io.to('arcade_dice').emit('dice_state_update', { status: diceGame.status, timeLeft: 0, history: diceGame.history });
        setTimeout(async () => {
            let totalUnder = 0; let totalOver = 0; diceGame.bets.forEach(b => { if(b.choice==='under') totalUnder+=b.amount; if(b.choice==='over') totalOver+=b.amount; });
            let d1 = Math.floor(Math.random() * 6) + 1; let d2 = Math.floor(Math.random() * 6) + 1;
            if (strictHouseEdge && (totalUnder > 0 || totalOver > 0)) { if (totalUnder > totalOver && (d1+d2) < 7) { d1=4; d2=4; } else if (totalOver > totalUnder && (d1+d2) > 7) { d1=2; d2=2; } }
            diceGame.dice = [d1, d2]; const total = d1 + d2;
            diceGame.status = 'resolving'; diceGame.history.unshift(diceGame.dice); if(diceGame.history.length > 20) diceGame.history.pop();
            let winners = []; let roundRecord = new GameRound({ game: 'dice', roundId: Math.random().toString(36).substring(2, 8).toUpperCase(), result: total, players: [] });
            for (let b of diceGame.bets) {
                let won = false; let payout = 0;
                if (b.choice === 'under' && total < 7) { won = true; payout = b.amount * 2; }
                if (b.choice === 'over' && total > 7) { won = true; payout = b.amount * 2; }
                if (b.choice === 'seven' && total === 7) { won = true; payout = b.amount * 5; }
                roundRecord.players.push({ username: b.username, choice: b.choice, bet: b.amount, win: won ? payout : 0 });
                if (won) {
                    try { const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + b.username + '$', 'i') }, { $inc: { credits: payout } }, {new: true}); 
                        if(updatedUser) { await new Transaction({ username: updatedUser.username, type: 'HIGH-LOW DICE WIN', amount: payout }).save(); winners.push({ username: updatedUser.username, choice: b.choice, amount: payout }); io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); }
                    } catch(e) {}
                }
            }
            await roundRecord.save();
            io.to('arcade_dice').emit('dice_state_update', { status: diceGame.status, dice: diceGame.dice, total, winners, bets: diceGame.bets, history: diceGame.history });
            setTimeout(() => { diceGame.bets = []; diceGame.status = 'betting'; diceGame.betEndTime = Date.now() + 15000; io.to('arcade_dice').emit('dice_state_update', { status: diceGame.status, betEndTime: diceGame.betEndTime, history: diceGame.history }); }, 5000);
        }, 3000); 
    }

    // DERBY LOOP (CLASSIC SPRINT - NO INVISIBLE WALLS)
    if (derbyGame.status === 'betting' && now >= derbyGame.betEndTime) {
        derbyGame.status = 'racing'; 
        derbyGame.distances = [0,0,0,0,0,0]; 
        derbyGame.speeds = derbyGame.laneProfiles.map(p => p.s);
        
        io.to('arcade_derby').emit('derby_state_update', { status: derbyGame.status, timeLeft: 0, distances: derbyGame.distances, history: derbyGame.history, laneProfiles: derbyGame.laneProfiles });
        
        let raceTick = 0;
        let currentSpeeds = [0,0,0,0,0,0];
        
        let raceInterval = setInterval(async () => {
            raceTick++;
            let finished = false; 
            let laneBets = [0,0,0,0,0,0]; 
            derbyGame.bets.forEach(b => laneBets[b.choice] += b.amount);

            if (raceTick % 10 === 1) { 
                for(let i=0; i<6; i++) {
                    let oddsSpeed = derbyGame.laneProfiles[i].s; 
                    let mod = (strictHouseEdge && laneBets[i] > 0) ? 0.8 : 1;

                    if (raceTick < 110) {
                        currentSpeeds[i] = (0.3 + Math.random() * 0.7) * (oddsSpeed * 0.4 + 0.6) * mod;
                    } else {
                        let miracle = (oddsSpeed < 1.0 && Math.random() > 0.85) ? (Math.random() * 1.5 + 0.5) : 0;
                        currentSpeeds[i] = (oddsSpeed * mod * 0.7) + miracle + (Math.random() * 0.3);
                    }
                }
            }
            
            for(let i=0; i<6; i++) {
                derbyGame.distances[i] += currentSpeeds[i]; 
                if (derbyGame.distances[i] >= 100) { finished = true; }
            }

            io.to('arcade_derby').emit('derby_race_tick', { distances: derbyGame.distances });

            if (finished) {
                clearInterval(raceInterval); 
                derbyGame.status = 'resolving';

                let winnerIndex = 0; let maxDist = -1;
                for(let i=0; i<6; i++) { 
                    if (derbyGame.distances[i] > maxDist) { maxDist = derbyGame.distances[i]; winnerIndex = i; } 
                    if (derbyGame.distances[i] > 100) derbyGame.distances[i] = 100;
                }
                io.to('arcade_derby').emit('derby_race_tick', { distances: derbyGame.distances });

                derbyGame.history.unshift(winnerIndex); 
                if(derbyGame.history.length > 20) derbyGame.history.pop();

                let winners = []; 
                let roundRecord = new GameRound({ game: 'derby', roundId: Math.random().toString(36).substring(2, 8).toUpperCase(), result: winnerIndex, players: [] });

                for (let b of derbyGame.bets) {
                    let wonAmount = (b.choice === winnerIndex) ? (b.amount * derbyGame.laneProfiles[winnerIndex].m) : 0;
                    const colorNames = ['RED HORSE', 'BLUE HORSE', 'GREEN HORSE', 'PURPLE HORSE', 'PINK HORSE', 'GOLD HORSE'];
                    roundRecord.players.push({ username: b.username, choice: colorNames[b.choice], bet: b.amount, win: wonAmount });

                    if (b.choice === winnerIndex) {
                        try { 
                            const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + b.username + '$', 'i') }, { $inc: { credits: wonAmount } }, {new: true}); 
                            if(updatedUser) { 
                                await new Transaction({ username: updatedUser.username, type: 'DERBY WIN', amount: wonAmount }).save(); 
                                winners.push({ username: updatedUser.username, choice: b.choice, amount: wonAmount }); 
                                io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); 
                            }
                        } catch(e) {}
                    }
                }
                await roundRecord.save();
                
                io.to('arcade_derby').emit('derby_state_update', { status: derbyGame.status, winner: winnerIndex, winners, bets: derbyGame.bets, history: derbyGame.history, distances: derbyGame.distances, laneProfiles: derbyGame.laneProfiles });
                
                setTimeout(() => { 
                    derbyGame.bets = []; 
                    derbyGame.status = 'betting'; 
                    derbyGame.distances = [0,0,0,0,0,0]; 
                    shuffleDerby(); 
                    derbyGame.betEndTime = Date.now() + 15000; 
                    io.to('arcade_derby').emit('derby_state_update', { status: derbyGame.status, betEndTime: derbyGame.betEndTime, history: derbyGame.history, distances: derbyGame.distances, laneProfiles: derbyGame.laneProfiles }); 
                }, 5000);
            }
        }, 100); 
    }

    // COLOR GAME LOOP
    if (colorGame.status === 'betting' && now >= colorGame.betEndTime) {
        colorGame.status = 'rolling'; io.to('arcade_color').emit('color_state_update', { status: colorGame.status, timeLeft: 0, history: colorGame.history });
        setTimeout(async () => {
            colorGame.dice = [PERYA_COLORS[Math.floor(Math.random() * 6)], PERYA_COLORS[Math.floor(Math.random() * 6)], PERYA_COLORS[Math.floor(Math.random() * 6)]];
            colorGame.status = 'resolving'; colorGame.history.unshift(colorGame.dice); if(colorGame.history.length > 20) colorGame.history.pop();
            let winners = []; let roundRecord = new GameRound({ game: 'color', roundId: Math.random().toString(36).substring(2, 8).toUpperCase(), result: colorGame.dice, players: [] });
            for (let b of colorGame.bets) {
                let matches = colorGame.dice.filter(c => c === b.choice).length; let wonAmount = matches > 0 ? (b.amount + (b.amount * matches)) : 0;
                roundRecord.players.push({ username: b.username, choice: b.choice.toUpperCase(), bet: b.amount, win: wonAmount });
                if (matches > 0) {
                    try { const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + b.username + '$', 'i') }, { $inc: { credits: wonAmount } }, {new: true}); 
                        if(updatedUser) { await new Transaction({ username: updatedUser.username, type: 'COLOR GAME WIN', amount: wonAmount }).save(); winners.push({ username: updatedUser.username, choice: b.choice, amount: wonAmount }); io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); }
                    } catch(e) {}
                }
            }
            await roundRecord.save();
            io.to('arcade_color').emit('color_state_update', { status: colorGame.status, dice: colorGame.dice, winners, bets: colorGame.bets, history: colorGame.history });
            setTimeout(() => { colorGame.bets = []; colorGame.status = 'betting'; colorGame.betEndTime = Date.now() + 15000; io.to('arcade_color').emit('color_state_update', { status: colorGame.status, betEndTime: colorGame.betEndTime, history: colorGame.history }); }, 5000);
        }, 3000); 
    }

    // 3 CUPS GAME LOOP
    if (cupsGame.status === 'shuffling' && now >= cupsGame.stateEndTime) {
        cupsGame.status = 'betting';
        cupsGame.betEndTime = now + 7000; 
        cupsGame.stateEndTime = cupsGame.betEndTime;
        io.to('arcade_cups').emit('cups_state_update', { status: cupsGame.status, betEndTime: cupsGame.betEndTime, history: cupsGame.history });
    }
    else if (cupsGame.status === 'betting' && now >= cupsGame.stateEndTime) {
        cupsGame.status = 'resolving'; 
        cupsGame.stateEndTime = now + 5000; 
        
        (async () => {
            cupsGame.winningCup = Math.floor(Math.random() * 3); 
            cupsGame.history.unshift(cupsGame.winningCup); if(cupsGame.history.length > 20) cupsGame.history.pop();
            
            let winners = []; let roundRecord = new GameRound({ game: 'cups', roundId: Math.random().toString(36).substring(2, 8).toUpperCase(), result: cupsGame.winningCup, players: [] });
            for (let b of cupsGame.bets) {
                let won = (b.choice === cupsGame.winningCup); let wonAmount = won ? (b.amount * 2.5) : 0;
                roundRecord.players.push({ username: b.username, choice: `CUP ${b.choice + 1}`, bet: b.amount, win: wonAmount });
                if (won) {
                    try { 
                        const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + b.username + '$', 'i') }, { $inc: { credits: wonAmount } }, {new: true}); 
                        if(updatedUser) { 
                            await new Transaction({ username: updatedUser.username, type: 'CUPS WIN', amount: wonAmount }).save(); 
                            winners.push({ username: updatedUser.username, choice: b.choice, amount: wonAmount }); 
                            io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); 
                        }
                    } catch(e) {}
                }
            }
            await roundRecord.save();
            io.to('arcade_cups').emit('cups_state_update', { status: cupsGame.status, winningCup: cupsGame.winningCup, winners, bets: cupsGame.bets, history: cupsGame.history });
            
            setTimeout(() => { 
                cupsGame.bets = []; 
                cupsGame.status = 'shuffling'; 
                cupsGame.stateEndTime = Date.now() + 3000; 
                io.to('arcade_cups').emit('cups_state_update', { status: cupsGame.status, history: cupsGame.history }); 
            }, 5000);
        })();
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

// --- ADMIN SECURITY & APIs ---
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
        if (aConf && req.body.password === aConf.configValue) { adminLog("MASTER ADMIN successfully logged in."); res.json({ success: true, role: 'admin' }); } 
        else if (mConf && req.body.password === mConf.configValue) { adminLog("MODERATOR successfully logged in."); res.json({ success: true, role: 'mod' }); } 
        else { res.status(401).json({ error: 'Invalid password.' }); }
    } catch(e) { res.status(500).json({ error: 'Database loading, please try again.' }); }
});

// --- PLAYER APIs ---
app.post('/api/signup', async (req, res) => { 
    try { 
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const existing = await User.findOne({ username: new RegExp('^' + req.body.username + '$', 'i') }); if(existing) return res.status(400).json({ error: 'Username taken.' });
        await new User({ username: req.body.username, password: req.body.password, ipAddress: ip, tosAccepted: true, status: 'pending', inventory: ['Starter Token', 'Retro Badge'] }).save(); 
        adminLog(`New account requested: ${req.body.username} (IP: ${ip})`); res.status(201).json({ message: 'Account requested successfully.' }); 
    } catch (err) { res.status(400).json({ error: 'Username taken.' }); } 
});

app.post('/api/login', async (req, res) => {
    try {
        const user = await User.findOne({ username: new RegExp('^' + req.body.username + '$', 'i'), password: req.body.password });
        if (!user) return res.status(401).json({ error: 'Invalid credentials.' }); 
        if (user.status === 'pending') return res.status(401).json({ error: 'Account pending Admin approval.' });
        if (user.status === 'banned') return res.status(401).json({ error: 'Account banned by administration.' });
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress; user.ipAddress = ip; await user.save();
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
    try { const txs = await Transaction.find({ username: new RegExp('^' + req.params.username + '$', 'i') }).sort({ date: -1 }).limit(50); res.json(txs); } catch(e) { res.status(500).json({ error: 'Server Error' }); }
});

// --- SOCKET SYSTEM ---
io.on('connection', (socket) => {
    
    // PUSH TO TALK RELAY
    socket.on('voice_message', (data) => {
        if (data.room && data.audio) {
            socket.to(data.room).emit('voice_broadcast', { username: socketUserMap[socket.id]?.username || 'Unknown', audio: data.audio });
        }
    });

    // MARKET & INVENTORY
    socket.on('req_market', async ({ username }) => {
        try {
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') });
            if(user) socket.emit('market_data', { auctions: activeAuctions, inventory: user.inventory || [] });
        } catch(e){}
    });

    socket.on('create_auction', async ({ username, item, startingBid }) => {
        try {
            if(startingBid < 100) return socket.emit('arcade_error', 'Starting bid must be at least 100 CR.');
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') });
            if(!user || !user.inventory.includes(item)) return socket.emit('arcade_error', 'Item not in inventory.');
            
            const itemIndex = user.inventory.indexOf(item);
            user.inventory.splice(itemIndex, 1);
            await user.save();

            const auction = {
                id: Math.random().toString(36).substring(2, 9),
                seller: user.username,
                item: item,
                currentBid: startingBid,
                highestBidder: null,
                endTime: Date.now() + (5 * 60 * 1000) 
            };
            activeAuctions.push(auction);
            io.emit('market_update', activeAuctions);
            socket.emit('market_data', { auctions: activeAuctions, inventory: user.inventory });
        } catch(e){}
    });

    socket.on('place_bid', async ({ id, username, bidAmount }) => {
        try {
            let auc = activeAuctions.find(a => a.id === id);
            if (!auc) return socket.emit('arcade_error', 'Auction not found.');
            if (auc.seller.toLowerCase() === username.toLowerCase()) return socket.emit('arcade_error', 'You cannot bid on your own item.');
            if (bidAmount <= auc.currentBid && auc.highestBidder) return socket.emit('arcade_error', 'Bid must be higher than current bid.');
            if (bidAmount < auc.currentBid && !auc.highestBidder) return socket.emit('arcade_error', 'Bid must meet starting price.');

            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') });
            if (!user || user.credits < bidAmount) return socket.emit('arcade_error', 'Insufficient credits.');

            user.credits -= bidAmount;
            await user.save();
            io.emit('credit_update', {username: user.username, credits: user.credits});

            if (auc.highestBidder) {
                const old = await User.findOneAndUpdate({username: new RegExp('^' + auc.highestBidder + '$', 'i')}, {$inc: {credits: auc.currentBid}}, {new: true});
                if(old) io.emit('credit_update', {username: old.username, credits: old.credits});
            }

            auc.highestBidder = user.username;
            auc.currentBid = bidAmount;
            
            if (auc.endTime - Date.now() < 15000) auc.endTime = Date.now() + 15000;

            io.emit('market_update', activeAuctions);
            socket.emit('market_data', { auctions: activeAuctions, inventory: user.inventory }); 
        } catch(e){}
    });

    // NOTIFICATION SYSTEM
    socket.on('req_inbox', async ({ username }) => { try { const tickets = await Ticket.find({ $or: [{ username: new RegExp('^' + username + '$', 'i') }, { username: 'GLOBAL' }] }).sort({ updatedAt: -1 }); socket.emit('inbox_data', tickets); } catch(e){} });
    socket.on('read_ticket', async ({ id, username }) => { try { const t = await Ticket.findById(id); if(t) { if(t.username === 'GLOBAL') { if(!t.readBy.includes(username)) { t.readBy.push(username); await t.save(); } } else { t.unreadPlayer = false; await t.save(); } } } catch(e){} });
    socket.on('player_create_ticket', async ({ username, subject, text }) => { try { const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); if(!user) return; const t = new Ticket({ username: user.username, target: 'specific', type: 'support', subject, messages: [{ sender: user.username, text }], unreadPlayer: false, unreadAdmin: true }); await t.save(); adminLog(`New support ticket from ${user.username}: ${subject}`); io.emit('admin_inbox_update'); const tickets = await Ticket.find({ $or: [{ username: user.username }, { username: 'GLOBAL' }] }).sort({ updatedAt: -1 }); socket.emit('inbox_data', tickets); } catch(e){} });
    socket.on('player_reply', async ({ id, username, text }) => { try { const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); if(!user) return; const t = await Ticket.findById(id); if(t && t.status === 'open' && t.type !== 'announcement') { t.messages.push({ sender: user.username, text }); t.unreadAdmin = true; t.updatedAt = Date.now(); await t.save(); socket.emit('ticket_updated', t); io.emit('admin_inbox_update'); } } catch(e){} });
    socket.on('del_ticket', async ({ id, username }) => { try { const t = await Ticket.findById(id); if(t && t.username !== 'GLOBAL') { await Ticket.findByIdAndDelete(id); } const tickets = await Ticket.find({ $or: [{ username: new RegExp('^' + username + '$', 'i') }, { username: 'GLOBAL' }] }).sort({ updatedAt: -1 }); socket.emit('inbox_data', tickets); } catch(e){} });

    // ARCADE LOBBIES
    socket.on('enter_arcade', async ({ username, game }) => {
        try {
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); if (!user) return;
            socket.join('arcade_' + game); socketUserMap[socket.id] = { username: user.username, arcadeGame: game, roomId: 'arcade_' + game };
            let lobby; if(game === 'dice') lobby = diceLobby; else if(game === 'color') lobby = colorLobby; else if(game === 'derby') lobby = derbyLobby; else if(game === 'pvp') lobby = pvpLobby; else if(game === 'cups') lobby = cupsLobby;
            if (lobby && !lobby.find(p => p.username === user.username)) lobby.push({ username: user.username, color: user.nameColor });
            io.to('arcade_' + game).emit('arcade_lobby_update', { game, lobby });
        } catch(e) {}
    });

    socket.on('leave_arcade', ({ username, game }) => {
        socket.leave('arcade_' + game);
        const searchUser = new RegExp('^' + username + '$', 'i');
        let lobby;
        if(game === 'dice') { diceLobby = diceLobby.filter(p => !searchUser.test(p.username)); lobby = diceLobby; }
        else if(game === 'color') { colorLobby = colorLobby.filter(p => !searchUser.test(p.username)); lobby = colorLobby; }
        else if(game === 'derby') { derbyLobby = derbyLobby.filter(p => !searchUser.test(p.username)); lobby = derbyLobby; }
        else if(game === 'cups') { cupsLobby = cupsLobby.filter(p => !searchUser.test(p.username)); lobby = cupsLobby; }
        else if(game === 'pvp') { 
            pvpLobby = pvpLobby.filter(p => !searchUser.test(p.username)); lobby = pvpLobby; 
            const seatIdx = pvpDuel.seats.findIndex(s => s && s.username.toLowerCase() === username.toLowerCase());
            if(seatIdx !== -1) handlePvpLeave(seatIdx);
        }
        if(socketUserMap[socket.id]) { delete socketUserMap[socket.id].arcadeGame; delete socketUserMap[socket.id].roomId; }
        io.to('arcade_' + game).emit('arcade_lobby_update', { game, lobby });
    });

    socket.on('send_chat', ({ roomId, username, message }) => { 
        if(roomId && username && message) {
            if (['dice', 'derby', 'color', 'pvp', 'cups'].includes(roomId)) io.to('arcade_' + roomId).emit('receive_chat', { roomId, username, message });
            else io.to(roomId).emit('receive_chat', { roomId, username, message }); 
        }
    });

    // --- ARCADE BETS ---
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
            if (existingBetObj) existingBetObj.amount += amount; else diceGame.bets.push({ username: user.username, choice, amount }); 
            io.emit('credit_update', { username: user.username, credits: user.credits }); 
            socket.emit('arcade_bet_placed', { game: 'dice', credits: user.credits, choice, totalChoiceBet: existingBetAmt + amount });
        } catch(e) { socket.emit('arcade_error', 'Server sync error.'); }
    });

    socket.on('get_derby_state', () => { socket.emit('derby_state_update', { status: derbyGame.status, betEndTime: derbyGame.betEndTime, distances: derbyGame.distances, history: derbyGame.history, laneProfiles: derbyGame.laneProfiles }); });
    socket.on('place_derby_bet', async ({ username, choice, amount }) => {
        try {
            if(gameLocks.derby) return socket.emit('arcade_error', 'Game is currently offline for maintenance.');
            if (derbyGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are currently closed!');
            if (amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per lane!');
            let choiceIdx = parseInt(choice); let existingBetAmt = derbyGame.bets.filter(b=>b.username.toLowerCase()===username.toLowerCase() && b.choice===choiceIdx).reduce((sum,b)=>sum+b.amount,0);
            if(existingBetAmt + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per lane!');

            const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i'), credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
            if (!user) return socket.emit('arcade_error', 'Insufficient credits');
            await new Transaction({ username: user.username, type: '8-BIT DERBY', amount: -amount }).save();
            let existingBetObj = derbyGame.bets.find(b => b.username.toLowerCase() === user.username.toLowerCase() && b.choice === choiceIdx);
            if (existingBetObj) existingBetObj.amount += amount; else derbyGame.bets.push({ username: user.username, choice: choiceIdx, amount }); 
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
            if (existingBetObj) existingBetObj.amount += amount; else colorGame.bets.push({ username: user.username, choice, amount }); 
            io.emit('credit_update', { username: user.username, credits: user.credits }); 
            socket.emit('arcade_bet_placed', { game: 'color', credits: user.credits, choice, totalChoiceBet: existingBetAmt + amount });
        } catch(e) { socket.emit('arcade_error', 'Server sync error.'); }
    });

    socket.on('get_cups_state', () => { socket.emit('cups_state_update', { status: cupsGame.status, betEndTime: cupsGame.betEndTime, history: cupsGame.history }); });
    socket.on('place_cups_bet', async ({ username, choice, amount }) => {
        try {
            if(gameLocks.cups) return socket.emit('arcade_error', 'Game is currently offline for maintenance.');
            if (cupsGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are currently closed!');
            if (amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per cup!');
            
            let existingOtherBet = cupsGame.bets.find(b => b.username.toLowerCase() === username.toLowerCase() && b.choice !== choice);
            if (existingOtherBet) return socket.emit('arcade_error', 'You can only bet on ONE cup per round!');

            let existingBetAmt = cupsGame.bets.filter(b=>b.username.toLowerCase()===username.toLowerCase() && b.choice===choice).reduce((sum,b)=>sum+b.amount,0);
            if(existingBetAmt + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per cup!');

            const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i'), credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
            if (!user) return socket.emit('arcade_error', 'Insufficient credits');
            await new Transaction({ username: user.username, type: '3 CUPS', amount: -amount }).save();
            let existingBetObj = cupsGame.bets.find(b => b.username.toLowerCase() === user.username.toLowerCase() && b.choice === choice);
            if (existingBetObj) existingBetObj.amount += amount; else cupsGame.bets.push({ username: user.username, choice, amount }); 
            io.emit('credit_update', { username: user.username, credits: user.credits }); 
            socket.emit('arcade_bet_placed', { game: 'cups', credits: user.credits, choice, totalChoiceBet: existingBetAmt + amount });
        } catch(e) { socket.emit('arcade_error', 'Server sync error.'); }
    });

    // --- PVP ARENA (MODAL LOGIC) ---
    socket.on('get_pvp_state', () => { socket.emit('pvp_duel_state_update', pvpDuel); });
    
    socket.on('join_pvp_seat', async ({ username, seatIndex }) => {
        try {
            if(seatIndex < 0 || seatIndex > 1) return;
            if(pvpDuel.seats.some(s => s && s?.username.toLowerCase() === username.toLowerCase())) return socket.emit('arcade_error', 'You are already seated.');
            if(pvpDuel.seats[seatIndex]) return socket.emit('arcade_error', 'Seat taken.');
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); if(!user) return;

            pvpDuel.seats[seatIndex] = { username: user.username, color: user.nameColor, score: 0, choice: '', ready: false };
            
            if(pvpDuel.hostIndex === -1) {
                pvpDuel.hostIndex = seatIndex;
                pvpDuel.message = 'HOST CONFIGURING MATCH';
                socket.emit('open_pvp_host_modal'); 
            } else {
                pvpDuel.message = 'WAITING FOR CHALLENGER TO ACCEPT';
                socket.emit('open_pvp_accept_modal', { 
                    hostName: pvpDuel.seats[pvpDuel.hostIndex]?.username, 
                    format: pvpDuel.format, betAmount: pvpDuel.betAmount, type: pvpDuel.type, slices: pvpDuel.slices 
                });
            }
            io.to('arcade_pvp').emit('pvp_duel_state_update', pvpDuel);
        } catch(e) {}
    });

    socket.on('leave_pvp_seat', ({ username, seatIndex }) => {
        const seat = pvpDuel.seats[seatIndex];
        if (seat && seat.username.toLowerCase() === username.toLowerCase()) { handlePvpLeave(seatIndex); }
    });

    socket.on('host_pvp_match', async ({ username, type, format, betAmount, slices, hostChoice }) => {
        const seatIndex = pvpDuel.seats.findIndex(s => s && s?.username.toLowerCase() === username.toLowerCase());
        if(seatIndex === -1 || seatIndex !== pvpDuel.hostIndex || pvpDuel.status !== 'waiting') return;
        if(betAmount < 0 || betAmount > 100000) return socket.emit('arcade_error', 'Invalid bet limits (0-100k).');
        if(![1, 3, 5].includes(format)) return;

        const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') });
        if (!user || user.credits < betAmount) { return socket.emit('arcade_error', 'You have insufficient credits to wager this amount.'); }

        pvpDuel.type = type; pvpDuel.format = format; pvpDuel.betAmount = betAmount; pvpDuel.slices = slices;
        pvpDuel.seats[seatIndex].choice = type === 'coin' ? hostChoice : pvpDuel.seats[seatIndex]?.username; 
        pvpDuel.seats[seatIndex].ready = true; 
        pvpDuel.message = 'WAITING FOR CHALLENGER...';
        io.to('arcade_pvp').emit('pvp_duel_state_update', pvpDuel);
    });

    socket.on('accept_pvp_duel', async ({ username, choice }) => {
        const seatIndex = pvpDuel.seats.findIndex(s => s && s?.username.toLowerCase() === username.toLowerCase());
        if(seatIndex === -1 || seatIndex === pvpDuel.hostIndex || pvpDuel.status !== 'waiting') return;
        
        const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') });
        if (!user || user.credits < pvpDuel.betAmount) { 
            socket.emit('arcade_error', 'You have insufficient credits.'); 
            return handlePvpLeave(seatIndex); 
        }

        if (pvpDuel.type === 'coin') {
            const hostChoice = pvpDuel.seats[pvpDuel.hostIndex]?.choice;
            pvpDuel.seats[seatIndex].choice = hostChoice === 'heads' ? 'tails' : 'heads';
        } else {
            pvpDuel.seats[seatIndex].choice = pvpDuel.seats[seatIndex]?.username;
        }

        pvpDuel.seats[seatIndex].ready = true;
        io.to('arcade_pvp').emit('pvp_duel_state_update', pvpDuel);

        if(pvpDuel.seats[0] && pvpDuel.seats[0].ready && pvpDuel.seats[1] && pvpDuel.seats[1].ready) {
            pvpDuel.status = 'readying'; pvpDuel.message = 'LOCKING IN BETS...';
            io.to('arcade_pvp').emit('pvp_duel_state_update', pvpDuel);

            if(pvpDuel.betAmount > 0) {
                const u1 = await User.findOne({ username: new RegExp('^' + pvpDuel.seats[0]?.username + '$', 'i') });
                const u2 = await User.findOne({ username: new RegExp('^' + pvpDuel.seats[1]?.username + '$', 'i') });

                if(u1 && u2 && pvpDuel.seats[0] && pvpDuel.seats[1]) {
                    await User.updateOne({ username: u1.username }, { $inc: { credits: -pvpDuel.betAmount } });
                    await User.updateOne({ username: u2.username }, { $inc: { credits: -pvpDuel.betAmount } });
                    await new Transaction({ username: u1.username, type: 'PVP ARENA WAGER', amount: -pvpDuel.betAmount }).save();
                    await new Transaction({ username: u2.username, type: 'PVP ARENA WAGER', amount: -pvpDuel.betAmount }).save();
                    io.emit('credit_update', { username: u1.username, credits: u1.credits - pvpDuel.betAmount });
                    io.emit('credit_update', { username: u2.username, credits: u2.credits - pvpDuel.betAmount });
                }
            }

            pvpDuel.status = pvpDuel.type === 'wheel' ? 'spinning' : 'flipping';
            runPvpSequence();
        }
    });

    // --- BLACKJACK ROOMS ---
    socket.on('enter_room', async ({ username, roomId }) => {
        try {
            if (!rooms[roomId]) return; socket.join(roomId); const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); 
            if (user) { socketUserMap[socket.id] = { username: user.username, roomId }; if(!rooms[roomId].lobby.find(p => p.username === user.username)) { rooms[roomId].lobby.push({ username: user.username, color: user.nameColor }); } }
            emitGameState(roomId);
        } catch(e) {}
    });

    socket.on('leave_room', ({ username, roomId }) => {
        let room = rooms[roomId]; if (!room) return; socket.leave(roomId); room.lobby = room.lobby.filter(p => p.username.toLowerCase() !== username.toLowerCase());
        const seatIndex = room.seats.findIndex(s => s && s.username.toLowerCase() === username.toLowerCase());
        if (seatIndex !== -1) { room.seats[seatIndex] = null; if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } }
        if(socketUserMap[socket.id]) delete socketUserMap[socket.id]; 
        emitGameState(roomId);
    });

    socket.on('join_seat', async ({ roomId, username, seatIndex }) => {
        try {
            let room = rooms[roomId]; if (!room || room.seats.some(s => s && s.username.toLowerCase() === username.toLowerCase()) || seatIndex < 0 || seatIndex >= room.seats.length || room.seats[seatIndex]) return;
            const user = await User.findOne({ username: new RegExp('^' + username + '$', 'i') }); if (!user) return;
            room.seats[seatIndex] = { username: user.username, color: user.nameColor, socketId: socket.id, credits: user.credits, hands: [{ cards: [], bet: 0, status: 'waiting', value: 0 }], currentHand: 0, kickAt: Date.now() + 7000 };
            if (room.status === 'waiting') room.status = 'betting'; emitGameState(roomId);
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
            if (betAmount >= 1000 && betAmount <= 100000) {
                const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + seat.username + '$', 'i'), credits: { $gte: betAmount } }, { $inc: { credits: -betAmount } }, { new: true });
                if (!updatedUser) return; seat.credits = updatedUser.credits; seat.hands[0].bet = betAmount; seat.kickAt = null; 
                await new Transaction({ username: updatedUser.username, type: getGameTitle(roomId), amount: -betAmount }).save();
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
                let prizes = [1000, 0, 0, 0, 5000, 10000]; prizes = prizes.sort(() => Math.random() - 0.5); let wonAmount = prizes[boxIndex]; if(typeof wonAmount !== 'number' || isNaN(wonAmount)) wonAmount = 0; user.lastRewardClaim = now;
                
                let wonItem = null;
                if (Math.random() > 0.8) { wonItem = "Gold VIP Token"; user.inventory.push(wonItem); }
                
                if (wonAmount > 0) { user.credits += wonAmount; await new Transaction({ username: user.username, type: 'DAILY REWARD', amount: wonAmount, status: 'completed' }).save(); } await user.save();
                const msLeft = new Date(now.getTime() + msIn24Hours).getTime() - now.getTime(); const cooldownSeconds = Math.floor(msLeft / 1000);
                
                socket.emit('reward_box_opened', { success: true, wonAmount, wonItem, allPrizes: prizes, credits: user.credits, cooldownSeconds });
                io.emit('credit_update', { username: user.username, credits: user.credits }); Object.keys(rooms).forEach(rId => { const seat = rooms[rId].seats.find(s => s && s.username === user.username); if(seat) { seat.credits = user.credits; emitGameState(rId); } });
            } else { socket.emit('reward_box_opened', { success: false, message: 'Cooldown active' }); }
        } catch (e) { socket.emit('reward_box_opened', { success: false, message: 'Server sync error' }); }
    });

    socket.on('disconnect', () => {
        const data = socketUserMap[socket.id];
        if (data) {
            if (data.arcadeGame) {
                let g = data.arcadeGame; let lobby;
                if(g === 'dice') { diceLobby = diceLobby.filter(p => p.username !== data.username); lobby = diceLobby; }
                else if(g === 'color') { colorLobby = colorLobby.filter(p => p.username !== data.username); lobby = colorLobby; }
                else if(g === 'derby') { derbyLobby = derbyLobby.filter(p => p.username !== data.username); lobby = derbyLobby; }
                else if(g === 'cups') { cupsLobby = cupsLobby.filter(p => p.username !== data.username); lobby = cupsLobby; }
                else if(g === 'pvp') { pvpLobby = pvpLobby.filter(p => p.username !== data.username); lobby = pvpLobby; const seatIdx = pvpDuel.seats.findIndex(s => s && s?.username.toLowerCase() === data.username.toLowerCase()); if(seatIdx !== -1) handlePvpLeave(seatIdx); }
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

// --- PVP ENGINE LOGIC ---
async function handlePvpLeave(seatIndex) {
    const seat = pvpDuel.seats[seatIndex]; 
    if(!seat) return;
    
    const wasActive = ['readying', 'flipping', 'spinning', 'resolving'].includes(pvpDuel.status);
    const betToRefund = pvpDuel.betAmount;
    const otherIndex = seatIndex === 0 ? 1 : 0; 
    const otherSeat = pvpDuel.seats[otherIndex];

    pvpDuel.status = 'waiting';
    pvpDuel.seats[seatIndex] = null;
    
    if(wasActive && betToRefund > 0) {
        Promise.all([
            refundPvpSeat(seat.username, betToRefund),
            otherSeat ? refundPvpSeat(otherSeat.username, betToRefund) : Promise.resolve()
        ]).then(() => {});
    }
    
    if(pvpDuel.seats[0] === null && pvpDuel.seats[1] === null) {
        pvpDuel = { seats: [null, null], status: 'waiting', type: 'coin', format: 1, betAmount: 0, slices: 4, hostIndex: -1, result: null, winSliceIndex: 0, message: 'WAITING FOR PLAYERS', timerInterval: null };
    } else {
        pvpDuel.hostIndex = pvpDuel.seats[0] !== null ? 0 : 1; 
        pvpDuel.message = 'CHALLENGER ABANDONED.'; 
        if(pvpDuel.seats[pvpDuel.hostIndex]) {
            pvpDuel.seats[pvpDuel.hostIndex].ready = false; 
            pvpDuel.seats[pvpDuel.hostIndex].score = 0;
            if (pvpDuel.type === 'wheel') { 
                pvpDuel.seats[pvpDuel.hostIndex].choice = pvpDuel.seats[pvpDuel.hostIndex].username; 
            }
        }
    }
    io.to('arcade_pvp').emit('pvp_duel_state_update', pvpDuel);
}

async function refundPvpSeat(username, amount) {
    const user = await User.findOneAndUpdate({ username: new RegExp('^' + username + '$', 'i') }, { $inc: { credits: amount } }, { new: true });
    if(user) { await new Transaction({ username: user.username, type: 'PVP REFUND', amount: amount }).save(); io.emit('credit_update', { username: user.username, credits: user.credits }); }
}

function runPvpSequence() {
    pvpDuel.timer = 3; 
    const actionVerb = pvpDuel.type === 'wheel' ? 'SPINNING' : 'FLIPPING'; 
    pvpDuel.message = `${actionVerb} IN 3...`; 
    io.to('arcade_pvp').emit('pvp_duel_state_update', pvpDuel);

    let countdown = setInterval(() => {
        if (pvpDuel.status === 'waiting' || !pvpDuel.seats[0] || !pvpDuel.seats[1]) { clearInterval(countdown); return; }

        pvpDuel.timer--;
        if(pvpDuel.timer > 0) { 
            pvpDuel.message = `${actionVerb} IN ${pvpDuel.timer}...`; io.to('arcade_pvp').emit('pvp_duel_state_update', pvpDuel); 
        } 
        else {
            clearInterval(countdown); pvpDuel.message = `${actionVerb}...`; io.to('arcade_pvp').emit('pvp_duel_state_update', pvpDuel);

            setTimeout(async () => {
                if (pvpDuel.status === 'waiting' || !pvpDuel.seats[0] || !pvpDuel.seats[1]) return;

                let res; 
                if(pvpDuel.type === 'coin') { 
                    res = Math.random() < 0.5 ? 'heads' : 'tails'; 
                } else { 
                    pvpDuel.winSliceIndex = Math.floor(Math.random() * pvpDuel.slices);
                    res = pvpDuel.winSliceIndex % 2 === 0 ? pvpDuel.seats[0].username : pvpDuel.seats[1].username;
                }
                pvpDuel.result = res; pvpDuel.status = 'resolving';
                
                let roundWinnerIndex = -1; 
                if(pvpDuel.seats[0]?.choice === res) roundWinnerIndex = 0; 
                if(pvpDuel.seats[1]?.choice === res) roundWinnerIndex = 1;
                
                if(roundWinnerIndex !== -1 && pvpDuel.seats[roundWinnerIndex]) { 
                    pvpDuel.seats[roundWinnerIndex].score++; pvpDuel.message = `${pvpDuel.seats[roundWinnerIndex].username.toUpperCase()} SCORES!`; 
                }
                io.to('arcade_pvp').emit('pvp_duel_state_update', pvpDuel);
                
                let matchWinner = null; 
                if(pvpDuel.seats[0] && pvpDuel.seats[0].score >= pvpDuel.format) matchWinner = 0; 
                if(pvpDuel.seats[1] && pvpDuel.seats[1].score >= pvpDuel.format) matchWinner = 1;
                
                setTimeout(async () => {
                    if (pvpDuel.status === 'waiting' || !pvpDuel.seats[0] || !pvpDuel.seats[1]) return;

                    if(matchWinner !== null && pvpDuel.seats[matchWinner]) {
                        pvpDuel.status = 'finished'; const winner = pvpDuel.seats[matchWinner]; pvpDuel.message = `${winner.username.toUpperCase()} WINS THE MATCH!`;

                        if(pvpDuel.betAmount > 0) {
                            const winAmount = pvpDuel.betAmount * 2;
                            try { 
                                const updatedUser = await User.findOneAndUpdate({ username: new RegExp('^' + winner.username + '$', 'i') }, { $inc: { credits: winAmount } }, {new: true}); 
                                if(updatedUser) { 
                                    await new Transaction({ username: updatedUser.username, type: 'PVP ARENA WIN', amount: winAmount }).save(); 
                                    io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); 
                                }
                            } catch(e){}
                        }
                        io.to('arcade_pvp').emit('pvp_duel_state_update', pvpDuel);
                        
                        setTimeout(() => {
                            if(pvpDuel.status === 'finished') {
                                pvpDuel = { seats: [null, null], status: 'waiting', type: 'coin', format: 1, betAmount: 0, slices: 4, hostIndex: -1, result: null, winSliceIndex: 0, message: 'WAITING FOR PLAYERS', timerInterval: null };
                                io.to('arcade_pvp').emit('pvp_duel_state_update', pvpDuel);
                            }
                        }, 3000);

                    } else { 
                        if(pvpDuel.status !== 'finished') { pvpDuel.status = pvpDuel.type === 'wheel' ? 'spinning' : 'flipping'; pvpDuel.result = null; runPvpSequence(); } 
                    }
                }, 3000);
            }, 2000);
        }
    }, 1000);
}

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
