const mongoose = require('mongoose');
const http = require('http');

// 1. Render üçün dinamik PORT
const PORT = process.env.PORT || 3000; 

// 2. HTTP Server və Socket.io yaradılması
const server = http.createServer();
const io = require('socket.io')(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling'] // Render üçün daha stabil bağlantı
});

// --- MONGODB BAĞLANTISI ---
const uri = "mongodb+srv://admin:123@cluster0.1xrr77f.mongodb.net/seka_game?retryWrites=true&w=majority";

mongoose.connect(uri)
    .then(() => console.log("✅ MongoDB-yə uğurla bağlanıldı"))
    .catch(err => console.error("❌ MongoDB bağlantı xətası:", err.message));

// İstifadəçi Modeli
const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    balance: { type: Number, default: 1000 }
});
const User = mongoose.model('User', UserSchema);

let rooms = {};
let turnTimers = {};

// --- KÖMƏKÇİ FUNKSİYALAR ---

// Balansı MongoDB-də artırıb-azaltmaq üçün funksiya
async function updateDbBalance(username, amount) {
    try {
        const user = await User.findOneAndUpdate(
            { username },
            { $inc: { balance: amount } },
            { new: true }
        );
        return user ? user.balance : 0;
    } catch (err) {
        console.error("Balans yeniləmə xətası:", err);
        return 0;
    }
}

function broadcastRoomList() {
    const list = Object.values(rooms).map(r => ({
        id: r.id,
        name: r.name,
        playersCount: r.players.length,
        status: r.status
    }));
    io.emit('update_room_list', list);
}

function calculateSekaScore(hand) {
    const tuses = hand.filter(c => c.value === 'T');
    if (tuses.length === 3) return 33;
    if (tuses.length === 2) return 22;
    let max = 0;
    ['Hearts', 'Spades', 'Clubs', 'Diamonds'].forEach(s => {
        const sum = hand.filter(c => c.suit === s).reduce((a, b) => a + b.score, 0);
        if (sum > max) max = sum;
    });
    return max;
}

function shuffleAndDeal(players) {
    const suits = ['Hearts', 'Spades', 'Clubs', 'Diamonds'];
    const values = [
        { v: '6', s: 6 }, { v: '7', s: 7 }, { v: '8', s: 8 },
        { v: '9', s: 9 }, { v: '10', s: 10 }, { v: 'B', s: 10 },
        { v: 'D', s: 10 }, { v: 'K', s: 10 }, { v: 'T', s: 11 }
    ];
    let deck = [];
    suits.forEach(suit => values.forEach(val => deck.push({ suit, value: val.v, score: val.s })));
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    players.forEach(p => {
        p.hand = [deck.pop(), deck.pop(), deck.pop()];
        p.score = calculateSekaScore(p.hand);
        p.status = 'active';
    });
}

// --- OYUNUN BİTMƏSİ ---
async function finishGame(roomId, winnerData = null) {
    const room = rooms[roomId];
    if (!room) return;

    let winner;
    const activeOnes = room.players.filter(p => p.status === 'active');
    
    if (winnerData) {
        winner = winnerData;
    } else {
        winner = activeOnes.sort((a, b) => b.score - a.score)[0];
    }

    // Qalibin balansını MongoDB-də artır
    const newBalance = await updateDbBalance(winner.username, room.totalBank);

    io.to(roomId).emit('game_over', {
        winner: winner.username,
        winAmount: room.totalBank,
        newBalance: newBalance,
        allHands: activeOnes.map(p => ({ username: p.username, hand: p.hand, score: p.score }))
    });

    room.status = 'waiting';
    room.totalBank = 0;
    room.lastBet = 0.20;
    room.players.forEach(p => p.status = 'waiting');
    if (turnTimers[roomId]) clearTimeout(turnTimers[roomId]);
    broadcastRoomList();
}

// --- SOCKET HADİSƏLƏRİ ---
io.on('connection', (socket) => {
    console.log("Yeni qoşulma:", socket.id);

    socket.on('join_room', async (data) => {
        console.log("Giriş cəhdi gəldi:", data.username);
        
        const timeout = setTimeout(() => {
            socket.emit('error_message', 'Baza bağlantısı gecikir. Atlas IP icazəsini yoxlayın.');
        }, 5000);

        try {
            let user = await User.findOne({ username: data.username });
            if (!user) {
                user = await User.create({ username: data.username, balance: 1000 });
                console.log("Yeni istifadəçi yaradıldı:", user.username);
            }
            
            clearTimeout(timeout);
            socket.emit('login_confirmed', user);
            broadcastRoomList();
            console.log("🚀 Giriş uğurludur:", user.username);

        } catch (err) {
            clearTimeout(timeout);
            console.error("Giriş xətası:", err.message);
            socket.emit('error_message', 'Sistem xətası: ' + err.message);
        }
    });

    socket.on('create_custom_room', (data) => {
        const roomId = "room_" + Date.now();
        rooms[roomId] = {
            id: roomId,
            name: data.roomName,
            creator: data.username,
            players: [],
            totalBank: 0,
            status: 'waiting',
            lastBet: 0.20,
            turnIndex: 0,
            startTimerActive: false
        };
        socket.emit('room_created_success', rooms[roomId]);
        broadcastRoomList();
    });

    socket.on('join_custom_room', (data) => {
        const room = rooms[data.roomId];
        if (room && room.status === 'waiting') {
            socket.join(data.roomId);
            if (!room.players.find(p => p.username === data.username)) {
                room.players.push({
                    username: data.username, id: socket.id,
                    status: 'waiting', hand: [], score: 0
                });
            }
            io.to(data.roomId).emit('player_joined', { players: room.players });
        }
    });

    // RAUNDA GİRİŞ (0.50 AZN ÖDƏMƏ)
    socket.on('enter_round', async (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        const player = room.players.find(p => p.username === data.username);

        if (player && player.status === 'waiting') {
            const currentDbUser = await User.findOne({ username: data.username });
            if (currentDbUser.balance < 0.50) {
                socket.emit('error_message', 'Balansınız kifayət deyil!');
                return;
            }

            const newBal = await updateDbBalance(data.username, -0.50);
            player.status = 'ready';
            room.totalBank = parseFloat((room.totalBank + 0.50).toFixed(2));

            io.to(data.roomId).emit('update_players', {
                players: room.players,
                totalBank: room.totalBank,
                username: data.username,
                newBalance: newBal
            });

            // 2 nəfər hazır olan kimi 10 saniyəlik geri sayım
            const readyPlayers = room.players.filter(p => p.status === 'ready');
            if (readyPlayers.length === 2 && !room.startTimerActive) {
                room.startTimerActive = true;
                let timeLeft = 10;
                const countdown = setInterval(() => {
                    io.to(data.roomId).emit('start_countdown', { timeLeft });
                    timeLeft--;
                    if (timeLeft < 0) {
                        clearInterval(countdown);
                        startSekaRound(data.roomId);
                    }
                }, 1000);
            }
        }
    });

    socket.on('make_move', async (data) => {
        const room = rooms[data.roomId];
        if (!room) return;

        if (data.moveType === 'raise') {
            const newBal = await updateDbBalance(data.username, -data.amount);
            room.totalBank = parseFloat((room.totalBank + data.amount).toFixed(2));
            socket.emit('balance_updated', { newBalance: newBal });
        }
        
        // Burda əvvəlki processMove məntiqi davam edir (növbə dəyişimi və s.)
    });
});

function startSekaRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.status = 'playing';
    room.startTimerActive = false;
    
    const participants = room.players.filter(p => p.status === 'ready');
    participants.forEach(p => p.status = 'active');
    
    shuffleAndDeal(participants);
    room.turnIndex = 0;

    io.to(roomId).emit('battle_start', {
        players: room.players,
        totalBank: room.totalBank,
        activePlayer: participants[0].username,
        lastBet: 0.20
    });
}

server.listen(PORT, () => {
    console.log(`🚀 Seka Server ${PORT} portunda aktivdir...`);
});
