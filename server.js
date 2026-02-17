const io = require('socket.io')(3000, {
    cors: { origin: "*" }
});

let rooms = {}; 
let turnTimers = {}; 

// --- KÖMƏKÇİ FUNKSİYALAR (Seka Məntiqi) ---
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

// Otaq siyahısını hamıya göndərən funksiya
function broadcastRoomList() {
    const list = Object.values(rooms).map(r => ({
        id: r.id,
        name: r.name,
        players: r.players,
        maxPlayers: r.maxPlayers,
        status: r.status,
        creator: r.creator
    }));
    io.emit('update_room_list', list);
}

// --- SOCKET BAĞLANTISI ---
io.on('connection', (socket) => {
    console.log('Yeni bağlantı:', socket.id);

    // 1. Aktiv otaqları istəyəndə
    socket.on('get_active_rooms', () => {
        broadcastRoomList();
    });

    // 2. Toy Başlat (Otaq Yarat)
    socket.on('create_custom_room', (data) => {
        const roomId = `room_${Date.now()}`;
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
        console.log(`Otaq yarandı: ${data.roomName}`);
        
        // Yaradana uğur mesajı
        socket.emit('room_created_success', rooms[roomId]);
        broadcastRoomList();
    });

    // 3. Otağa Qoşul
    socket.on('join_custom_room', (data) => {
        const { roomId, username } = data;
        const room = rooms[roomId];

        if (room && room.players.length < room.maxPlayers) {
            socket.join(roomId);
            room.players.push({ username, id: socket.id, hand: [], score: 0, status: 'waiting' });
            
            socket.emit('room_joined_success', {
                room: roomId,
                players: room.players,
                name: room.name,
                creator: room.creator,
                maxPlayers: room.maxPlayers
            });

            io.to(roomId).emit('player_joined', { players: room.players });
            broadcastRoomList();
        }
    });

    // 4. Oyunu Başlat (Creator tərəfindən)
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
            // 30 saniyəlik timer-i başlat (startTurnTimer funksiyasını bura əlavə edə bilərsən)
        }
    });

    socket.on('disconnect', () => {
        console.log('Oyunçu ayrıldı.');
        // Burada otaqdan silmə məntiqi yazıla bilər
    });
});

console.log('Server 3000 portunda işləyir...');
