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

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('MongoDB Connected'))
    .catch(err => console.error('MongoDB error:', err));

const User = mongoose.model('User', new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    credits: { type: Number, default: 0 },
    status: { type: String, default: 'pending' }, 
    nameColor: { type: String, default: '#f8fafc' },
    ipAddress: String, tosAccepted: Boolean
}));

const Transaction = mongoose.model('Transaction', new mongoose.Schema({
    username: String, type: String, amount: Number,
    status: { type: String, default: 'completed' }, 
    date: { type: Date, default: Date.now }
}));

const GiftCode = mongoose.model('GiftCode', new mongoose.Schema({
    code: { type: String, unique: true }, amount: Number, usesLeft: Number
}));

const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// --- MULTI-ROOM SETUP ---
const rooms = {
    '3seat': createRoom(3),
    '5seat': createRoom(5)
};

function createRoom(numSeats) {
    return {
        seats: Array(numSeats).fill(null),
        dealerCards: [], deck: [],
        status: 'waiting', activeSeatIndex: -1, betEndTime: 0, nextRoundTime: 0, 
        lobby: [], betTimerInterval: null, nextRoundInterval: null
    };
}

const socketUserMap = {}; // Maps socket.id to { username, roomId }

function getNewDeck() {
    let deck = [];
    for (let i = 0; i < 6; i++) {
        for (let s of suits) for (let v of values) deck.push({ suit: s, value: v, weight: ['J','Q','K'].includes(v) ? 10 : (v==='A'?11:parseInt(v)) });
    }
    return deck.sort(() => Math.random() - 0.5);
}

function calculateValue(cards) {
    let val = 0; let aces = 0;
    cards.forEach(c => { val += c.weight; if(c.value==='A') aces++; });
    while(val > 21 && aces > 0) { val -= 10; aces--; } return val;
}

function emitGameState(roomId) {
    let room = rooms[roomId];
    if (!room) return;
    let safeState = JSON.parse(JSON.stringify(room));
    // Remove backend-only interval properties
    delete safeState.betTimerInterval; delete safeState.nextRoundInterval;
    
    if (safeState.status === 'playing' && safeState.dealerCards.length > 1) safeState.dealerCards[1] = { hidden: true };
    io.to(roomId).emit('game_state_update', safeState);
}

// --- REST APIs ---
app.post('/api/signup', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = new User({ username, password, tosAccepted: true });
        await user.save();
        res.status(201).json({ message: 'Account requested. Pending Admin Approval.' });
    } catch (err) { res.status(400).json({ error: 'Username taken.' }); }
});

app.post('/api/login', async (req, res) => {
    const user = await User.findOne({ username: req.body.username, password: req.body.password });
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });
    if (user.status === 'pending') return res.status(401).json({ error: 'Account pending admin approval.' });
    if (user.status === 'banned') return res.status(401).json({ error: 'Account banned.' });
    res.json({ username: user.username, credits: user.credits, nameColor: user.nameColor });
});

app.post('/api/profile/color', async (req, res) => { await User.updateOne({ username: req.body.username }, { nameColor: req.body.color }); res.json({ success: true }); });

app.post('/api/bank/request', async (req, res) => {
    const { username, type, amount } = req.body;
    if (amount < 100000) return res.status(400).json({ error: 'Minimum request is 100,000.' });
    if (type === 'deposit' && amount > 100000) return res.status(400).json({ error: 'Max deposit is 100,000 per request.' });
    
    if (type === 'withdrawal') {
        const user = await User.findOne({ username });
        if (user.credits < amount) return res.status(400).json({ error: 'Insufficient funds.' });
        await User.updateOne({ username }, { $inc: { credits: -amount } }); 
    }
    await new Transaction({ username, type: `${type} req`, amount, status: 'pending' }).save();
    res.json({ success: true });
});

app.post('/api/bank/giftcode', async (req, res) => {
    const { username, code } = req.body;
    const gc = await GiftCode.findOne({ code });
    if (!gc || gc.usesLeft <= 0) return res.status(400).json({ error: 'Invalid or expired code.' });
    await User.updateOne({ username }, { $inc: { credits: gc.amount } }); await GiftCode.updateOne({ code }, { $inc: { usesLeft: -1 } });
    await new Transaction({ username, type: 'giftcode', amount: gc.amount, status: 'completed' }).save();
    res.json({ success: true, amount: gc.amount });
});

app.get('/api/profile/ledger/:username', async (req, res) => {
    const txs = await Transaction.find({ username: req.params.username }).sort({ date: -1 }).limit(50); res.json(txs);
});

// --- ADMIN APIs ---
const checkAdmin = (req, res, next) => {
    if (req.headers['x-admin-pass'] !== process.env.ADMIN_PASS) return res.status(403).json({ error: 'Unauthorized' });
    next();
};

app.get('/api/admin/data', checkAdmin, async (req, res) => {
    const users = await User.find({}, '-password'); const txs = await Transaction.find({ status: 'pending' }); const codes = await GiftCode.find();
    res.json({ users, txs, codes });
});

app.post('/api/admin/user/status', checkAdmin, async (req, res) => { await User.updateOne({ username: req.body.username }, { status: req.body.status }); res.json({ success: true }); });

app.post('/api/admin/tx/resolve', checkAdmin, async (req, res) => {
    const { id, action } = req.body; const tx = await Transaction.findById(id);
    if (!tx || tx.status !== 'pending') return res.status(400).json({ error: 'Invalid TX' });
    if (action === 'approve') { tx.status = 'completed'; if (tx.type === 'deposit req') await User.updateOne({ username: tx.username }, { $inc: { credits: tx.amount } }); } 
    else { tx.status = 'denied'; if (tx.type === 'withdrawal req') await User.updateOne({ username: tx.username }, { $inc: { credits: tx.amount } }); }
    await tx.save(); res.json({ success: true });
});

app.post('/api/admin/giftcode', checkAdmin, async (req, res) => { await new GiftCode(req.body).save(); res.json({ success: true }); });

// --- SOCKET LOGIC ---

io.on('connection', (socket) => {
    
    socket.on('enter_room', async ({ username, roomId }) => {
        if (!rooms[roomId]) return;
        socket.join(roomId);
        socketUserMap[socket.id] = { username, roomId };
        const user = await User.findOne({ username });
        if (user && !rooms[roomId].lobby.find(p => p.username === username)) {
            rooms[roomId].lobby.push({ username: user.username, color: user.nameColor });
        }
        emitGameState(roomId);
    });

    socket.on('leave_room', ({ username, roomId }) => {
        let room = rooms[roomId]; if (!room) return;
        socket.leave(roomId);
        room.lobby = room.lobby.filter(p => p.username !== username);
        
        // Remove from seat if seated
        const seatIndex = room.seats.findIndex(s => s && s.username === username);
        if (seatIndex !== -1) {
            room.seats[seatIndex] = null;
            if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); }
        }
        if(socketUserMap[socket.id]) delete socketUserMap[socket.id];
        emitGameState(roomId);
    });

    socket.on('join_seat', async ({ roomId, username, seatIndex }) => {
        let room = rooms[roomId]; if (!room) return;
        if (room.seats.some(s => s && s.username === username)) return; // 1 SEAT LIMIT
        if (seatIndex < 0 || seatIndex >= room.seats.length || room.seats[seatIndex]) return;

        const user = await User.findOne({ username });
        if (!user) return;
        room.seats[seatIndex] = { username: user.username, color: user.nameColor, socketId: socket.id, credits: user.credits, hands: [{ cards: [], bet: 0, status: 'waiting', value: 0 }], currentHand: 0 };
        if (room.status === 'waiting') room.status = 'betting';
        emitGameState(roomId);
    });

    socket.on('leave_seat', ({ roomId, username, seatIndex }) => {
        let room = rooms[roomId]; if (!room) return;
        if (room.seats[seatIndex] && room.seats[seatIndex].username === username) {
            room.seats[seatIndex] = null;
            if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); }
            emitGameState(roomId);
        }
    });

    socket.on('place_bet', async ({ roomId, username, seatIndex, betAmount }) => {
        let room = rooms[roomId]; if (!room) return;
        const seat = room.seats[seatIndex];
        if (!seat || seat.username !== username || room.status !== 'betting') return;
        if (seat.credits >= betAmount) {
            seat.hands[0].bet = betAmount; seat.credits -= betAmount;
            await User.updateOne({ username: seat.username }, { credits: seat.credits });
            await new Transaction({ username: seat.username, type: 'bet placed', amount: -betAmount }).save();
            
            room.betEndTime = Date.now() + 15000;
            clearInterval(room.betTimerInterval);
            room.betTimerInterval = setInterval(() => { if (Date.now() >= room.betEndTime) { clearInterval(room.betTimerInterval); startGame(roomId); } }, 1000);
            
            if (room.seats.every(s => !s || s.hands[0].bet > 0)) { clearInterval(room.betTimerInterval); startGame(roomId); }
            else emitGameState(roomId);
        }
    });

    socket.on('player_action_hit', ({ roomId, username, seatIndex }) => {
        let room = rooms[roomId]; if (!room) return;
        if (room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return;
        const seat = room.seats[seatIndex]; if (seat.username !== username) return;
        const hand = seat.hands[seat.currentHand];
        hand.cards.push(room.deck.pop()); hand.value = calculateValue(hand.cards);
        if (hand.value > 21) { hand.status = 'bust'; moveToNextTurn(roomId); }
        emitGameState(roomId);
    });

    socket.on('player_action_stand', ({ roomId, username, seatIndex }) => {
        let room = rooms[roomId]; if (!room) return;
        if (room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return;
        const seat = room.seats[seatIndex]; if (seat.username !== username) return;
        seat.hands[seat.currentHand].status = 'stand';
        moveToNextTurn(roomId); emitGameState(roomId);
    });

    socket.on('player_action_double', async ({ roomId, username, seatIndex }) => {
        let room = rooms[roomId]; if (!room) return;
        if (room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return;
        const seat = room.seats[seatIndex]; if (seat.username !== username) return;
        const hand = seat.hands[seat.currentHand];
        if (hand.cards.length !== 2 || seat.credits < hand.bet) return; 

        seat.credits -= hand.bet; 
        await User.updateOne({ username: seat.username }, { credits: seat.credits });
        await new Transaction({ username: seat.username, type: 'double down', amount: -hand.bet }).save();
        hand.bet *= 2;
        
        hand.cards.push(room.deck.pop()); hand.value = calculateValue(hand.cards);
        if (hand.value > 21) hand.status = 'bust'; else hand.status = 'stand'; 
        moveToNextTurn(roomId); emitGameState(roomId);
    });

    socket.on('player_action_split', async ({ roomId, username, seatIndex }) => {
        let room = rooms[roomId]; if (!room) return;
        if (room.status !== 'playing' || room.activeSeatIndex !== seatIndex) return;
        const seat = room.seats[seatIndex]; if (seat.username !== username) return;
        const hand = seat.hands[seat.currentHand];
        if (hand.cards.length === 2 && hand.cards[0].weight === hand.cards[1].weight && seat.credits >= hand.bet) {
            seat.credits -= hand.bet;
            await User.updateOne({ username: seat.username }, { credits: seat.credits });
            await new Transaction({ username: seat.username, type: 'split bet', amount: -hand.bet }).save();
            const newHand = { cards: [hand.cards.pop(), room.deck.pop()], bet: hand.bet, status: 'playing', value: 0 };
            hand.cards.push(room.deck.pop()); hand.value = calculateValue(hand.cards); newHand.value = calculateValue(newHand.cards);
            seat.hands.push(newHand); emitGameState(roomId);
        }
    });

    socket.on('claim_daily_reward', async ({ username }) => {
        const user = await User.findOne({ username }); if (!user) return;
        const now = new Date(); const lastClaim = user.lastRewardClaim ? new Date(user.lastRewardClaim) : new Date(0);
        if (Math.abs(now - lastClaim) / 36e5 >= 24) {
            user.credits += 100000; user.lastRewardClaim = now; await user.save();
            await new Transaction({ username, type: 'daily reward', amount: 100000, status: 'completed' }).save();
            socket.emit('reward_claimed', { success: true, credits: user.credits, nextClaim: new Date(now.getTime() + 24*60*60*1000) });
            
            // Sync credits across all rooms if they are seated
            Object.keys(rooms).forEach(rId => {
                const seat = rooms[rId].seats.find(s => s && s.username === username); 
                if(seat) { seat.credits = user.credits; emitGameState(rId); }
            });
        } else { socket.emit('reward_claimed', { success: false, message: 'Cooldown active' }); }
    });

    socket.on('send_chat', ({ roomId, username, message }) => { 
        if(roomId && username && message) io.to(roomId).emit('receive_chat', { username, message }); 
    });

    socket.on('disconnect', () => {
        const data = socketUserMap[socket.id];
        if (data) {
            let room = rooms[data.roomId];
            if (room) {
                room.lobby = room.lobby.filter(p => p.username !== data.username);
                const seatIndex = room.seats.findIndex(s => s && s.username === data.username);
                if (seatIndex !== -1) {
                    room.seats[seatIndex] = null;
                    if (room.seats.every(s => s === null)) { room.status = 'waiting'; clearInterval(room.betTimerInterval); }
                }
                emitGameState(data.roomId);
            }
            delete socketUserMap[socket.id];
        }
    });
});

function startGame(roomId) {
    let room = rooms[roomId]; if (!room) return;
    room.status = 'playing'; room.deck = getNewDeck(); room.dealerCards = [];
    room.seats = room.seats.map(s => (s && s.hands[0].bet === 0) ? null : s);
    
    for (let i = 0; i < 2; i++) {
        room.seats.forEach(seat => { if (seat) seat.hands[0].cards.push(room.deck.pop()); });
        room.dealerCards.push(room.deck.pop());
    }
    
    room.seats.forEach(seat => { if (seat) { seat.hands[0].value = calculateValue(seat.hands[0].cards); if(seat.hands[0].value === 21) seat.hands[0].status = 'blackjack'; } });
    
    let dealerInitialValue = calculateValue(room.dealerCards);
    if (dealerInitialValue === 21) { resolveBets(roomId, 21); return; }

    room.activeSeatIndex = room.seats.findIndex(s => s && s.hands[0].status === 'waiting');
    if (room.activeSeatIndex === -1) processDealerTurn(roomId); else emitGameState(roomId);
}

function moveToNextTurn(roomId) {
    let room = rooms[roomId]; if (!room) return;
    const seat = room.seats[room.activeSeatIndex];
    if (seat.currentHand < seat.hands.length - 1) { seat.currentHand++; return; }
    let nextIndex = room.activeSeatIndex + 1;
    while (nextIndex < room.seats.length && !room.seats[nextIndex]) nextIndex++;
    if (nextIndex >= room.seats.length) processDealerTurn(roomId); else { room.activeSeatIndex = nextIndex; emitGameState(roomId); }
}

async function processDealerTurn(roomId) {
    let room = rooms[roomId]; if (!room) return;
    room.status = 'dealerTurn'; room.activeSeatIndex = -1; emitGameState(roomId);
    let dealerValue = calculateValue(room.dealerCards);
    while (dealerValue < 17) { room.dealerCards.push(room.deck.pop()); dealerValue = calculateValue(room.dealerCards); }
    resolveBets(roomId, dealerValue);
}

async function resolveBets(roomId, dealerValue) {
    let room = rooms[roomId]; if (!room) return;
    room.status = 'resolving'; 
    room.nextRoundTime = Date.now() + 5000; 

    for (const seat of room.seats) {
        if (seat) {
            for (const hand of seat.hands) {
                if (hand.bet > 0) {
                    let payout = 0;
                    if (hand.status === 'blackjack' && dealerValue !== 21) payout = hand.bet * 2.5; 
                    else if (hand.status !== 'bust' && (dealerValue > 21 || hand.value > dealerValue)) payout = hand.bet * 2; 
                    else if (hand.status !== 'bust' && hand.value === dealerValue) payout = hand.bet; 

                    if (payout > 0) {
                        seat.credits += payout;
                        await User.updateOne({ username: seat.username }, { $inc: { credits: payout } });
                        await new Transaction({ username: seat.username, type: payout === hand.bet ? 'push refund' : 'win payout', amount: payout }).save();
                    }
                }
            }
        }
    }
    
    emitGameState(roomId); 
    clearInterval(room.nextRoundInterval);
    room.nextRoundInterval = setInterval(() => {
        if (Date.now() >= room.nextRoundTime) {
            clearInterval(room.nextRoundInterval);
            room.dealerCards = [];
            room.seats.forEach(seat => { if(seat) { seat.hands = [{ cards: [], bet: 0, status: 'waiting', value: 0 }]; seat.currentHand = 0; } });
            room.status = 'waiting'; emitGameState(roomId);
        }
    }, 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino Server Live on ${PORT}`));
