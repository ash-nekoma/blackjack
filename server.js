require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// --- Middleware ---
app.use(express.json());
app.use(express.static(__dirname)); 

// --- Database Setup ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('MongoDB Connected via Railway Variables'))
    .catch(err => console.error('MongoDB connection error:', err));

const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // Plain text per request
    credits: { type: Number, default: 0 },
    ipAddress: { type: String },
    lastRewardClaim: { type: Date, default: null },
    tosAccepted: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);

// --- Game Engine State ---
const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

let gameState = {
    seats: [null, null, null, null, null], 
    dealerCards: [],
    deck: [],
    status: 'waiting', // waiting, betting, playing, dealerTurn, complete
    activeSeatIndex: -1
};

function getNewDeck() {
    let deck = [];
    for (let i = 0; i < 6; i++) {
        for (let suit of suits) {
            for (let value of values) {
                deck.push({ suit, value, weight: getCardWeight(value) });
            }
        }
    }
    return deck.sort(() => Math.random() - 0.5);
}

function getCardWeight(value) {
    if (['J', 'Q', 'K'].includes(value)) return 10;
    if (value === 'A') return 11;
    return parseInt(value);
}

function calculateHandValue(cards) {
    let value = 0; let aces = 0;
    for (let card of cards) { value += card.weight; if (card.value === 'A') aces += 1; }
    while (value > 21 && aces > 0) { value -= 10; aces -= 1; }
    return value;
}

// --- REST APIs (Auth & Admin) ---
app.post('/api/signup', async (req, res) => {
    try {
        const { username, password, tosAccepted } = req.body;
        if (!tosAccepted) return res.status(400).json({ error: 'ToS must be accepted' });
        
        const ipAddress = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const user = new User({ username, password, credits: 1000, ipAddress, tosAccepted });
        await user.save();
        res.status(201).json({ message: 'User created successfully', username: user.username });
    } catch (err) { res.status(400).json({ error: 'Username may already exist' }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username, password });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });
        res.json({ username: user.username, credits: user.credits, lastRewardClaim: user.lastRewardClaim });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find({}, '-password'); 
        res.json(users);
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/update_balance', async (req, res) => {
    try {
        const { username, newBalance } = req.body;
        await User.updateOne({ username }, { credits: newBalance });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// --- Socket.IO Real-time Logic ---
io.on('connection', (socket) => {
    socket.emit('game_state_update', gameState);

    socket.on('join_seat', async ({ username, seatIndex }) => {
        if (seatIndex < 0 || seatIndex > 4 || gameState.seats[seatIndex]) return;
        const user = await User.findOne({ username });
        if (!user) return;

        gameState.seats[seatIndex] = {
            username: user.username, socketId: socket.id, credits: user.credits,
            hands: [{ cards: [], bet: 0, status: 'waiting', value: 0 }], currentHand: 0
        };
        if (gameState.status === 'waiting') gameState.status = 'betting';
        io.emit('game_state_update', gameState);
    });

    socket.on('place_bet', async ({ seatIndex, betAmount }) => {
        const seat = gameState.seats[seatIndex];
        if (!seat || seat.socketId !== socket.id || gameState.status !== 'betting') return;
        
        if (seat.credits >= betAmount) {
            seat.hands[0].bet = betAmount;
            seat.credits -= betAmount;
            await User.updateOne({ username: seat.username }, { credits: seat.credits });
            
            if (gameState.seats.every(s => !s || s.hands[0].bet > 0)) startGame();
            io.emit('game_state_update', gameState);
        }
    });

    socket.on('claim_daily_reward', async ({ username }) => {
        const user = await User.findOne({ username });
        if (!user) return;
        const now = new Date();
        const lastClaim = user.lastRewardClaim ? new Date(user.lastRewardClaim) : new Date(0);
        if (Math.abs(now - lastClaim) / 36e5 >= 24) {
            user.credits += 500;
            user.lastRewardClaim = now;
            await user.save();
            socket.emit('reward_claimed', { success: true, credits: user.credits, nextClaim: new Date(now.getTime() + 24*60*60*1000) });
            const seat = gameState.seats.find(s => s && s.username === username);
            if(seat) { seat.credits = user.credits; io.emit('game_state_update', gameState); }
        } else {
            socket.emit('reward_claimed', { success: false, message: 'Cooldown active' });
        }
    });

    // Game Actions
    socket.on('player_action_hit', ({ seatIndex }) => {
        if (gameState.status !== 'playing' || gameState.activeSeatIndex !== seatIndex) return;
        const seat = gameState.seats[seatIndex];
        if (seat.socketId !== socket.id) return;

        const hand = seat.hands[seat.currentHand];
        hand.cards.push(gameState.deck.pop());
        hand.value = calculateHandValue(hand.cards);
        if (hand.value > 21) { hand.status = 'bust'; moveToNextTurn(); }
        io.emit('game_state_update', gameState);
    });

    socket.on('player_action_stand', ({ seatIndex }) => {
        if (gameState.status !== 'playing' || gameState.activeSeatIndex !== seatIndex) return;
        if (gameState.seats[seatIndex].socketId !== socket.id) return;
        gameState.seats[seatIndex].hands[gameState.seats[seatIndex].currentHand].status = 'stand';
        moveToNextTurn();
        io.emit('game_state_update', gameState);
    });

    socket.on('player_action_split', async ({ seatIndex }) => {
        if (gameState.status !== 'playing' || gameState.activeSeatIndex !== seatIndex) return;
        const seat = gameState.seats[seatIndex];
        if (seat.socketId !== socket.id) return;

        const hand = seat.hands[seat.currentHand];
        if (hand.cards.length === 2 && hand.cards[0].weight === 10 && hand.cards[1].weight === 10 && seat.credits >= hand.bet) {
            seat.credits -= hand.bet;
            await User.updateOne({ username: seat.username }, { credits: seat.credits });
            const newHand = { cards: [hand.cards.pop(), gameState.deck.pop()], bet: hand.bet, status: 'playing', value: 0 };
            hand.cards.push(gameState.deck.pop());
            hand.value = calculateHandValue(hand.cards);
            newHand.value = calculateHandValue(newHand.cards);
            seat.hands.push(newHand);
            io.emit('game_state_update', gameState);
        }
    });

    // Live Chat Broadcast
    socket.on('send_chat', (data) => {
        io.emit('receive_chat', { username: data.username, message: data.message });
    });

    socket.on('disconnect', () => {
        const seatIndex = gameState.seats.findIndex(s => s && s.socketId === socket.id);
        if (seatIndex !== -1 && gameState.status === 'waiting') {
            gameState.seats[seatIndex] = null;
            io.emit('game_state_update', gameState);
        }
    });
});

// --- Game Loop Functions ---
function startGame() {
    gameState.status = 'playing';
    gameState.deck = getNewDeck();
    gameState.dealerCards = [];

    for (let i = 0; i < 2; i++) {
        gameState.seats.forEach(seat => { if (seat && seat.hands[0].bet > 0) seat.hands[0].cards.push(gameState.deck.pop()); });
        gameState.dealerCards.push(gameState.deck.pop());
    }

    gameState.seats.forEach(seat => {
        if (seat && seat.hands[0].bet > 0) {
            seat.hands[0].value = calculateHandValue(seat.hands[0].cards);
            if(seat.hands[0].value === 21) seat.hands[0].status = 'blackjack';
        }
    });

    gameState.activeSeatIndex = gameState.seats.findIndex(s => s && s.hands[0].bet > 0 && s.hands[0].status === 'waiting');
    if (gameState.activeSeatIndex === -1) processDealerTurn(); 
}

function moveToNextTurn() {
    const seat = gameState.seats[gameState.activeSeatIndex];
    if (seat.currentHand < seat.hands.length - 1) { seat.currentHand++; return; }
    
    let nextIndex = gameState.activeSeatIndex + 1;
    while (nextIndex < 5 && (!gameState.seats[nextIndex] || gameState.seats[nextIndex].hands[0].bet === 0)) nextIndex++;
    if (nextIndex >= 5) processDealerTurn();
    else gameState.activeSeatIndex = nextIndex;
}

async function processDealerTurn() {
    gameState.status = 'dealerTurn';
    gameState.activeSeatIndex = -1;
    io.emit('game_state_update', gameState);

    let dealerValue = calculateHandValue(gameState.dealerCards);
    while (dealerValue < 17) {
        gameState.dealerCards.push(gameState.deck.pop());
        dealerValue = calculateHandValue(gameState.dealerCards);
    }
    resolveBets(dealerValue);
}

async function resolveBets(dealerValue) {
    gameState.status = 'resolving';
    for (const seat of gameState.seats) {
        if (seat) {
            for (const hand of seat.hands) {
                if (hand.bet > 0) {
                    let payout = 0;
                    if (hand.status === 'blackjack') payout = hand.bet * 2.5; 
                    else if (hand.status !== 'bust' && (dealerValue > 21 || hand.value > dealerValue)) payout = hand.bet * 2; 
                    else if (hand.status !== 'bust' && hand.value === dealerValue) payout = hand.bet; 

                    if (payout > 0) {
                        seat.credits += payout;
                        await User.updateOne({ username: seat.username }, { $inc: { credits: payout } });
                    }
                }
            }
            seat.hands = [{ cards: [], bet: 0, status: 'waiting', value: 0 }];
            seat.currentHand = 0;
        }
    }
    setTimeout(() => {
        gameState.dealerCards = [];
        gameState.status = 'waiting';
        io.emit('game_state_update', gameState);
    }, 5000); 
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
