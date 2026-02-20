require('dotenv').config();
const mongoose = require('mongoose');
const http = require('http');
const socketio = require('socket.io');

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Seka Server is Live!");
});

const io = socketio(server, {
  cors: { origin: "*" },
  transports: ['websocket', 'polling']
});

const uri = process.env.MONGO_URI || "mongodb+srv://admin:123@cluster0.1xrr77f.mongodb.net/?appName=Cluster0";

mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB connection error:", err));

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  balance: { type: Number, default: 1000 }
});
const User = mongoose.model('User', UserSchema);

let rooms = {};
let turnTimers = {};

// ────────────────────────────────────────────────
//  Yardımcı funksiyalar
// ────────────────────────────────────────────────

async function updateDbBalance(username, delta) {
  try {
    const user = await User.findOneAndUpdate(
      { username },
      { $inc: { balance: delta } },
      { new: true }
    );
    return user?.balance ?? null;
  } catch (err) {
    console.error("Balance update error:", err);
    return null;
  }
}

function calculateSekaScore(hand) {
  if (!hand || hand.length !== 3) return 0;

  const values = hand.map(c => c.value);
  const tCount = values.filter(v => v === 'T').length;

  if (tCount === 3) return 33;
  if (tCount === 2) return 22;

  // üç eyni kart
  if (values[0] === values[1] && values[1] === values[2]) {
    if (values[0] === 'T') return 33;
    if (values[0] === '6') return 32;
  }

  // eyni suit üzrə maksimum
  const suits = {};
  hand.forEach(c => {
    suits[c.suit] = (suits[c.suit] || 0) + c.score;
  });
  return Math.max(...Object.values(suits), 0);
}

function shuffleAndDeal(activePlayers) {
  const suits = ['Hearts', 'Spades', 'Clubs', 'Diamonds'];
  const cards = [];
  const valMap = { '6':6, '7':7, '8':8, '9':9, '10':10, 'B':10, 'D':10, 'K':10, 'T':11 };

  suits.forEach(s => {
    Object.keys(valMap).forEach(v => {
      cards.push({ suit: s, value: v, score: valMap[v] });
    });
  });

  // Fisher-Yates shuffle
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }

  let idx = 0;
  activePlayers.forEach(p => {
    p.hand = [cards[idx++], cards[idx++], cards[idx++]];
    p.score = calculateSekaScore(p.hand);
    p.status = 'active';
  });
}

function broadcastRoomList() {
  const list = Object.values(rooms).map(r => ({
    id: r.id,
    name: r.name,
    playersCount: r.players.length,
    maxPlayers: r.maxPlayers,
    minBet: r.minBet,
    status: r.status
  }));
  io.emit('update_room_list', list);
}

function finishGame(roomId, winner = null) {
  const room = rooms[roomId];
  if (!room) return;

  if (turnTimers[roomId]) {
    clearTimeout(turnTimers[roomId]);
    delete turnTimers[roomId];
  }

  if (winner) {
    const commission = Number((room.totalBank * 0.05).toFixed(2));
    const prize = Number((room.totalBank - commission).toFixed(2));
    updateDbBalance(winner.username, prize);

    io.to(roomId).emit('game_over', {
      winner: winner.username,
      winAmount: prize,
      commission,
      allHands: room.players.map(p => ({ username: p.username, hand: p.hand || [], score: p.score || 0 }))
    });
  } else {
    io.to(roomId).emit('game_over', { winner: null, message: 'No winner' });
  }

  // reset room
  room.status = 'waiting';
  room.totalBank = 0;
  room.lastBet = room.minBet;
  room.players.forEach(p => {
    p.status = 'waiting';
    p.hand = [];
    p.score = 0;
    p.currentBet = 0;
  });

  broadcastRoomList();
}

function nextTurn(roomId) {
  const room = rooms[roomId];
  if (!room || room.status !== 'playing') return;

  const actives = room.players.filter(p => p.status === 'active');
  if (actives.length < 2) {
    finishGame(roomId, actives[0] || null);
    return;
  }

  room.turnIndex = (room.turnIndex + 1) % actives.length;
  const nextPlayer = actives[room.turnIndex];

  io.to(roomId).emit('next_turn', {
    activePlayer: nextPlayer.username,
    totalBank: room.totalBank,
    lastBet: room.lastBet
  });

  if (turnTimers[roomId]) clearTimeout(turnTimers[roomId]);
  turnTimers[roomId] = setTimeout(() => {
    const p = room.players.find(pl => pl.username === nextPlayer.username);
    if (p && p.status === 'active') {
      p.status = 'folded';
      io.to(roomId).emit('move_made', { username: p.username, moveType: 'fold_timeout' });
      nextTurn(roomId);
    }
  }, 30000);
}

function startRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const ready = room.players.filter(p => p.status === 'ready');
  if (ready.length < 2) return;

  room.status = 'playing';
  ready.forEach(p => { p.status = 'active'; });
  shuffleAndDeal(ready);

  room.turnIndex = 0;
  const first = ready[0];

  io.to(roomId).emit('battle_start', {
    players: room.players,
    totalBank: room.totalBank,
    activePlayer: first.username,
    lastBet: room.lastBet
  });

  nextTurn(roomId);   // timer-i də burada başlayır
}

// ────────────────────────────────────────────────
//  SOCKET EVENTS
// ────────────────────────────────────────────────

io.on('connection', (socket) => {

  // 1. Login / register
  socket.on('join_room', async ({ username }) => {
    let user = await User.findOne({ username });
    if (!user) user = await User.create({ username, balance: 1000 });
    socket.emit('login_confirmed', user);
    broadcastRoomList();
  });

  // 2. Otaq yarat
  socket.on('create_custom_room', ({ roomName, maxPlayers, minBet }) => {
    const id = `room_${Date.now()}`;
    rooms[id] = {
      id,
      name: roomName || 'Seka Room',
      maxPlayers: Number(maxPlayers) || 10,
      minBet: Number(minBet) || 0.20,
      players: [],
      totalBank: 0,
      lastBet: Number(minBet) || 0.20,
      status: 'waiting',
      turnIndex: 0
    };
    socket.emit('room_created_success', rooms[id]);
    broadcastRoomList();
  });

  // 3. Otağa qoşul
  socket.on('join_custom_room', ({ roomId, username }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error_msg', 'Otaq tapılmadı');

    if (room.players.some(p => p.username === username)) {
      return socket.emit('error_msg', 'Bu ad artıq otaqdadır');
    }

    if (room.players.length >= room.maxPlayers) {
      return socket.emit('error_msg', 'Otaq doludur');
    }

    const player = {
      username,
      id: socket.id,
      status: 'waiting',
      hand: [],
      score: 0,
      currentBet: 0
    };

    room.players.push(player);
    socket.join(roomId);
    socket.emit('room_joined_success', room);
    io.to(roomId).emit('player_joined', { players: room.players });
    broadcastRoomList();
  });

  // 4. Raunda daxil ol (entry fee)
  socket.on('enter_round', async ({ roomId, username }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('error_message', 'Otaq tapılmadı');

    const player = room.players.find(p => p.username === username);
    if (!player) return socket.emit('error_message', 'Siz otaqda deyilsiniz');
    if (player.status !== 'waiting') return socket.emit('error_message', 'Artıq raunddasınız');

    const fee = room.minBet;
    const dbUser = await User.findOne({ username });
    if (!dbUser || dbUser.balance < fee) return socket.emit('error_message', 'Balans kifayət etmir');

    const newBalance = await updateDbBalance(username, -fee);
    if (newBalance === null) return socket.emit('error_message', 'Balans yenilənmədi');

    player.status = 'ready';
    player.currentBet = fee;
    room.totalBank += fee;

    io.to(roomId).emit('update_players', {
      players: room.players,
      totalBank: room.totalBank,
      username,
      newBalance
    });

    // 10 saniyəlik auto-start timer
    const readies = room.players.filter(p => p.status === 'ready');
    if (readies.length >= 2 && !room.startTimerActive) {
      room.startTimerActive = true;
      let sec = 10;
      const t = setInterval(() => {
        io.to(roomId).emit('start_countdown', { timeLeft: sec });
        sec--;
        if (sec < 0) {
          clearInterval(t);
          room.startTimerActive = false;
          startRound(roomId);
        }
      }, 1000);
    }
  });

  // 5. Hərəkət (pass, raise, show, offer_seka, offer_split)
  socket.on('make_move', async ({ roomId, moveType, username, amount }) => {
    const room = rooms[roomId];
    if (!room || room.status !== 'playing') return;

    const actives = room.players.filter(p => p.status === 'active');
    const player = room.players.find(p => p.username === username);
    if (!player || player.status !== 'active') return;

    // Pas / Fold – istənilən vaxt
    if (moveType === 'pass' || moveType === 'fold') {
      player.status = 'folded';
      io.to(roomId).emit('move_made', { username, moveType: 'fold' });

      if (actives.length <= 2) {
        const remaining = room.players.filter(p => p.status === 'active');
        if (remaining.length === 1) finishGame(roomId, remaining[0]);
      } else {
        nextTurn(roomId);
      }
      return;
    }

    // Yalnız növbədə olan oynaya bilər
    const current = actives[room.turnIndex];
    if (!current || current.username !== username) return;

    if (moveType === 'raise') {
      const val = Number(amount);
      if (isNaN(val) || val < room.lastBet) {
        return socket.emit('error_message', `Minimum ${room.lastBet} olmalıdır`);
      }

      const toPay = val - (player.currentBet || 0);
      if (toPay <= 0) return socket.emit('error_message', 'Artırmalısınız');

      const newBal = await updateDbBalance(username, -toPay);
      if (newBal === null) return socket.emit('error_message', 'Balans xətası');

      player.currentBet = val;
      room.totalBank += toPay;
      room.lastBet = val;

      io.to(roomId).emit('update_game_state', {
        players: room.players,
        totalBank: room.totalBank,
        lastBet: room.lastBet
      });

      // 2 nəfər qalıbsa → show fürsəti (client timer göstərir)
      if (actives.length === 2) {
        io.to(roomId).emit('final_two_raise_detected');
      } else {
        nextTurn(roomId);
      }
    }

    else if (moveType === 'show') {
      if (actives.length !== 2) return;
      const [p1, p2] = actives;
      if (p1.score > p2.score) finishGame(roomId, p1);
      else if (p2.score > p1.score) finishGame(roomId, p2);
      else {
        // bərabər → seka (5% komissiya + qalanı bölünə bilər)
        const comm = Number((room.totalBank * 0.05).toFixed(2));
        const remain = Number((room.totalBank - comm).toFixed(2));
        io.to(roomId).emit('seka_detected', { commission: comm, remainingBank: remain });
        // burada avto-split və ya yeni təklif mexanizmi əlavə oluna bilər
      }
    }

    else if (moveType === 'offer_seka' || moveType === 'offer_split') {
      const opponent = actives.find(p => p.username !== username);
      if (opponent) {
        io.to(opponent.id).emit('offer_received', { type: moveType, from: username });
      }
    }
  });

  // offer cavabı
  socket.on('offer_response', async ({ roomId, type, accepted, from }) => {
    const room = rooms[roomId];
    if (!room) return;

    if (!accepted) {
      io.to(roomId).emit('error_message', `${from} təklifi rədd etdi`);
      return;
    }

    if (type === 'offer_split') {
      const act = room.players.filter(p => p.status === 'active');
      if (act.length < 1) return;
      const share = Number((room.totalBank / act.length).toFixed(2));
      for (const p of act) {
        await updateDbBalance(p.username, share);
      }
      io.to(roomId).emit('game_over', {
        winner: "BÖLÜNDÜ (50/50)",
        winAmount: share,
        isSplit: true
      });
      finishGame(roomId);
    }

    // offer_seka → hələlik sadəcə məlumat (genişləndirilə bilər)
    else if (type === 'offer_seka') {
      io.to(roomId).emit('seka_accepted', { from });
      // buraya digər oyunçuların yarısını qoyma mexanizmi əlavə oluna bilər
    }
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(rid => {
      const r = rooms[rid];
      const idx = r.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        r.players.splice(idx, 1);
        io.to(rid).emit('update_players', { players: r.players });
        if (r.players.length === 0) delete rooms[rid];
      }
    });
    broadcastRoomList();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
