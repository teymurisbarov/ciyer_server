const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000, // Bağlantı qopmalarına qarşı dözümlülük
});

// --- MONGODB ---
const MONGO_URI = "mongodb+srv://teymurisbarov:123456Teymur@cluster0.1xrr77f.mongodb.net/ciyer_database?retryWrites=true&w=majority";
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB-yə qoşulduq!"))
  .catch(err => console.error("❌ Baza xətası:", err));

// --- USER MODEL ---
const User = mongoose.model('User', new mongoose.Schema({
  fullname: String,
  email: { type: String, unique: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 0 }
}));

// --- GLOBAL STATE (Yaddaşda otaq idarəetməsi) ---
// Map massivdən (Array) çox daha sürətlidir və minlərlə otağı saniyələr içində emal edir.
let activeRooms = new Map();

io.on('connection', (socket) => {
  console.log(`🟢 Yeni oyunçu qoşuldu: ${socket.id}`);

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

  // 2. OTAQ YARATMAQ (Maksimum 10 nəfərlik)
  socket.on('create_custom_room', (data) => {
    const roomId = `room_${socket.id}`;
    
    // Əgər oyunçu köhnə otağını təmizləmədən yeni otaq yaratmaq istəyirsə, köhnəni silirik
    if (activeRooms.has(roomId)) {
      activeRooms.delete(roomId);
    }

    const newRoom = {
      id: roomId,
      creator: data.username,
      name: `${data.username}-in otağı`,
      players: [{ id: socket.id, username: data.username }],
      maxPlayers: 10, // Sənin istədiyin limit
      status: 'waiting',
      createdAt: Date.now()
    };

    activeRooms.set(roomId, newRoom);
    socket.join(roomId);
    
    console.log(`🏠 Otaq yaradıldı: ${newRoom.name}`);
    broadcastRoomList(); // Hamıya yenilənmiş siyahını göndər
  });

  // 3. AKTİV OTAQLARI İSTƏMƏK
  socket.on('get_active_rooms', () => {
    broadcastRoomList();
  });

  // 4. OTAĞA QOŞULMAQ
  socket.on('join_custom_room', (data) => {
    const room = activeRooms.get(data.roomId);

    if (room) {
      // Otaqda yer varmı və oyunçu artıq orada deyilmi?
      const isAlreadyIn = room.players.find(p => p.username === data.username);
      
      if (room.players.length < room.maxPlayers && !isAlreadyIn) {
        room.players.push({ id: socket.id, username: data.username });
        socket.join(data.roomId);

        // Otaqdakı hər kəsə yeni oyunçunun gəldiyini xəbər ver
        io.to(data.roomId).emit('player_joined', {
          players: room.players,
          count: room.players.length
        });

        console.log(`👤 ${data.username} otağa qoşuldu (${room.players.length}/10)`);
        broadcastRoomList();
      } else if (isAlreadyIn) {
        socket.emit('error_message', 'Siz artıq bu otaqdasınız!');
      } else {
        socket.emit('error_message', 'Otaq doludur!');
      }
    } else {
      socket.emit('error_message', 'Otaq tapılmadı!');
    }
  });

  // 5. BAĞLANTI KƏSİLDİKDƏ (DISCONNECT)
  socket.on('disconnect', () => {
    console.log(`🔴 Oyunçu ayrıldı: ${socket.id}`);
    
    activeRooms.forEach((room, roomId) => {
      // Oyunçunu otaqdan çıxarırıq
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        room.players.splice(playerIndex, 1);
        
        // Əgər otaqda kimsə qalmayıbsa, otağı Map-dan silirik (RAM təmizliyi)
        if (room.players.length === 0) {
          activeRooms.delete(roomId);
          console.log(`🗑️ Boş otaq silindi: ${roomId}`);
        } else {
          // Otaqda qalanlara xəbər veririk
          io.to(roomId).emit('player_left', { players: room.players });
        }
        broadcastRoomList();
      }
    });
  });
});

// Performans üçün otaq siyahısını hamıya göndərən köməkçi funksiya
function broadcastRoomList() {
  const list = Array.from(activeRooms.values())
    .filter(r => r.status === 'waiting')
    .slice(0, 50); // İlk 50 aktiv otağı göndəririk ki, trafik şişməsin
  io.emit('update_room_list', list);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server ${PORT} portunda aktivdir!`));
