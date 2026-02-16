const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Hamıya icazə ver
    methods: ["GET", "POST"]
  }
});

// MONGODB BAĞLANTISI (Şifrəni yoxla!)
const MONGO_URI = "mongodb+srv://teymurisbarov:123456Teymur@cluster0.1xrr77f.mongodb.net/";

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ 1. BAZAYA QOŞULDUQ!"))
  .catch(err => console.log("❌ BAZA XƏTASI:", err.message));

// USER MODELİ (Bu hissə mütləq olmalıdır)
const userSchema = new mongoose.Schema({
  fullname: String,
  email: { type: String, unique: true },
  phone: String,
  password: { type: String, required: true },
  balance: { type: Number, default: 0 }
});

const User = mongoose.model('User', userSchema);

io.on('connection', (socket) => {
  console.log("🟢 Yeni əlaqə:", socket.id);

  // QEYDİYYAT
  socket.on('register', async (userData) => {
    console.log("📩 Qeydiyyat istəyi:", userData.email);
    try {
        // Email yoxlaması
        const existingUser = await User.findOne({ email: userData.email });
        if (existingUser) {
            return socket.emit('error_message', "Bu email artıq istifadə olunur!");
        }

        const newUser = new User({
            fullname: userData.fullname,
            email: userData.email,
            phone: userData.phone,
            password: userData.password,
            balance: 0
        });

        await newUser.save();
        console.log("💎 İSTİFADƏÇİ YAZILDI!");
        socket.emit('register_success', { message: "Uğurlu!" });
    } catch (err) {
        console.log("🔴 XƏTA:", err.message);
        socket.emit('error_message', "Server xətası: " + err.message);
    }
});
  // DAXİL OL
  socket.on('login', async (name) => {
    try {
        // Həm fullname, həm də email ilə yoxlayaq ki, səhv olmasın
        const user = await User.findOne({ fullname: name });
        if (user) {
            socket.emit('login_success', { username: user.fullname, balance: user.balance });
        } else {
            socket.emit('error_message', 'İstifadəçi tapılmadı!');
        }
    } catch (err) {
        socket.emit('error_message', 'Giriş xətası!');
    }
});

  socket.on('disconnect', () => console.log("🔴 Əlaqə kəsildi"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server ${PORT} portunda hazırdır!`));