const io = require('socket.io')(3000, {
    cors: { origin: "*" }
});

let rooms = {}; 
let turnTimers = {}; 
let users = []; 

// Otaq siyahısını bütün istifadəçilərə yeniləyir
function broadcastRoomList() {
    const roomList = Object.values(rooms).map(r => ({
        id: r.id, 
        name: r.name, 
        players: r.players.length, 
        maxPlayers: r.maxPlayers, 
        status: r.status
    }));
    io.emit('update_room_list', roomList);
}

// --- 1. SEKA OYUN MƏNTİQİ ---
function shuffleAndDeal(players) {
    const suits = ['Hearts', 'Spades', 'Clubs', 'Diamonds'];
    const values = [
        { v: '6', s: 6 }, { v: '7', s: 7 }, { v: '8', s: 8 }, 
        { v: '9', s: 9 }, { v: '10', s: 10 }, { v: 'B', s: 10 }, 
        { v: 'D', s: 10 }, { v: 'K', s: 10 }, { v: 'T', s: 11 }
    ];
    let deck = [];
    suits.forEach(suit => values.forEach(val => deck.push({ suit, value: val.v, score: val.s })));
    
    // Shuffle (Qarışdırmaq)
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

function calculateSekaScore(hand) {
    const tuses = hand.filter(c => c.value === 'T');
    if (tuses.length === 3) return 33;
    if (tuses.length === 2) return 22;
    const suits = ['Hearts', 'Spades', 'Clubs', 'Diamonds'];
    let maxScore = 0;
    suits.forEach(s => {
        const suitSum = hand.filter(c => c.suit === s).reduce((sum, c) => sum + c.score, 0);
        if (suitSum > maxScore) maxScore = suitSum;
    });
    return maxScore;
}

// --- 2. OYUNUN BİTMƏSİ VƏ NÖVBƏ İDARƏSİ ---
function finishGame(roomId, winnerData = null) {
    const room = rooms[roomId];
    if (!room) return;

    let winner;
    if (winnerData) {
        winner = winnerData;
    } else {
        // Yalnız aktiv qalanlar arasında müqayisə apar
        const contenders = room.players.filter(p => p.status === 'active');
        winner = contenders.sort((a, b) => b.score - a.score)[0];
    }

    io.to(roomId).emit('game_over', { 
        winner: winner.username || winner.name, 
        score: winner.score || 0, 
        totalBank: room.totalBank,
        allHands: room.players.filter(p => p.status === 'active').map(p => ({
            username: p.username,
            hand: p.hand,
            score: p.score
        }))
    });

    room.status = 'waiting';
    room.lastBet = 0.20; // Oyun bitəndə mərci sıfırla
    if (turnTimers[roomId]) clearTimeout(turnTimers[roomId]);
    broadcastRoomList();
}

function startTurnTimer(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (turnTimers[roomId]) clearTimeout(turnTimers[roomId]);
    
    const activePlayer = room.players[room.turnIndex];
    if (!activePlayer) return;

    turnTimers[roomId] = setTimeout(() => {
        processMove(roomId, activePlayer.username, 'pass');
    }, 30500); 
}

function finalizeTurn(roomId, lastActionType = '') {
    const room = rooms[roomId];
    let nextIndex = (room.turnIndex + 1) % room.players.length;
    let loop = 0;
    
    while (room.players[nextIndex].status !== 'active' && loop < room.players.length) {
        nextIndex = (nextIndex + 1) % room.players.length;
        loop++;
    }
    room.turnIndex = nextIndex;

    const activeCount = room.players.filter(p => p.status === 'active').length;
    
    if (activeCount <= 1) {
        finishGame(roomId);
    } else {
        io.to(roomId).emit('update_game_state', {
            players: room.players,
            totalBank: room.totalBank,
            activePlayer: room.players[room.turnIndex].username,
            lastBet: room.lastBet,
            lastAction: lastActionType // React tərəfində 10s taymeri üçün
        });
        startTurnTimer(roomId);
    }
}

// --- 3. HƏRƏKƏTLƏRİN EMALI ---
function processMove(roomId, username, moveType, amount = 0) {
    const room = rooms[roomId];
    if (!room || room.status !== 'playing') return;

    const player = room.players.find(p => p.username === username);
    if (!player || room.players[room.turnIndex].username !== username) return;

    if (turnTimers[roomId]) clearTimeout(turnTimers[roomId]);

    if (moveType === 'offer_seka' || moveType === 'offer_split') {
        const opponent = room.players.find(p => p.username !== username && p.status === 'active');
        if (opponent) {
            io.to(opponent.id).emit('offer_received', { type: moveType, from: username });
            return; 
        }
    }

    if (moveType === 'pass') {
        player.status = 'pass';
    } else if (moveType === 'raise') {
        room.lastBet = amount;
        room.totalBank = parseFloat((room.totalBank + amount).toFixed(2));
    } else if (moveType === 'show') {
        finishGame(roomId);
        return;
    }

    finalizeTurn(roomId, moveType);
}

// --- 4. SOCKET BAĞLANTISI ---
io.on('connection', (socket) => {

    socket.on('join_room', (data) => {
        const user = users.find(u => u.username === data.username) || { username: data.username, balance: 1000 };
        socket.emit('login_confirmed', user);
        broadcastRoomList();
    });

    socket.on('create_custom_room', (data) => {
        const roomId = "room_" + Date.now();
        rooms[roomId] = {
            id: roomId,
            name: data.roomName,
            creator: data.username,
            maxPlayers: data.maxPlayers || 10,
            players: [{ username: data.username, id: socket.id, hand: [], score: 0, status: 'waiting' }],
            totalBank: 0,
            turnIndex: 0,
            lastBet: 0.20,
            status: 'waiting'
        };
        socket.join(roomId);
        socket.emit('room_created_success', rooms[roomId]);
        broadcastRoomList();
    });

    socket.on('join_custom_room', (data) => {
        const { roomId, username } = data;
        const room = rooms[roomId];
        if (room && room.players.length < room.maxPlayers && room.status === 'waiting') {
            socket.join(roomId);
            room.players.push({ username, id: socket.id, hand: [], score: 0, status: 'waiting' });
            socket.emit('room_joined_success', room);
            io.to(roomId).emit('player_joined', { players: room.players });
            broadcastRoomList();
        }
    });

    socket.on('start_game_manual', (data) => {
        const room = rooms[data.roomId];
        if (room && room.players.length >= 2) {
            room.status = 'playing';
            room.totalBank = parseFloat((room.players.length * 0.50).toFixed(2));
            room.lastBet = 0.20; // Hər yeni raund minimal mərcdən başlayır
            
            shuffleAndDeal(room.players);
            room.turnIndex = 0;
            
            io.to(data.roomId).emit('battle_start', {
                players: room.players,
                totalBank: room.totalBank,
                activePlayer: room.players[0].username,
                lastBet: room.lastBet
            });
            broadcastRoomList();
            startTurnTimer(data.roomId);
        }
    });

    socket.on('make_move', (data) => {
        processMove(data.roomId, data.username, data.moveType, data.amount);
    });

    socket.on('respond_to_offer', (data) => {
        const { roomId, type, accepted } = data;
        const room = rooms[roomId];
        if (!room) return;

        if (accepted) {
            if (type === 'offer_split') {
                const activeOnes = room.players.filter(p => p.status === 'active');
                const winAmt = (room.totalBank / activeOnes.length).toFixed(2);
                finishGame(roomId, { name: 'BÖLGÜ 🤝', score: `Hərəyə ${winAmt} AZN` });
            } else if (type === 'offer_seka') {
                // SEKA: Kartlar yenidən paylanır, mərc sıfırlanır (0.20), bank qalır
                room.lastBet = 0.20;
                shuffleAndDeal(room.players.filter(p => p.status === 'active'));
                
                io.to(roomId).emit('battle_start', {
                    players: room.players,
                    totalBank: room.totalBank,
                    activePlayer: room.players[room.turnIndex].username,
                    lastBet: room.lastBet
                });
                startTurnTimer(roomId);
            }
        } else {
            // Təklif rədd edildisə oyuna davam
            finalizeTurn(roomId, 'offer_rejected');
        }
    });

    socket.on('disconnect', () => {
        // Otaqdan çıxan oyunçunu təmizləmək istəsən bura yaza bilərsən
    });
});

console.log('Seka Server v2.0 (10s Karti De + Reset Bet) 3000 portunda aktivdir...');
