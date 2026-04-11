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

// Added 'lobby' array to accurately track everyone in the room
let gameState = {
    seats: [null, null, null, null, null], dealerCards: [], deck: [],
    status: 'waiting', activeSeatIndex: -1, betEndTime: 0, nextRoundTime: 0, 
    lobby: [] 
};

const socketUserMap = {}; // Maps socket.id to username for disconnect cleanup

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

function emitGameState() {
    let safeState = JSON.parse(JSON.stringify(gameState));
    if (safeState.status === 'playing' && safeState.dealerCards.length > 1) safeState.dealerCards[1] = { hidden: true };
    io.emit('game_state_update', safeState);
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

// --- SOCKET LOGIC ---
let betTimerInterval = null;
let nextRoundInterval = null;

io.on('connection', (socket) => {
    
    // Accurate Lobby Tracking
    socket.on('enter_lobby', async ({ username }) => {
        socketUserMap[socket.id] = username;
        const user = await User.findOne({ username });
        if (user && !gameState.lobby.find(p => p.username === username)) {
            gameState.lobby.push({ username: user.username, color: user.nameColor });
        }
        emitGameState();
    });

    socket.on('join_seat', async ({ username, seatIndex }) => {
        if (seatIndex < 0 || seatIndex > 4 || gameState.seats[seatIndex]) return;
        const user = await User.findOne({ username });
        if (!user) return;
        gameState.seats[seatIndex] = { username: user.username, color: user.nameColor, credits: user.credits, hands: [{ cards: [], bet: 0, status: 'waiting', value: 0 }], currentHand: 0 };
        if (gameState.status === 'waiting') gameState.status = 'betting';
        emitGameState();
    });

    // Fixed: Uses username to verify leaving, avoiding socket ID bugs
    socket.on('leave_seat', ({ username, seatIndex }) => {
        if (gameState.seats[seatIndex] && gameState.seats[seatIndex].username === username) {
            gameState.seats[seatIndex] = null;
            if (gameState.seats.every(s => s === null)) { gameState.status = 'waiting'; clearInterval(betTimerInterval); }
            emitGameState();
        }
    });

    // Fixed: Validates by username payload
    socket.on('place_bet', async ({ username, seatIndex, betAmount }) => {
        const seat = gameState.seats[seatIndex];
        if (!seat || seat.username !== username || gameState.status !== 'betting') return;
        if (seat.credits >= betAmount) {
            seat.hands[0].bet = betAmount; seat.credits -= betAmount;
            await User.updateOne({ username: seat.username }, { credits: seat.credits });
            await new Transaction({ username: seat.username, type: 'bet placed', amount: -betAmount }).save();
            
            gameState.betEndTime = Date.now() + 15000;
            clearInterval(betTimerInterval);
            betTimerInterval = setInterval(() => { if (Date.now() >= gameState.betEndTime) { clearInterval(betTimerInterval); startGame(); } }, 1000);
            if (gameState.seats.every(s => !s || s.hands[0].bet > 0)) { clearInterval(betTimerInterval); startGame(); }
            else emitGameState();
        }
    });

    socket.on('player_action_hit', ({ username, seatIndex }) => {
        if (gameState.status !== 'playing' || gameState.activeSeatIndex !== seatIndex) return;
        const seat = gameState.seats[seatIndex]; if (seat.username !== username) return;
        const hand = seat.hands[seat.currentHand];
        hand.cards.push(gameState.deck.pop()); hand.value = calculateValue(hand.cards);
        if (hand.value > 21) { hand.status = 'bust'; moveToNextTurn(); }
        emitGameState();
    });

    socket.on('player_action_stand', ({ username, seatIndex }) => {
        if (gameState.status !== 'playing' || gameState.activeSeatIndex !== seatIndex) return;
        const seat = gameState.seats[seatIndex]; if (seat.username !== username) return;
        seat.hands[seat.currentHand].status = 'stand';
        moveToNextTurn(); emitGameState();
    });

    socket.on('player_action_double', async ({ username, seatIndex }) => {
        if (gameState.status !== 'playing' || gameState.activeSeatIndex !== seatIndex) return;
        const seat = gameState.seats[seatIndex]; if (seat.username !== username) return;
        const hand = seat.hands[seat.currentHand];
        if (hand.cards.length !== 2 || seat.credits < hand.bet) return; 

        seat.credits -= hand.bet; 
        await User.updateOne({ username: seat.username }, { credits: seat.credits });
        await new Transaction({ username: seat.username, type: 'double down', amount: -hand.bet }).save();
        hand.bet *= 2;
        
        hand.cards.push(gameState.deck.pop()); hand.value = calculateValue(hand.cards);
        if (hand.value > 21) hand.status = 'bust'; else hand.status = 'stand'; 
        moveToNextTurn(); emitGameState();
    });

    socket.on('player_action_split', async ({ username, seatIndex }) => {
        if (gameState.status !== 'playing' || gameState.activeSeatIndex !== seatIndex) return;
        const seat = gameState.seats[seatIndex]; if (seat.username !== username) return;
        const hand = seat.hands[seat.currentHand];
        if (hand.cards.length === 2 && hand.cards[0].weight === hand.cards[1].weight && seat.credits >= hand.bet) {
            seat.credits -= hand.bet;
            await User.updateOne({ username: seat.username }, { credits: seat.credits });
            await new Transaction({ username: seat.username, type: 'split bet', amount: -hand.bet }).save();
            const newHand = { cards: [hand.cards.pop(), gameState.deck.pop()], bet: hand.bet, status: 'playing', value: 0 };
            hand.cards.push(gameState.deck.pop()); hand.value = calculateValue(hand.cards); newHand.value = calculateValue(newHand.cards);
            seat.hands.push(newHand); emitGameState();
        }
    });

    socket.on('claim_daily_reward', async ({ username }) => {
        const user = await User.findOne({ username }); if (!user) return;
        const now = new Date(); const lastClaim = user.lastRewardClaim ? new Date(user.lastRewardClaim) : new Date(0);
        if (Math.abs(now - lastClaim) / 36e5 >= 24) {
            user.credits += 100000; user.lastRewardClaim = now; await user.save();
            await new Transaction({ username, type: 'daily reward', amount: 100000, status: 'completed' }).save();
            socket.emit('reward_claimed', { success: true, credits: user.credits, nextClaim: new Date(now.getTime() + 24*60*60*1000) });
            const seat = gameState.seats.find(s => s && s.username === username); if(seat) { seat.credits = user.credits; emitGameState(); }
        } else { socket.emit('reward_claimed', { success: false, message: 'Cooldown active' }); }
    });

    // Fixed chat payload logic
    socket.on('send_chat', ({ username, message }) => { if(username && message) io.emit('receive_chat', { username, message }); });

    socket.on('disconnect', () => {
        const username = socketUserMap[socket.id];
        if (username) {
            gameState.lobby = gameState.lobby.filter(p => p.username !== username);
            delete socketUserMap[socket.id];
        }
        // If they drop entirely, empty their seat
        const seatIndex = gameState.seats.findIndex(s => s && s.username === username);
        if (seatIndex !== -1) {
            gameState.seats[seatIndex] = null;
            if (gameState.seats.every(s => s === null)) { gameState.status = 'waiting'; clearInterval(betTimerInterval); }
        }
        emitGameState();
    });
});

function startGame() {
    gameState.status = 'playing'; gameState.deck = getNewDeck(); gameState.dealerCards = [];
    gameState.seats = gameState.seats.map(s => (s && s.hands[0].bet === 0) ? null : s);
    
    for (let i = 0; i < 2; i++) {
        gameState.seats.forEach(seat => { if (seat) seat.hands[0].cards.push(gameState.deck.pop()); });
        gameState.dealerCards.push(gameState.deck.pop());
    }
    
    gameState.seats.forEach(seat => { if (seat) { seat.hands[0].value = calculateValue(seat.hands[0].cards); if(seat.hands[0].value === 21) seat.hands[0].status = 'blackjack'; } });
    
    let dealerInitialValue = calculateValue(gameState.dealerCards);
    if (dealerInitialValue === 21) { resolveBets(21); return; }

    gameState.activeSeatIndex = gameState.seats.findIndex(s => s && s.hands[0].status === 'waiting');
    if (gameState.activeSeatIndex === -1) processDealerTurn(); else emitGameState();
}

function moveToNextTurn() {
    const seat = gameState.seats[gameState.activeSeatIndex];
    if (seat.currentHand < seat.hands.length - 1) { seat.currentHand++; return; }
    let nextIndex = gameState.activeSeatIndex + 1;
    while (nextIndex < 5 && !gameState.seats[nextIndex]) nextIndex++;
    if (nextIndex >= 5) processDealerTurn(); else { gameState.activeSeatIndex = nextIndex; emitGameState(); }
}

async function processDealerTurn() {
    gameState.status = 'dealerTurn'; gameState.activeSeatIndex = -1; emitGameState();
    let dealerValue = calculateValue(gameState.dealerCards);
    while (dealerValue < 17) { gameState.dealerCards.push(gameState.deck.pop()); dealerValue = calculateValue(gameState.dealerCards); }
    resolveBets(dealerValue);
}

async function resolveBets(dealerValue) {
    gameState.status = 'resolving'; 
    gameState.nextRoundTime = Date.now() + 5000; 

    for (const seat of gameState.seats) {
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
    
    emitGameState(); 
    clearInterval(nextRoundInterval);
    nextRoundInterval = setInterval(() => {
        if (Date.now() >= gameState.nextRoundTime) {
            clearInterval(nextRoundInterval);
            gameState.dealerCards = [];
            gameState.seats.forEach(seat => { if(seat) { seat.hands = [{ cards: [], bet: 0, status: 'waiting', value: 0 }]; seat.currentHand = 0; } });
            gameState.status = 'waiting'; emitGameState();
        }
    }, 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Casino Server Live on ${PORT}`));
