const mongoose = require('mongoose');
const http = require('http');
// 1. RENDER ÜÇÜN PORT VƏ SERVER AYARLARI
const PORT = process.env.PORT || 3000; 
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Seka Server is Live!");
});

const io = require('socket.io')(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

// 2. MONGODB BAĞLANTISI
const uri = "mongodb+srv://admin:123@cluster0.1xrr77f.mongodb.net/seka_game?retryWrites=true&w=majority";

mongoose.connect(uri)
    .then(() => console.log("✅ MongoDB-yə uğurla bağlanıldı"))
    .catch(err => console.error("❌ MongoDB bağlantı xətası:", err.message));

// 3. MODELLƏR VƏ GLOBAL DƏYİŞƏNLƏR
const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    balance: { type: Number, default: 1000 }
});
const User = mongoose.model('User', UserSchema);

let rooms = {};
let turnTimers = {};

// --- KÖMƏKÇİ FUNKSİYALAR ---

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
        maxPlayers: r.maxPlayers, // Otağın öz limitini göndər
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
    
    // Shuffle
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

// --- OYUN MƏNTİQİ ---

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

    if (winner) {
        const newBalance = await updateDbBalance(winner.username, room.totalBank);
        io.to(roomId).emit('game_over', {
            winner: winner.username,
            winAmount: room.totalBank,
            newBalance: newBalance,
            allHands: activeOnes.map(p => ({ username: p.username, hand: p.hand, score: p.score }))
        });
    }

    room.status = 'waiting';
    room.totalBank = 0;
    room.lastBet = 0.20;
    room.players.forEach(p => p.status = 'waiting');
    if (turnTimers[roomId]) clearTimeout(turnTimers[roomId]);
    broadcastRoomList();
}

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

// --- SOCKET HADİSƏLƏRİ ---

io.on('connection', (socket) => {
    console.log("Bağlantı quruldu:", socket.id);

    socket.on('join_room', async (data) => {
        try {
            let user = await User.findOne({ username: data.username });
            if (!user) {
                user = await User.create({ username: data.username, balance: 1000 });
            }
            socket.emit('login_confirmed', user);
            broadcastRoomList();
            console.log("🚀 Giriş:", user.username);
        } catch (err) {
            socket.emit('error_message', 'Baza xətası: ' + err.message);
        }
    });

    socket.on('create_custom_room', (data) => {
    const roomId = "room_" + Date.now();
    rooms[roomId] = {
        id: roomId,
        name: data.roomName,
        creator: data.username,
        players: [], 
        maxPlayers: data.maxPlayers || 4, // Limiti burda saxlayırıq
        totalBank: 0,
        status: 'waiting',
        lastBet: 0.20
    };
        socket.emit('room_created_success', rooms[roomId]);
    broadcastRoomList(); // İndi 1/4 (və ya 1/2) görsənəcək
});

    socket.on('join_custom_room', (data) => {
    const room = rooms[data.roomId];
    if (room && room.status === 'waiting') {
        if (room.players.length >= room.maxPlayers) {
            socket.emit('error_message', 'Otaq doludur!');
            return;
        }
            // Socket-i otaq kanalına əlavə edirik
            socket.join(data.roomId);
        if (!room.players.find(p => p.username === data.username)) {
            room.players.push({
                username: data.username,
                id: socket.id,
                status: 'waiting',
                hand: [],
                score: 0
            });
        } 
            // Oyunçu artıq siyahıda yoxdursa əlavə et
            const existingPlayer = room.players.find(p => p.username === data.username);
            if (!existingPlayer) {
                room.players.push({
                    username: data.username,
                    id: socket.id,
                    status: 'waiting',
                    hand: [],
                    score: 0
                });
                console.log(`${data.username} otağa (${room.name}) qoşuldu.`);
            }

            // Otaqdakı HƏR KƏSƏ (həm qoşulana, həm ordakılara) yeni siyahını göndər
            io.to(data.roomId).emit('player_joined', { 
                players: room.players,
                maxPlayers: 4 // Limiti frontend-ə də bildiririk
            });

            // Ümumi otaq siyahısını (Lobby-dəkilər üçün) yeniləyirik
            broadcastRoomList(); // Lobby-də say yenilənsin (məs: 2/4)
        } else {
            socket.emit('error_message', 'Otaq tapılmadı və ya oyun artıq başlayıb.');
        }
    });

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

            const readyPlayers = room.players.filter(p => p.status === 'ready');
            if (readyPlayers.length >= 2 && !room.startTimerActive) {
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
        // Növbəti gediş məntiqləri bura...
    });
});

// 4. SERVERİ BAŞLAT
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Seka Server ${PORT} portunda aktivdir...`);
});
