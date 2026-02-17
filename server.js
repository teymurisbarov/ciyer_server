const io = require('socket.io')(3000, {
    cors: { origin: "*" }
});

let rooms = {}; // Otaqların məlumatı
let turnTimers = {}; // Hər otaq üçün aktiv taymerlər

// --- KÖMƏKÇİ FUNKSİYALAR ---

// Kartları qarışdır və payla (36 kartlıq Seka dəstəsi)
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
            // Hər bir kart obyektinin tam olduğundan əmin oluruq
            deck.push({ suit: suit, value: val.v, score: val.s });
        });
    });

    // Qarışdır
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    players.forEach(p => {
        // Kartları paylamazdan əvvəl massivi təmizləyirik
        p.hand = [deck.pop(), deck.pop(), deck.pop()];
        // Diqqət: calculateSekaScore funksiyası p.hand-i düzgün oxumalıdır
        p.score = calculateSekaScore(p.hand);
        p.status = 'active';
    });
}

// Seka Xal Hesablama Qaydası
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
    
    // Eyni rəqəmlər (məsələn 3 dənə 9-luq)
    const valGroup = hand[0].value === hand[1].value && hand[1].value === hand[2].value;
    if (valGroup) {
        const tripleScore = hand[0].value === '6' ? 32 : (hand[0].score * 3);
        if (tripleScore > maxScore) maxScore = tripleScore;
    }

    return maxScore;
}

// --- TAYMER VƏ NÖVBƏ İDARƏETMƏSİ ---

function startTurnTimer(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    // Əgər əvvəlki taymer varsa, təmizlə
    if (turnTimers[roomId]) clearTimeout(turnTimers[roomId]);

    const activePlayer = room.players[room.turnIndex];

    // 30 saniyəlik taymer
    turnTimers[roomId] = setTimeout(() => {
        console.log(`Vaxt bitdi: ${activePlayer.username} avtomatik PAS edildi.`);
        processMove(roomId, activePlayer.username, 'pass');
    }, 30000); 
}

function processMove(roomId, username, moveType) {
    const room = rooms[roomId];
    if (!room) return;

    const player = room.players.find(p => p.username === username);
    if (!player || room.players[room.turnIndex].username !== username) return;

    // Hərəkət məntiqi
    if (moveType === 'pass') {
        player.status = 'pass';
    } else if (moveType === 'raise') {
        room.totalBank += 10; // Nümunə: hər artım 10 AZN
    }

    // Növbəni keçir (Növbəti aktiv oyunçuya)
    let nextIndex = (room.turnIndex + 1) % room.players.length;
    // Pas keçənləri tullayırıq
    while (room.players[nextIndex].status === 'pass' && room.players.filter(p => p.status === 'active').length > 1) {
        nextIndex = (nextIndex + 1) % room.players.length;
    }

    room.turnIndex = nextIndex;
    
    // Hamı pas veribsə və ya 1 nəfər qalıbsa oyunu bitir (sadələşdirilmiş)
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

// --- SOCKET BAĞLANTISI ---

io.on('connection', (socket) => {
    console.log('Yeni oyunçu qoşuldu:', socket.id);

    socket.on('join_room', (data) => {
        const { roomId, username } = data;
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = { 
                players: [], 
                totalBank: 0, 
                turnIndex: 0, 
                creator: username,
                status: 'waiting'
            };
        }

        if (rooms[roomId].players.length < 4) {
            rooms[roomId].players.push({ 
                username, 
                id: socket.id, 
                hand: [], 
                score: 0, 
                status: 'waiting' 
            });
        }

        io.to(roomId).emit('player_joined', { players: rooms[roomId].players });
    });

    socket.on('start_game_manual', (data) => {
    const room = rooms[data.roomId];
    if (room && room.creator === data.username) {
        console.log("Oyun başladılır..."); // Terminalda bunu görməlisən
        room.status = 'playing';
        room.totalBank = room.players.length * 5;
        
        shuffleAndDeal(room.players);
        room.turnIndex = 0;

        const startData = {
            players: room.players,
            totalBank: room.totalBank,
            activePlayer: room.players[0].username
        };

        console.log("Göndərilən məlumat:", startData); // Kartların dolu olduğunu yoxla
        io.to(data.roomId).emit('battle_start', startData);

        startTurnTimer(data.roomId);
    } else {
        console.log("Oyun başlada bilmədi: Creator deyil və ya otaq yoxdur.");
    }
});

    socket.on('make_move', (data) => {
        processMove(data.roomId, data.username, data.moveType);
    });

    socket.on('disconnect', () => {
        console.log('Oyunçu ayrıldı.');
        // Otaq təmizləmə məntiqi bura əlavə edilə bilər
    });
});

console.log('Server 3000 portunda işləyir...');
