const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- MONGODB BAĞLANTISI ---
const MONGO_URI = "mongodb+srv://teymurisbarov:123456Teymur@cluster0.1xrr77f.mongodb.net/ciyer_database?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MONGODB-YƏ QOŞULDUQ!"))
  .catch(err => console.log("❌ BAZA XƏTASI:", err.message));

// --- USER MODELİ ---
const userSchema = new mongoose.Schema({
  fullname: String,
  email: { type: String, unique: true },
  phone: String,
  password: { type: String, required: true },
  balance: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

// --- GLOBAL DƏYİŞƏNLƏR ---
let activeRooms = []; // Aktiv otaqların siyahısı

io.on('connection', (socket) => {
  console.log("🟢 Yeni əlaqə:", socket.id);

  // 1. DAXİL OL (LOGIN)
  socket.on('login', async (data) => {
    try {
      const { identifier, password } = data;
      const cleanId = identifier.trim().toLowerCase();
      const user = await User.findOne({
        $or: [{ email: cleanId }, { phone: identifier.trim() }]
      });

      if (!user) return socket.emit('error_message', 'İstifadəçi tapılmadı!');

      if (user.password.toString().trim() === password.toString().trim()) {
        socket.emit('login_success', { 
          username: user.fullname || "Oyunçu", 
          balance: user.balance 
        });
      } else {
        socket.emit('error_message', 'Şifrə yanlışdır!');
      }
    } catch (err) {
      socket.emit('error_message', 'Server xətası!');
    }
  });

  // 2. QEYDİYYAT (REGISTER)
  socket.on('register', async (userData) => {
    try {
      const emailFormatted = userData.email.trim().toLowerCase();
      const existingUser = await User.findOne({ email: emailFormatted });
      if (existingUser) return socket.emit('error_message', "Bu email artıq var!");
      
      const newUser = new User({ ...userData, email: emailFormatted });
      await newUser.save();
      socket.emit('register_success');
    } catch (err) {
      socket.emit('error_message', "Qeydiyyat xətası!");
    }
  });

  // 3. OTAQ YARATMAQ
  socket.on('create_custom_room', (data) => {
    const roomId = `room_${socket.id}`;
    const newRoom = {
        id: roomId,
        creator: data.username,
        name: `${data.username}-in otağı`,
        players: [data.username],
        status: 'waiting'
    };
    
    activeRooms.push(newRoom);
    socket.join(roomId);
    
    console.log("🏠 Otaq yaradıldı:", roomId); // Bunu Render Logs-da görməlisən
    
    // Bütün hamıya siyahını göndər
    io.emit('update_room_list', activeRooms.filter(r => r.status === 'waiting'));
    
    // Şəxsən sənə otağın yarandığını təsdiq et
    socket.emit('room_created', newRoom);
});

  // 4. OTAQLARI İSTƏMƏK
  socket.on('get_active_rooms', () => {
    socket.emit('update_room_list', activeRooms.filter(r => r.status === 'waiting'));
  });
  

  // 5. OTAĞA QOŞULMAQ
  socket.on('join_custom_room', (data) => {
    const roomIndex = activeRooms.findIndex(r => r.id === data.roomId);
    const room = activeRooms[roomIndex];

    if (room && room.players.length < 2) {
      room.players.push(data.username);
      room.status = 'playing';
      socket.join(data.roomId);
      
      console.log(`🚀 ${data.username} otağa qoşuldu: ${room.id}`);

      // Oyunu başladırıq
      io.to(data.roomId).emit('battle_start', {
        room: room.id,
        players: room.players,
        turn: room.players[0] // İlk gediş kimdədir (nümunə üçün)
      });
      
      // Otaq dolduğu üçün siyahıdan çıxarırıq (digərləri görməsin)
      io.emit('update_room_list', activeRooms.filter(r => r.status === 'waiting'));
    } else {
      socket.emit('error_message', 'Otaq doludur və ya tapılmadı!');
    }
  });

  // 6. KART OYUNU ÜÇÜN HADİSƏLƏR (MƏLUMAT ÖTÜRMƏ)
  socket.on('play_card', (data) => {
    // data: { room, card, username }
    socket.to(data.room).emit('opponent_card_played', data);
  });

  socket.on('chat_message', (data) => {
    // data: { room, message, username }
    socket.to(data.room).emit('new_chat_message', data);
  });

  // 7. ÇIXIŞ (DISCONNECT)
  socket.on('disconnect', () => {
    // Əgər oyunçu otaq yaradan idisə, otağı siyahıdan sil
    activeRooms = activeRooms.filter(r => r.id !== `room_${socket.id}`);
    io.emit('update_room_list', activeRooms.filter(r => r.status === 'waiting'));
    console.log("🔴 İstifadəçi çıxdı");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server ${PORT} portunda aktivdir!`));
