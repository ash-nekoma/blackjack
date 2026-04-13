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
mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log('MongoDB Connected Successfully');
        const adminConfig = await SystemConfig.findOne({ configName: 'admin_password' });
        if (!adminConfig) {
            const initialPassword = process.env.ADMIN_PASSWORD || 'admin123';
            await new SystemConfig({ configName: 'admin_password', configValue: initialPassword }).save();
            console.log('SYSTEM LOG: Admin Password securely generated and stored in Database.');
        }
    })
    .catch(err => console.error('MongoDB connection error:', err));

// --- DATABASE SCHEMAS ---
const SystemConfig = mongoose.model('SystemConfig', new mongoose.Schema({ configName: { type: String, unique: true }, configValue: { type: String } }));
const User = mongoose.model('User', new mongoose.Schema({
    username: { type: String, required: true, unique: true }, password: { type: String, required: true },
    credits: { type: Number, default: 0 }, status: { type: String, default: 'pending' }, 
    nameColor: { type: String, default: '#f8fafc' }, ipAddress: String, tosAccepted: Boolean,
    lastRewardClaim: { type: Date, default: null }, createdAt: { type: Date, default: Date.now }
}));
const Transaction = mongoose.model('Transaction', new mongoose.Schema({
    username: String, type: String, amount: Number, status: { type: String, default: 'completed' }, date: { type: Date, default: Date.now }
}));
const GiftCode = mongoose.model('GiftCode', new mongoose.Schema({ code: { type: String, unique: true }, amount: Number, usesLeft: Number }));

// --- GAME LOGIC GLOBALS ---
const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades']; const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const rooms = { '3seat': createRoom(3), '5seat': createRoom(5) };

function createRoom(numSeats) {
    return {
        seats: Array(numSeats).fill(null), dealerCards: [], deck: [], status: 'waiting', activeSeatIndex: -1, betEndTime: 0, nextRoundTime: 0, turnEndTime: 0,
        lobby: [], betTimerInterval: null, nextRoundInterval: null, turnTimerInterval: null, dealerInterval: null
    };
}

const diceGame = { status: 'betting', betEndTime: Date.now() + 15000, dice: [1, 1], bets: [], history: [] };
const coinGame = { status: 'betting', betEndTime: Date.now() + 15000, result: 'heads', bets: [], history: [] };
const PERYA_COLORS = ['red', 'blue', 'yellow', 'green', 'pink', 'white'];
const colorGame = { status: 'betting', betEndTime: Date.now() + 15000, dice: ['red', 'blue', 'yellow'], bets: [], history: [] };

const socketUserMap = {}; let diceLobby = []; let coinLobby = []; let colorLobby = [];

// GAME LOOPS
setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(roomId => {
        let room = rooms[roomId]; let changed = false;
        room.seats.forEach((seat, i) => { if (seat && seat.kickAt && now >= seat.kickAt) { room.seats[i] = null; changed = true; } });
        if (changed) { if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } emitGameState(roomId); }
    });
}, 1000);

setInterval(() => {
    const now = Date.now();
    
    // DICE LOOP
    if (diceGame.status === 'betting' && now >= diceGame.betEndTime) {
        diceGame.status = 'rolling'; io.to('arcade_dice').emit('dice_state_update', { status: diceGame.status, timeLeft: 0, history: diceGame.history });
        setTimeout(async () => {
            diceGame.dice = [Math.floor(Math.random() * 6) + 1, Math.floor(Math.random() * 6) + 1]; const total = diceGame.dice[0] + diceGame.dice[1];
            diceGame.status = 'resolving'; diceGame.history.unshift(total); if(diceGame.history.length > 10) diceGame.history.pop();
            let winners = [];
            for (let b of diceGame.bets) {
                let won = false; let payout = 0;
                if (b.choice === 'under' && total < 7) { won = true; payout = b.amount * 2; }
                if (b.choice === 'over' && total > 7) { won = true; payout = b.amount * 2; }
                if (b.choice === 'seven' && total === 7) { won = true; payout = b.amount * 5; }
                if (won) {
                    await User.updateOne({ username: b.username }, { $inc: { credits: payout } }); await new Transaction({ username: b.username, type: 'HIGH-LOW DICE', amount: payout }).save();
                    winners.push({ username: b.username, choice: b.choice, amount: payout });
                }
            }
            io.to('arcade_dice').emit('dice_state_update', { status: diceGame.status, dice: diceGame.dice, total, winners, bets: diceGame.bets, history: diceGame.history });
            setTimeout(() => { diceGame.bets = []; diceGame.status = 'betting'; diceGame.betEndTime = Date.now() + 15000; io.to('arcade_dice').emit('dice_state_update', { status: diceGame.status, betEndTime: diceGame.betEndTime, history: diceGame.history }); }, 5000);
        }, 3000); 
    }

    // COIN LOOP
    if (coinGame.status === 'betting' && now >= coinGame.betEndTime) {
        coinGame.status = 'flipping'; io.to('arcade_coin').emit('coin_state_update', { status: coinGame.status, timeLeft: 0, history: coinGame.history });
        setTimeout(async () => {
            coinGame.result = Math.random() < 0.5 ? 'heads' : 'tails';
            coinGame.status = 'resolving'; coinGame.history.unshift(coinGame.result); if(coinGame.history.length > 10) coinGame.history.pop();
            let winners = [];
            for (let b of coinGame.bets) {
                if (b.choice === coinGame.result) {
                    const payout = b.amount * 2;
                    await User.updateOne({ username: b.username }, { $inc: { credits: payout } }); await new Transaction({ username: b.username, type: 'COIN FLIP', amount: payout }).save();
                    winners.push({ username: b.username, choice: b.choice, amount: payout });
                }
            }
            io.to('arcade_coin').emit('coin_state_update', { status: coinGame.status, result: coinGame.result, winners, bets: coinGame.bets, history: coinGame.history });
            setTimeout(() => { coinGame.bets = []; coinGame.status = 'betting'; coinGame.betEndTime = Date.now() + 15000; io.to('arcade_coin').emit('coin_state_update', { status: coinGame.status, betEndTime: coinGame.betEndTime, history: coinGame.history }); }, 5000);
        }, 3000); 
    }

    // COLOR GAME LOOP
    if (colorGame.status === 'betting' && now >= colorGame.betEndTime) {
        colorGame.status = 'rolling'; io.to('arcade_color').emit('color_state_update', { status: colorGame.status, timeLeft: 0, history: colorGame.history });
        setTimeout(async () => {
            colorGame.dice = [ PERYA_COLORS[Math.floor(Math.random() * 6)], PERYA_COLORS[Math.floor(Math.random() * 6)], PERYA_COLORS[Math.floor(Math.random() * 6)] ];
            colorGame.status = 'resolving'; colorGame.history.unshift(colorGame.dice); if(colorGame.history.length > 8) colorGame.history.pop();
            let winners = [];
            for (let b of colorGame.bets) {
                let matches = colorGame.dice.filter(c => c === b.choice).length;
                if (matches > 0) {
                    const payout = b.amount + (b.amount * matches);
                    await User.updateOne({ username: b.username }, { $inc: { credits: payout } }); await new Transaction({ username: b.username, type: 'COLOR GAME', amount: payout }).save();
                    winners.push({ username: b.username, choice: b.choice, amount: payout });
                }
            }
            io.to('arcade_color').emit('color_state_update', { status: colorGame.status, dice: colorGame.dice, winners, bets: colorGame.bets, history: colorGame.history });
            setTimeout(() => { colorGame.bets = []; colorGame.status = 'betting'; colorGame.betEndTime = Date.now() + 15000; io.to('arcade_color').emit('color_state_update', { status: colorGame.status, betEndTime: colorGame.betEndTime, history: colorGame.history }); }, 5000);
        }, 3000); 
    }
}, 1000);

function getNewDeck() { let deck = []; for (let i = 0; i < 6; i++) { for (let s of suits) for (let v of values) deck.push({ suit: s, value: v, weight: ['J','Q','K'].includes(v) ? 10 : (v==='A'?11:parseInt(v)) }); } return deck.sort(() => Math.random() - 0.5); }
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

// --- ADMIN SECURITY ---
const checkAdmin = async (req, res, next) => {
    try {
        const adminConfig = await SystemConfig.findOne({ configName: 'admin_password' });
        if (!adminConfig || !adminConfig.configValue) return res.status(500).json({ error: 'System Error: Admin credentials not found in Database.' });
        if (req.headers['x-admin-pass'] !== adminConfig.configValue) return res.status(403).json({ error: 'Unauthorized' });
        next();
    } catch (error) { res.status(500).json({ error: 'Database Error' }); }
};

app.get('/api/admin/data', checkAdmin, async (req, res) => { const users = await User.find({}, '-password'); const txs = await Transaction.find({ status: 'pending' }); const codes = await GiftCode.find(); res.json({ users, txs, codes }); });
app.post('/api/admin/user/status', checkAdmin, async (req, res) => { await User.updateOne({ username: req.body.username }, { status: req.body.status }); res.json({ success: true }); });

// LIVE BANKING SYNC
app.post('/api/admin/tx/resolve', checkAdmin, async (req, res) => {
    const { id, action } = req.body; const tx = await Transaction.findById(id); if (!tx || tx.status !== 'pending') return res.status(400).json({ error: 'Invalid TX' });
    let updatedUser;
    if (action === 'approve') { tx.status = 'completed'; if (tx.type === 'BANK DEPOSIT') { updatedUser = await User.findOneAndUpdate({ username: tx.username }, { $inc: { credits: tx.amount } }, { new: true }); } } 
    else { tx.status = 'denied'; if (tx.type === 'BANK WITHDRAWAL') { updatedUser = await User.findOneAndUpdate({ username: tx.username }, { $inc: { credits: tx.amount } }, { new: true }); } }
    await tx.save(); if(updatedUser) io.emit('credit_update', { username: updatedUser.username, credits: updatedUser.credits }); res.json({ success: true });
});
app.post('/api/admin/giftcode', checkAdmin, async (req, res) => { await new GiftCode(req.body).save(); res.json({ success: true }); });

// --- APIs ---
app.post('/api/signup', async (req, res) => { try { await new User({ username: req.body.username, password: req.body.password, tosAccepted: true }).save(); res.status(201).json({ message: 'Account requested. Pending Admin Approval.' }); } catch (err) { res.status(400).json({ error: 'Username taken.' }); } });
app.post('/api/login', async (req, res) => {
    const user = await User.findOne({ username: req.body.username, password: req.body.password });
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' }); if (user.status === 'pending') return res.status(401).json({ error: 'Account pending admin approval.' }); if (user.status === 'banned') return res.status(401).json({ error: 'Account banned.' });
    const now = new Date(); const lastClaim = user.lastRewardClaim ? new Date(user.lastRewardClaim) : new Date(0); const msLeft = new Date(lastClaim.getTime() + 24 * 60 * 60 * 1000).getTime() - now.getTime();
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
    await new Transaction({ username, type: txType, amount, status: 'pending' }).save(); res.json({ success: true, newCredits: currentCredits });
});

app.post('/api/bank/giftcode', async (req, res) => {
    const { username, code } = req.body; const gc = await GiftCode.findOneAndUpdate({ code, usesLeft: { $gt: 0 } }, { $inc: { usesLeft: -1 } });
    if (!gc) return res.status(400).json({ error: 'Invalid or expired code.' });
    await User.updateOne({ username }, { $inc: { credits: gc.amount } }); await new Transaction({ username, type: 'GIFT CODE', amount: gc.amount, status: 'completed' }).save();
    res.json({ success: true, amount: gc.amount });
});

app.get('/api/profile/ledger/:username', async (req, res) => { const txs = await Transaction.find({ username: req.params.username }).sort({ date: -1 }).limit(50); res.json(txs); });

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    
    socket.on('enter_arcade', async ({ username, game }) => {
        const user = await User.findOne({ username }); if (!user) return;
        socket.join('arcade_' + game); socketUserMap[socket.id] = { username, arcadeGame: game, roomId: game };
        let lobby = game === 'dice' ? diceLobby : (game === 'color' ? colorLobby : coinLobby);
        if (!lobby.find(p => p.username === username)) lobby.push({ username, color: user.nameColor });
        io.to('arcade_' + game).emit('arcade_lobby_update', { game, lobby });
    });

    socket.on('leave_arcade', ({ username, game }) => {
        socket.leave('arcade_' + game);
        let lobby = game === 'dice' ? diceLobby : (game === 'color' ? colorLobby : coinLobby);
        lobby = lobby.filter(p => p.username !== username);
        if(game === 'dice') diceLobby = lobby; else if (game === 'color') colorLobby = lobby; else coinLobby = lobby;
        if(socketUserMap[socket.id]) { delete socketUserMap[socket.id].arcadeGame; delete socketUserMap[socket.id].roomId; }
        io.to('arcade_' + game).emit('arcade_lobby_update', { game, lobby });
    });

    socket.on('send_chat', ({ roomId, username, message }) => { 
        if(roomId && username && message) {
            if (['dice', 'coin', 'color'].includes(roomId)) io.to('arcade_' + roomId).emit('receive_chat', { roomId, username, message });
            else io.to(roomId).emit('receive_chat', { roomId, username, message }); 
        }
    });

    // --- ARCADE BETS ---
    socket.on('get_dice_state', () => { socket.emit('dice_state_update', { status: diceGame.status, betEndTime: diceGame.betEndTime, history: diceGame.history }); });
    socket.on('place_dice_bet', async ({ username, choice, amount }) => {
        if (diceGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are closed!');
        if (amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');
        let existingBet = diceGame.bets.filter(b=>b.username===username && b.choice===choice).reduce((sum,b)=>sum+b.amount,0);
        if(existingBet + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');

        const user = await User.findOneAndUpdate({ username, credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
        if (!user) return socket.emit('arcade_error', 'Insufficient credits');
        await new Transaction({ username, type: 'HIGH-LOW DICE', amount: -amount }).save();
        diceGame.bets.push({ username, choice, amount }); socket.emit('arcade_bet_placed', { game: 'dice', credits: user.credits, choice, totalChoiceBet: existingBet + amount });
    });

    socket.on('get_coin_state', () => { socket.emit('coin_state_update', { status: coinGame.status, betEndTime: coinGame.betEndTime, history: coinGame.history }); });
    socket.on('place_coin_bet', async ({ username, choice, amount }) => {
        if (coinGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are closed!');
        if (amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');
        let existingBet = coinGame.bets.filter(b=>b.username===username && b.choice===choice).reduce((sum,b)=>sum+b.amount,0);
        if(existingBet + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');

        const user = await User.findOneAndUpdate({ username, credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
        if (!user) return socket.emit('arcade_error', 'Insufficient credits');
        await new Transaction({ username, type: 'COIN FLIP', amount: -amount }).save();
        coinGame.bets.push({ username, choice, amount }); socket.emit('arcade_bet_placed', { game: 'coin', credits: user.credits, choice, totalChoiceBet: existingBet + amount });
    });

    socket.on('get_color_state', () => { socket.emit('color_state_update', { status: colorGame.status, betEndTime: colorGame.betEndTime, history: colorGame.history }); });
    socket.on('place_color_bet', async ({ username, choice, amount }) => {
        if (colorGame.status !== 'betting') return socket.emit('arcade_error', 'Bets are closed!');
        if (amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');
        let existingBet = colorGame.bets.filter(b=>b.username===username && b.choice===choice).reduce((sum,b)=>sum+b.amount,0);
        if(existingBet + amount > 50000) return socket.emit('arcade_error', 'Limit is 50,000 per tile!');

        const user = await User.findOneAndUpdate({ username, credits: { $gte: amount } }, { $inc: { credits: -amount } }, { new: true });
        if (!user) return socket.emit('arcade_error', 'Insufficient credits');
        await new Transaction({ username, type: 'COLOR GAME', amount: -amount }).save();
        colorGame.bets.push({ username, choice, amount }); socket.emit('arcade_bet_placed', { game: 'color', credits: user.credits, choice, totalChoiceBet: existingBet + amount });
    });

    // --- BLACKJACK SOCKETS ---
    socket.on('enter_room', async ({ username, roomId }) => {
        if (!rooms[roomId]) return; socket.join(roomId); socketUserMap[socket.id] = { username, roomId };
        const user = await User.findOne({ username }); if (user && !rooms[roomId].lobby.find(p => p.username === username)) rooms[roomId].lobby.push({ username: user.username, color: user.nameColor }); emitGameState(roomId);
    });
    socket.on('leave_room', ({ username, roomId }) => {
        let room = rooms[roomId]; if (!room) return; socket.leave(roomId); room.lobby = room.lobby.filter(p => p.username !== username);
        const seatIndex = room.seats.findIndex(s => s && s.username === username);
        if (seatIndex !== -1) { room.seats[seatIndex] = null; if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } }
        if(socketUserMap[socket.id]) delete socketUserMap[socket.id]; emitGameState(roomId);
    });
    socket.on('join_seat', async ({ roomId, username, seatIndex }) => {
        let room = rooms[roomId]; if (!room || room.seats.some(s => s && s.username === username) || seatIndex < 0 || seatIndex >= room.seats.length || room.seats[seatIndex]) return;
        const user = await User.findOne({ username }); if (!user) return;
        room.seats[seatIndex] = { username: user.username, color: user.nameColor, socketId: socket.id, credits: user.credits, hands: [{ cards: [], bet: 0, status: 'waiting', value: 0 }], currentHand: 0, kickAt: Date.now() + 7000 };
        if (room.status === 'waiting') room.status = 'betting'; emitGameState(roomId);
    });
    socket.on('leave_seat', ({ roomId, username, seatIndex }) => {
        let room = rooms[roomId]; if (!room) return;
        if (room.seats[seatIndex] && room.seats[seatIndex].username === username) { room.seats[seatIndex] = null; if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); } emitGameState(roomId); }
    });
    socket.on('place_bet', async ({ roomId, username, seatIndex, betAmount }) => {
        let room = rooms[roomId]; if (!room) return; const seat = room.seats[seatIndex]; if (!seat || seat.username !== username || room.status !== 'betting') return;
        if (betAmount >= 1000 && betAmount <= 50000) {
            const updatedUser = await User.findOneAndUpdate({ username: seat.username, credits: { $gte: betAmount } }, { $inc: { credits: -betAmount } }, { new: true });
            if (!updatedUser) return; 
            seat.credits = updatedUser.credits; seat.hands[0].bet = betAmount; seat.kickAt = null; await new Transaction({ username: seat.username, type: getGameTitle(roomId), amount: -betAmount }).save();
            room.betEndTime = Date.now() + 15000; clearInterval(room.betTimerInterval);
            if (room.seats.every(s => s !== null && s.hands[0].bet > 0)) { clearInterval(room.betTimerInterval); startGame(roomId); } 
            else { room.betTimerInterval = setInterval(() => { if (Date.now() >= room.betEndTime) { clearInterval(room.betTimerInterval); startGame(roomId); } }, 1000); emitGameState(roomId); }
        }
    });

    socket.on('player_action_hit', ({ roomId, username, seatIndex }) => { let room = rooms[roomId]; if (!room || room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return; const seat = room.seats[seatIndex]; const hand = seat.hands[seat.currentHand]; if (seat.username !== username || hand.status !== 'waiting') return; hand.cards.push(room.deck.pop()); hand.value = calculateValue(hand.cards); if (hand.value > 21) { hand.status = 'bust'; hand.result = 'bust'; moveToNextTurn(roomId); } else if (hand.value === 21) { hand.status = 'stand'; moveToNextTurn(roomId); } else { room.turnEndTime = Date.now() + 15000; startTurnTimer(roomId); emitGameState(roomId); } });
    socket.on('player_action_stand', ({ roomId, username, seatIndex }) => { let room = rooms[roomId]; if (!room || room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return; const seat = room.seats[seatIndex]; const hand = seat.hands[seat.currentHand]; if (seat.username !== username || hand.status !== 'waiting') return; hand.status = 'stand'; moveToNextTurn(roomId); });
    socket.on('player_action_double', async ({ roomId, username, seatIndex }) => { let room = rooms[roomId]; if (!room || room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return; const seat = room.seats[seatIndex]; const hand = seat.hands[seat.currentHand]; if (seat.username !== username || hand.status !== 'waiting' || hand.cards.length !== 2) return; const updatedUser = await User.findOneAndUpdate({ username: seat.username, credits: { $gte: hand.bet } }, { $inc: { credits: -hand.bet } }, { new: true }); if (!updatedUser) return; seat.credits = updatedUser.credits; await new Transaction({ username: seat.username, type: getGameTitle(roomId), amount: -hand.bet }).save(); hand.bet *= 2; hand.cards.push(room.deck.pop()); hand.value = calculateValue(hand.cards); if (hand.value > 21) { hand.status = 'bust'; hand.result = 'bust'; } else { hand.status = 'stand'; } moveToNextTurn(roomId); });
    socket.on('player_action_split', async ({ roomId, username, seatIndex }) => { let room = rooms[roomId]; if (!room || room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return; const seat = room.seats[seatIndex]; if (seat.username !== username || seat.hands.length >= 2) return; const hand = seat.hands[seat.currentHand]; if (hand.status !== 'waiting' || hand.cards.length !== 2) return; if (hand.cards[0].weight === hand.cards[1].weight) { const updatedUser = await User.findOneAndUpdate({ username: seat.username, credits: { $gte: hand.bet } }, { $inc: { credits: -hand.bet } }, { new: true }); if (!updatedUser) return; seat.credits = updatedUser.credits; await new Transaction({ username: seat.username, type: getGameTitle(roomId), amount: -hand.bet }).save(); const splitCard = hand.cards.pop(); const newHand = { cards: [splitCard], bet: hand.bet, status: 'waiting', value: 0 }; hand.cards.push(room.deck.pop()); newHand.cards.push(room.deck.pop()); hand.value = calculateValue(hand.cards); newHand.value = calculateValue(newHand.cards); if(hand.value === 21) hand.status = 'stand'; if(newHand.value === 21) newHand.status = 'stand'; seat.hands.push(newHand); if(hand.status === 'stand') moveToNextTurn(roomId); else { room.turnEndTime = Date.now() + 15000; startTurnTimer(roomId); emitGameState(roomId); } } });

    socket.on('claim_daily_reward_box', async ({ username, boxIndex }) => {
        try {
            const user = await User.findOne({ username }); if (!user) return; const now = new Date(); const lastClaim = user.lastRewardClaim ? new Date(user.lastRewardClaim) : new Date(0); const msIn24Hours = 24 * 60 * 60 * 1000;
            if (now.getTime() - lastClaim.getTime() >= msIn24Hours) {
                let prizes = [1000, 0, 0, 0, 5000, 10000]; prizes = prizes.sort(() => Math.random() - 0.5); const wonAmount = prizes[boxIndex]; user.lastRewardClaim = now;
                if (wonAmount > 0) { user.credits += wonAmount; await new Transaction({ username, type: 'DAILY REWARD', amount: wonAmount, status: 'completed' }).save(); } await user.save();
                const msLeft = new Date(now.getTime() + msIn24Hours).getTime() - now.getTime(); const cooldownSeconds = Math.floor(msLeft / 1000);
                socket.emit('reward_box_opened', { success: true, wonAmount, allPrizes: prizes, credits: user.credits, cooldownSeconds });
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
                    if (hand.status === 'blackjack' && dealerValue !== 21) { payout = hand.bet * 2.5; hand.result = 'win-bj'; } else if (hand.status !== 'bust' && (dealerValue > 21 || hand.value > dealerValue)) { payout = hand.bet * 2; hand.result = 'win'; } else if (hand.status !== 'bust' && hand.value === dealerValue) { payout = hand.bet; hand.result = 'push'; } else if (hand.status === 'bust') { hand.result = 'bust'; } else { hand.result = 'lose'; }
                    if (payout > 0) { seat.credits += payout; await User.updateOne({ username: seat.username }, { $inc: { credits: payout } }); await new Transaction({ username: seat.username, type: getGameTitle(roomId), amount: payout }).save(); }
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
