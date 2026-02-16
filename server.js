const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- MONGODB QOŞULMASI ---
// 127.0.0.1 sənin lokal kompyuterindir
mongoose.connect('mongodb+srv://teymurisbarov:<db_password>@cluster0.1xrr77f.mongodb.net/?appName=Cluster0')
    .then(() => console.log("✅ MongoDB-yə uğurla qoşulduq!"))
    .catch(err => console.error("❌ Baza xətası:", err));

// Oyunçu modeli (Database-də məlumatın necə görünəcəyi)
const UserSchema = new mongoose.Schema({
    fullname: String,
    email: { type: String, unique: true, required: true },
    phone: { type: String, unique: true, required: true },
    password: { type: String, required: true }, // Şifrəni də saxlayaq
    balance: { type: Number, default: 100 },
    online: { type: Boolean, default: false }
});

const User = mongoose.model('User', UserSchema);

// --- SERVER MƏNTİQİ ---
io.on('connection', (socket) => {
    console.log('Yeni əlaqə:', socket.id);

    // Giriş və ya Qeydiyyat
    socket.on('login', async (username) => {
        try {
            let user = await User.findOne({ username: username });

            if (!user) {
                // Əgər belə oyunçu yoxdursa, yenisini yarat
                user = new User({ username: username, balance: 100 });
                await user.save();
                console.log(`Yeni oyunçu yaradıldı: ${username}`);
            }

            socket.username = user.username;
            socket.emit('login_success', { username: user.username, balance: user.balance });
        } catch (err) {
            console.log("Giriş zamanı xəta:", err);
        }
        socket.on('register', async (userData) => {
    try {
        const newUser = new User(userData);
        await newUser.save();
        console.log("Yeni istifadəçi bazaya yazıldı:", userData.fullname);
        socket.emit('register_success', { message: "Qeydiyyat tamamlandı!" });
    } catch (err) {
        console.log("Qeydiyyat xətası:", err);
        socket.emit('error_message', 'Xəta baş verdi!');
    }
});
    });

    // Otağa qoşulma
    socket.on('join_room', (roomName) => {
        const room = io.sockets.adapter.rooms.get(roomName);
        const playerCount = room ? room.size : 0;

        if (playerCount < 10) {
            socket.join(roomName);
            io.to(roomName).emit('message', `${socket.username} otağa girdi. Say: ${playerCount + 1}`);
        } else {
            socket.emit('error_message', 'Bu otaq doludur!');
        }
    });

    // Balans Artırma
    socket.on('add_money', async (amount) => {
        if (socket.username) {
            const user = await User.findOneAndUpdate(
                { username: socket.username },
                { $inc: { balance: amount } },
                { new: true }
            );
            socket.emit('update_balance', user.balance);
        }
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server ${PORT} portunda dünyaya açıldı...`);
});