const io = require('socket.io')(3000, {
    cors: { origin: "*" }
});

let rooms = {}; 
let turnTimers = {}; 

// --- 1. SEKA OYUN MƏNTİQİ (Sənin yazdığın funksiyalar) ---

function shuffleAndDeal(players) {
    const suits = ['Hearts', 'Spades', 'Clubs', 'Diamonds'];
    const values = [
        { v: '6', s: 6 }, { v: '7', s: 7 }, { v: '8', s: 8 }, 
        { v: '9', s: 9 }, { v: '10', s: 10 }, { v: 'B', s: 10 }, 
        { v: 'D', s: 10 }, { v: 'K', s: 10 }, { v: 'T', s: 11 }
    ];
    
    let deck = [];
    suits.forEach(suit => {
        values.forEach(val => {
            deck.push({ suit: suit, value: val.v, score: val.s });
        });
    });

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
    
    const valGroup = hand[0].value === hand[1].value && hand[1].value === hand[2].value;
    if (valGroup) {
        const tripleScore = hand[0].value === '6' ? 32 : (hand[0].score * 3);
        if (tripleScore > maxScore) maxScore = tripleScore;
    }
    return maxScore;
}

// --- 2. TAYMER VƏ HƏRƏKƏT İDARƏSİ ---

function startTurnTimer(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (turnTimers[roomId]) clearTimeout(turnTimers[roomId]);

    const activePlayer = room.players[room.turnIndex];
    turnTimers[roomId] = setTimeout(() => {
        console.log(`Vaxt bitdi: ${activePlayer.username}`);
        processMove(roomId, activePlayer.username, 'pass');
    }, 30000); 
}

function processMove(roomId, username, moveType) {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.username === username);
    if (!player || room.players[room.turnIndex].username !== username) return;

    if (moveType === 'pass') {
        player.status = 'pass';
    } else if (moveType === 'raise') {
        room.totalBank += 10;
    }

    let nextIndex = (room.turnIndex + 1) % room.players.length;
    while (room.players[nextIndex].status === 'pass' && room.players.filter(p => p.status === 'active').length > 1) {
        nextIndex = (nextIndex + 1) % room.players.length;
    }
    room.turnIndex = nextIndex;

    const activeCount = room.players.filter(p => p.status === 'active').length;
    if (activeCount <= 1 || moveType === 'show') {
        const winner = room.players.sort((a, b) => b.score - a.score)[0];
        io.to(roomId).emit('game_over', { winner: winner.username, score: winner.score });
        clearTimeout(turnTimers[roomId]);
    } else {
        io.to(roomId).emit('update_game_state', {
            players: room.players,
            totalBank: room.totalBank,
            activePlayer: room.players[room.turnIndex].username
        });
        startTurnTimer(roomId);
    }
}

// --- 3. SOCKET BAĞLANTISI (Login və Lobby Birləşdirildi) ---

io.on('connection', (socket) => {
    console.log('Yeni qoşulma:', socket.id);

    // Login hadisəsi
    socket.on('join_room', (data) => {
        const { username } = data;
        console.log(`Giriş: ${username}`);
        socket.emit('login_confirmed', { username, balance: 1000 });
        
        // Mövcud otaqları göndər
        const roomList = Object.values(rooms).map(r => ({
            id: r.id, name: r.name, players: r.players, maxPlayers: r.maxPlayers
        }));
        socket.emit('update_room_list', roomList);
    });

    // Otaq yaratmaq
    socket.on('create_custom_room', (data) => {
        const roomId = "room_" + Date.now();
        rooms[roomId] = {
            id: roomId,
            name: data.roomName,
            creator: data.username,
            maxPlayers: data.maxPlayers,
            players: [{ username: data.username, id: socket.id, hand: [], score: 0, status: 'waiting' }],
            totalBank: 0,
            turnIndex: 0,
            status: 'waiting'
        };
        socket.join(roomId);
        socket.emit('room_created_success', rooms[roomId]);
        io.emit('update_room_list', Object.values(rooms));
    });

    // Otağa qoşulmaq
    socket.on('join_custom_room', (data) => {
        const { roomId, username } = data;
        if (rooms[roomId] && rooms[roomId].players.length < rooms[roomId].maxPlayers) {
            socket.join(roomId);
            rooms[roomId].players.push({ username, id: socket.id, hand: [], score: 0, status: 'waiting' });
            socket.emit('room_joined_success', rooms[roomId]);
            io.to(roomId).emit('player_joined', { players: rooms[roomId].players });
            io.emit('update_room_list', Object.values(rooms));
        }
    });

    // Oyunu başlatmaq
    socket.on('start_game_manual', (data) => {
        const room = rooms[data.roomId];
        if (room && room.creator === data.username) {
            room.status = 'playing';
            room.totalBank = room.players.length * 5;
            shuffleAndDeal(room.players);
            room.turnIndex = 0;
            io.to(data.roomId).emit('battle_start', {
                players: room.players,
                totalBank: room.totalBank,
                activePlayer: room.players[0].username,
                roomId: data.roomId
            });
            startTurnTimer(data.roomId);
        }
    });

    socket.on('make_move', (data) => {
        processMove(data.roomId, data.username, data.moveType);
    });

    socket.on('disconnect', () => {
        console.log('Oyunçu ayrıldı');
    });
});

console.log('Seka Server 3000 portunda aktivdir...');
