const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
function createDeck() {
    const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades']; // Ürək, Kərpic, Xaç, Pika
    const values = [
        { name: '6', score: 6 },
        { name: '7', score: 7 },
        { name: '8', score: 8 },
        { name: '9', score: 9 },
        { name: '10', score: 10 },
        { name: 'B', score: 10 }, // J (Valet)
        { name: 'D', score: 10 }, // Q (Dama)
        { name: 'K', score: 10 }, // K (Korol)
        { name: 'T', score: 11 }  // A (Tus)
    ];
    
    let deck = [];
    suits.forEach(suit => {
        values.forEach(v => {
            deck.push({ 
                suit, 
                value: v.name, 
                score: v.score,
                id: `${suit}_${v.name}` 
            });
        });
    });

    // Qarışdırırıq
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
});

// --- MONGODB ---
const MONGO_URI = "mongodb+srv://teymurisbarov:123456Teymur@cluster0.1xrr77f.mongodb.net/ciyer_database?retryWrites=true&w=majority";
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Hazırdır"))
  .catch(err => console.error("❌ Baza xətası:", err));

// --- USER MODEL ---
const User = mongoose.model('User', new mongoose.Schema({
  fullname: String,
  email: { type: String, unique: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 0 }
}));

// --- GLOBAL STATE ---
let activeRooms = new Map();

io.on('connection', (socket) => {
  console.log(`🟢 Qoşuldu: ${socket.id}`);

  // 1. LOGIN
  socket.on('login', async (data) => {
    try {
      const user = await User.findOne({ email: data.identifier.trim().toLowerCase() });
      if (user && user.password === data.password) {
        socket.emit('login_success', { username: user.fullname, balance: user.balance });
      } else {
        socket.emit('error_message', 'Məlumatlar yanlışdır!');
      }
    } catch (err) {
      socket.emit('error_message', 'Server xətası!');
    }
  });

  // 2. OTAQ YARATMAQ
  socket.on('create_custom_room', (data) => {
    const roomId = `room_${socket.id}`;
    if (activeRooms.has(roomId)) activeRooms.delete(roomId);

    const newRoom = {
      id: roomId,
      creator: data.username,
      name: data.roomName,
      players: [{ id: socket.id, username: data.username }],
      maxPlayers: parseInt(data.maxPlayers) || 2,
      status: 'waiting',
      createdAt: Date.now()
    };

    activeRooms.set(roomId, newRoom);
    socket.join(roomId);
    
    socket.emit('room_created_success', {
        id: newRoom.id,
        players: newRoom.players,
        name: newRoom.name,
        creator: newRoom.creator,
        maxPlayers: newRoom.maxPlayers
    });

    broadcastRoomList();
  });

  // 3. OTAĞA QOŞULMAQ
  socket.on('join_custom_room', (data) => {
    const room = activeRooms.get(data.roomId);

    if (room) {
      const isAlreadyIn = room.players.find(p => p.username === data.username);
      if (room.players.length < room.maxPlayers && !isAlreadyIn) {
        room.players.push({ id: socket.id, username: data.username });
        socket.join(data.roomId);

        // Qoşulan şəxsə məlumat
        socket.emit('room_joined_success', {
          room: room.id,
          players: room.players,
          name: room.name,
          creator: room.creator,
          maxPlayers: room.maxPlayers
        });

        // Otaqdakı digərlərinə məlumat
        io.to(data.roomId).emit('player_joined', { players: room.players });
        broadcastRoomList();
      } else {
        socket.emit('error_message', 'Otaq doludur və ya artıq daxildəsiniz!');
      }
    }
  });

  // 4. OYUNU BAŞLATMAQ (MANUAL)
  socket.on('start_game_manual', (data) => {
    const room = activeRooms.get(data.roomId);
    if (room && room.creator === data.username && room.players.length >= 2) {
      room.status = 'playing'; // Artıq lobby-də görsənməyəcək
      io.to(data.roomId).emit('battle_start', {
        room: room.id,
        players: room.players
      });
      broadcastRoomList();
    }
  });

  // 5. OTAQDAN ÇIXMAQ (DÜYMƏ İLƏ)
  socket.on('leave_room', (data) => {
    handleUserLeave(socket, data.roomId, data.username);
  });

  // 6. DISCONNECT (BAĞLANTI QOPANDA)
  socket.on('disconnect', () => {
    activeRooms.forEach((room, roomId) => {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        const username = room.players[playerIndex].username;
        handleUserLeave(socket, roomId, username);
      }
    });
  });
});

// Çıxış Məntiqi - Təkrarlanmaması üçün tək funksiya
function handleUserLeave(socket, roomId, username) {
  const room = activeRooms.get(roomId);
  if (room) {
    room.players = room.players.filter(p => p.username !== username);
    socket.leave(roomId);

    // Əgər otağı yaradan çıxıbsa və ya otaq boşdursa - SİL
    if (room.players.length === 0 || room.creator === username) {
      activeRooms.delete(roomId);
      console.log(`🗑️ Otaq silindi: ${roomId}`);
    } else {
      io.to(roomId).emit('player_left', { players: room.players });
    }
    broadcastRoomList();
  }
}

function broadcastRoomList() {
  const list = Array.from(activeRooms.values())
    .filter(r => r.status === 'waiting')
    .slice(0, 50);
  io.emit('update_room_list', list);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server ${PORT}-da aktivdir`));
