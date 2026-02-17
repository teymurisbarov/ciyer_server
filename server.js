const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// MONGODB
const MONGO_URI = "mongodb+srv://teymurisbarov:123456Teymur@cluster0.1xrr77f.mongodb.net/ciyer_database?retryWrites=true&w=majority";
mongoose.connect(MONGO_URI).then(() => console.log("✅ Baza hazırdır"));

// USER MODEL
const User = mongoose.model('User', new mongoose.Schema({
  fullname: String, email: { type: String, unique: true },
  password: { type: String, required: true }, balance: { type: Number, default: 0 }
}));

let activeRooms = [];

io.on('connection', (socket) => {
  // LOGIN
  socket.on('login', async (data) => {
    const user = await User.findOne({ email: data.identifier.trim().toLowerCase() });
    if (user && user.password === data.password) {
      socket.emit('login_success', { username: user.fullname, balance: user.balance });
    } else {
      socket.emit('error_message', 'Məlumatlar yanlışdır');
    }
  });

  // OTAQ YARATMAQ
  socket.on('create_custom_room', (data) => {
    const roomId = `room_${socket.id}`;
    const newRoom = { id: roomId, name: `${data.username}-in otağı`, players: [data.username], status: 'waiting' };
    activeRooms.push(newRoom);
    socket.join(roomId);
    io.emit('update_room_list', activeRooms.filter(r => r.status === 'waiting'));
  });

  // OTAQLARI GÖNDƏR
  socket.on('get_active_rooms', () => {
    socket.emit('update_room_list', activeRooms.filter(r => r.status === 'waiting'));
  });

  // QOŞULMAQ
  socket.on('join_custom_room', (data) => {
    const room = activeRooms.find(r => r.id === data.roomId);
    if (room && room.players.length < 2) {
      room.players.push(data.username);
      room.status = 'playing';
      socket.join(data.roomId);
      io.to(data.roomId).emit('battle_start', { room: room.id, players: room.players });
      io.emit('update_room_list', activeRooms.filter(r => r.status === 'waiting'));
    }
  });

  socket.on('disconnect', () => {
    activeRooms = activeRooms.filter(r => r.id !== `room_${socket.id}`);
    io.emit('update_room_list', activeRooms.filter(r => r.status === 'waiting'));
  });
});

server.listen(process.env.PORT || 3000, () => console.log("🚀 Server Live"));
