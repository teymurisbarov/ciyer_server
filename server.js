const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// MONGODB BAĞLANTISI
const MONGO_URI = "mongodb+srv://teymurisbarov:123456Teymur@cluster0.1xrr77f.mongodb.net/ciyer_database?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ BAZAYA QOŞULDUQ!"))
  .catch(err => console.log("❌ BAZA XƏTASI:", err.message));

// USER MODELİ
const userSchema = new mongoose.Schema({
  fullname: String,
  email: { type: String, unique: true },
  phone: String,
  password: { type: String, required: true },
  balance: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

let waitingQueue = []; // Gözləmə siyahısı

// --- BÜTÜN HADİSƏLƏR TƏK BİR CONNECTION DAXİLİNDƏ ---
io.on('connection', (socket) => {
  console.log("🟢 Yeni əlaqə:", socket.id);

  // 1. DAXİL OL (LOGIN)
  socket.on('login', async (data) => {
    try {
      const { identifier, password } = data;
      const cleanId = identifier.trim().toLowerCase();

      console.log("🔍 Giriş cəhdi:", cleanId);

      const user = await User.findOne({
        $or: [{ email: cleanId }, { phone: identifier.trim() }]
      });

      if (!user) {
        return socket.emit('error_message', 'İstifadəçi tapılmadı!');
      }

      if (user.password.toString().trim() === password.toString().trim()) {
        console.log("✅ Giriş uğurlu:", user.fullname);
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

  // 3. PVP DÖYÜŞƏ QOŞULMA
  socket.on('join_battle', (username) => {
    console.log(`⚔️ ${username} rəqib axtarır...`);
    waitingQueue = waitingQueue.filter(p => p.id !== socket.id);

    if (waitingQueue.length > 0) {
      const opponent = waitingQueue.shift();
      const roomName = `room_${opponent.id}_${socket.id}`;
      
      socket.join(roomName);
      opponent.socket.join(roomName);

      io.to(roomName).emit('battle_start', {
        room: roomName,
        players: [opponent.username, username]
      });
    } else {
      waitingQueue.push({ id: socket.id, username, socket });
    }
  });

  // 4. KLİKLƏR VƏ OYUN SONU
  socket.on('battle_click', (data) => {
    socket.to(data.room).emit('player_clicked', { username: data.username });
  });

  socket.on('finish_battle', (data) => {
    io.to(data.room).emit('battle_end', { winner: data.winner });
  });

  socket.on('disconnect', () => {
    waitingQueue = waitingQueue.filter(p => p.id !== socket.id);
    console.log("🔴 Oyunçu çıxdı");
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server ${PORT} portunda hazırdır!`));
