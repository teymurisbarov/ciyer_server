const mongoose = require('mongoose');
const http = require('http');

const PORT = process.env.PORT || 3000; 
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Seka Server is Live!");
});

const io = require('socket.io')(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

const uri = "mongodb+srv://admin:123@cluster0.1xrr77f.mongodb.net/seka_game?retryWrites=true&w=majority";

mongoose.connect(uri)
    .then(() => console.log("✅ MongoDB-yə uğurla bağlanıldı"))
    .catch(err => console.error("❌ MongoDB bağlantı xətası:", err.message));

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    balance: { type: Number, default: 1000 }
});
const User = mongoose.model('User', UserSchema);

let rooms = {};
let turnTimers = {};

// --- KÖMƏKÇİ FUNKSİYALAR ---

function nextTurn(roomId) {
    const room = rooms[roomId];
    if (!room || room.status !== 'playing') return;

    const activePlayers = room.players.filter(p => p.status === 'active');
    if (activePlayers.length < 2) {
        finishGame(roomId, activePlayers[0]);
        return;
    }

    room.turnIndex = (room.turnIndex + 1) % activePlayers.length;
    const nextPlayer = activePlayers[room.turnIndex];

    if (turnTimers[roomId]) clearTimeout(turnTimers[roomId]);

    io.to(roomId).emit('next_turn', {
        activePlayer: nextPlayer.username,
        turnIndex: room.turnIndex,
        totalBank: room.totalBank,
        lastBet: room.lastBet
    });

    turnTimers[roomId] = setTimeout(() => {
    const activePlayers = room.players.filter(p => p.status === 'active');
    const currentPlayer = activePlayers[room.turnIndex];
    
    if (currentPlayer) {
        currentPlayer.status = 'folded'; // Vaxtı bitəni sıradan çıxar!
        io.to(roomId).emit('move_made', { username: currentPlayer.username, moveType: 'timeout_fold' });
        nextTurn(roomId); 
    }
}, 30000);
}

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
async function handleWin(roomId, winnerUsername, amount) {
    const commission = amount * 0.05;
    const finalAmount = amount - commission;
    const newBalance = await updateDbBalance(winnerUsername, finalAmount);
    return { newBalance, finalAmount };
}
function broadcastRooms() {
    const list = Object.values(rooms).map(r => ({
        id: r.id,
        name: r.name,
        playersCount: r.players.length,
        maxPlayers: r.maxPlayers,
        minBet: r.minBet,
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

// --- OYUN MƏNTİQİ ---

async function finishGame(roomId, winnerData = null) {
    const room = rooms[roomId];
    if (!room) return;
    if (turnTimers[roomId]) clearTimeout(turnTimers[roomId]);
    const activeOnes = room.players.filter(p => p.status === 'active');
    let winner = winnerData || room.players.filter(p => p.status === 'active').sort((a, b) => b.score - a.score)[0];
    if (!winnerData && activeOnes.length === 2 && activeOnes[0].score === activeOnes[1].score) {
        const commission = room.totalBank * 0.05; // 5% komissiya
        room.totalBank -= commission;
        
        io.to(roomId).emit('seka_event', { 
            message: "Xallar bərabərdir! Seka başladı.",
            newBank: room.totalBank,
            commission: commission
        });
        
        // Oyunçuları 'waiting' statusuna keçir, amma bankı sıfırlama!
        room.status = 'waiting'; 
        return; 
    }
    if (winner) {
        const { newBalance, finalAmount } = await handleWin(roomId, winner.username, room.totalBank);
        io.to(roomId).emit('game_over', {
            winner: winner.username,
            winAmount: finalAmount.toFixed(2),
            newBalance: newBalance,
            allHands: room.players.map(p => ({ username: p.username, hand: p.hand, score: p.score }))
        });
    }

    // Otağı sıfırla
    room.status = 'waiting';
    room.totalBank = 0;
    room.lastBet = room.minBet; // Otağın öz minBet-i
    room.players.forEach(p => { p.status = 'waiting'; p.hand = []; });
    broadcastRooms();
}

function startSekaRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    
    room.status = 'playing';
    room.startTimerActive = false;
    
    // 1. Hazır olan oyunçuları aktiv statusuna keçir
    room.players.forEach(p => {
        if (p.status === 'ready') {
            p.status = 'active';
        }
    });

    // 2. Aktiv oyunçuları tap
    const activePlayers = room.players.filter(p => p.status === 'active');
    
    // XƏTANIN DÜZƏLİŞİ: Burada 'participants' yox, 'activePlayers' olmalıdır
    shuffleAndDeal(activePlayers); 
    
    room.turnIndex = 0;

    console.log(`Oyun başladı: ${roomId}, Aktiv oyunçu sayı: ${activePlayers.length}`);

    // 3. Frontend-ə siqnal göndər
    io.to(roomId).emit('battle_start', {
        players: room.players,
        totalBank: room.totalBank,
        activePlayer: activePlayers[0].username,
        lastBet: 0.20
    });
}

// --- SOCKET HADİSƏLƏRİ ---
function emitRooms() {
    const roomList = Object.values(rooms).map(r => ({
        id: r.id,
        name: r.name,
        playersCount: r.players.length,
        maxPlayers: r.maxPlayers,
        minBet: r.minBet,
        status: r.status
    }));
    io.emit('update_room_list', roomList);
}

io.on('connection', (socket) => {
    socket.on('offer_response', async (data) => {
    const room = rooms[data.roomId];
    if (!room) return;

    if (data.accepted) {
        if (data.type === 'offer_split') {
            const activePlayers = room.players.filter(p => p.status === 'active');
            const half = parseFloat((room.totalBank / activePlayers.length).toFixed(2));

            for (let p of activePlayers) {
                await updateDbBalance(p.username, half);
            }

            io.to(data.roomId).emit('game_over', {
                winner: "BÖLÜNDÜ",
                winAmount: half,
                isSplit: true
            });
            finishGame(data.roomId, { username: "BÖLÜNDÜ" }); // Otağı sıfırla
        } else if (data.type === 'offer_seka') {
            // Seka qəbul ediləndə hər kəsdən yenidən pul çıxılır və ya yeni raund başlayır
            io.to(data.roomId).emit('seka_started');
            // Seka məntiqini bura əlavə edə bilərsən
        }
    } else {
        // Rədd edildisə, təklif göndərənə məlumat ver
        const sender = room.players.find(p => p.username !== data.username);
        if (sender) {
            io.to(sender.id).emit('error_message', 'Təklif rədd edildi.');
        }
    }
});
    socket.on('join_room', async (data) => {
        try {
            let user = await User.findOne({ username: data.username });
            if (!user) {
                user = await User.create({ username: data.username, balance: 1000 });
            }
            socket.emit('login_confirmed', user);
            broadcastRoomList();
        } catch (err) {
            socket.emit('error_message', 'Baza xətası: ' + err.message);
        }
    });

    socket.on('create_custom_room', (data) => {
        const id = "room_" + Date.now();
        rooms[id] = {
            id,
            name: data.roomName,
            maxPlayers: parseInt(data.maxPlayers) || 10,
            minBet: parseFloat(data.minBet) || 0.20,
            players: [],
            totalBank: 0,
            lastBet: parseFloat(data.minBet) || 0.20,
            status: 'waiting',
            turnIndex: 0
        };
        socket.emit('room_created_success', rooms[id]);
        emitRooms();
    });

    socket.on('join_custom_room', (data) => {
        const room = rooms[data.roomId];
        if (room) {
        // Əgər eyni adla kimsə artıq otaqdadırsa, köhnəni sil (təkrarlanma olmasın)
        room.players = room.players.filter(p => p.username !== data.username);
        if (room && room.players.length < room.maxPlayers) {
            const newUser = {
                username: data.username,
                id: socket.id,
                status: 'waiting',
                hand: [],
                score: 0
            };
            room.players.push({
                username: data.username,
                id: socket.id,
                status: 'waiting'
            });
            socket.join(data.roomId);
            socket.emit('room_joined_success', room);
            io.to(data.roomId).emit('player_joined', { players: room.players });
            emitRooms();
            broadcastRooms();
        } else {
            socket.emit('error_msg', 'Otaq doludur!');
        }
    }
    });
    socket.on('leave_room', (data) => {
    const room = rooms[data.roomId];
    if (room) {
        // Oyunçunu otaqdan sil
        room.players = room.players.filter(p => p.username !== data.username);
        socket.leave(data.roomId);

        // ƏGƏR OTAQDA HEÇ KİM QALMAYIBSA - OTAĞI SİL
        if (room.players.length === 0) {
            delete rooms[data.roomId];
            console.log(`Otaq silindi: ${data.roomId}`);
        } else {
            io.to(data.roomId).emit('update_players', { players: room.players });
        }
        broadcastRooms(); // Hamıya otağın silindiyini və ya sayın azaldığını bildir
    }
});

    socket.on('enter_round', async (data) => {
        const room = rooms[data.roomId];
        if (!room) return;
        const player = room.players.find(p => p.username === data.username);
        const entryFee = room.minBet; // Otağın öz limiti
        if (player && player.status === 'waiting') {
        const currentDbUser = await User.findOne({ username: data.username });
        if (!currentDbUser || currentDbUser.balance < entryFee) {
            socket.emit('error_message', 'Balans kifayət deyil!');
            return;
        }

            const newBal = await updateDbBalance(data.username, -entryFee);
        player.status = 'ready';
        room.totalBank = parseFloat((room.totalBank + entryFee).toFixed(2));
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
socket.on('disconnect', () => {
    // Oyunçu qəfil çıxanda bütün otaqları yoxla
    Object.keys(rooms).forEach(roomId => {
        const room = rooms[roomId];
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        if (pIndex !== -1) {
            room.players.splice(pIndex, 1);
            if (room.players.length === 0) {
                delete rooms[roomId];
            } else {
                io.to(roomId).emit('update_players', { players: room.players });
            }
        }
    });
    broadcastRooms();
});
    socket.on('make_move', async (data) => {
    const room = rooms[data.roomId];
    if (!room) return;

    const activePlayers = room.players.filter(p => p.status === 'active');
    const currentPlayer = activePlayers[room.turnIndex];

    // 1. PAS (İstənilən vaxt, növbə gözləmədən)
    if (data.moveType === 'pass' || data.moveType === 'fold') {
        const p = room.players.find(u => u.username === data.username);
        if (p) {
            p.status = 'folded';
            io.to(data.roomId).emit('move_made', { username: data.username, moveType: 'fold' });
            
            const rem = room.players.filter(p => p.status === 'active');
            if (rem.length === 1) return finishGame(data.roomId, rem[0]);
            if (currentPlayer && currentPlayer.username === data.username) nextTurn(data.roomId);
        }
        return;
    }

    // 2. NÖVBƏLİ GEDİŞLƏR (Mərc, Seka, 50/50, Aç)
    if (!currentPlayer || currentPlayer.username !== data.username) return;

    if (data.moveType === 'raise') {
        const amount = parseFloat(data.amount);
        if (amount < room.lastBet) return socket.emit('error_message', 'Minimum mərcdən az qoymaq olmaz!');
        
        await updateDbBalance(data.username, -amount);
        room.totalBank += amount;
        room.lastBet = amount;
        
        io.to(data.roomId).emit('update_game_state', { totalBank: room.totalBank, lastBet: room.lastBet, activePlayer: data.username });
        nextTurn(data.roomId);
    } 
    else if (data.moveType === 'offer_seka' || data.moveType === 'offer_split') {
        const opponent = activePlayers.find(p => p.username !== data.username);
        if (opponent) {
            io.to(opponent.id).emit('offer_received', { type: data.moveType, from: data.username });
        }
    }
    else if (data.moveType === 'show') {
        // Kartları aç və müqayisə et
        const p1 = activePlayers[0];
        const p2 = activePlayers[1];
        
        if (p1.score === p2.score) {
            // SEKA MƏNTİQİ: Xallar bərabərdirsə, pul ortada qalır, raund yenidən başlayır
            io.to(data.roomId).emit('seka_event', { message: "Xallar bərabərdir! SEKA başladı!" });
            // Burada otağı sıfırlayıb amma bankı saxlayan məntiq qurulur...
        } else {
            finishGame(data.roomId);
        }
    }
});
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Seka Server ${PORT} portunda aktivdir...`);
});
