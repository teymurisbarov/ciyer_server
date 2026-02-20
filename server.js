// server.js (düzəldilmiş)
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

// MONGO URI təhlükəsizliyi: .env faylına köçür
const uri = process.env.MONGO_URI || "mongodb+srv://admin:123@cluster0.1xrr77f.mongodb.net/seka_game?retryWrites=true&w=majority";

mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log("✅ MongoDB-yə uğurla bağlanıldı"))
  .catch(err => console.error("❌ MongoDB bağlantı xətası:", err.message));

const UserSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  balance: { type: Number, default: 1000 }
});
const User = mongoose.model('User', UserSchema);

// Oyun strukturları
let rooms = {};
let turnTimers = {};
let sekaTimers = {}; // seka üçün müvəqqəti deadline

// --- KÖMƏKÇİ FUNKSİYALAR ---
function broadcastRooms() {
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

async function updateDbBalance(username, amount) {
  try {
    const user = await User.findOneAndUpdate(
      { username },
      { $inc: { balance: amount } },
      { new: true }
    );
    return user ? user.balance : null;
  } catch (err) {
    console.error("Balans yeniləmə xətası:", err);
    return null;
  }
}

async function handleWin(roomId, winnerUsername, amount) {
  const commission = parseFloat((amount * 0.05).toFixed(2));
  const finalAmount = parseFloat((amount - commission).toFixed(2));
  const newBalance = await updateDbBalance(winnerUsername, finalAmount);
  return { newBalance, finalAmount, commission };
}

function calculateSekaScore(hand) {
  if (!Array.isArray(hand) || hand.length === 0) return 0;
  const tuses = hand.filter(c => c.value === 'T');
  if (tuses.length === 3) return 33;
  if (tuses.length === 2) return 22;

  // suit üzrə cəmlər
  const suits = ['Hearts', 'Spades', 'Clubs', 'Diamonds'];
  let max = 0;
  suits.forEach(s => {
    const sum = hand.filter(c => c.suit === s).reduce((acc, card) => acc + (card.score || 0), 0);
    if (sum > max) max = sum;
  });

  // üç eyni dəyərli kart (məs: üç 6) xüsusi qayda
  const values = hand.map(c => c.value);
  const isThreeOfAKind = values.every(v => v === values[0]);
  if (isThreeOfAKind) {
    if (values[0] === 'T') return 33;
    // Sənin qaydana görə üç eyni dəyər 32 hesab edilirsə:
    return 32;
  }

  return max;
}

function shuffleAndDeal(players) {
  if (!Array.isArray(players) || players.length === 0) return;
  const suits = ['Hearts', 'Spades', 'Clubs', 'Diamonds'];
  const values = [
    { v: '6', s: 6 }, { v: '7', s: 7 }, { v: '8', s: 8 },
    { v: '9', s: 9 }, { v: '10', s: 10 }, { v: 'B', s: 10 },
    { v: 'D', s: 10 }, { v: 'K', s: 10 }, { v: 'T', s: 11 }
  ];
  let deck = [];
  suits.forEach(suit => values.forEach(val => deck.push({ suit, value: val.v, score: val.s })));

  // shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  players.forEach(p => {
    p.hand = [deck.pop(), deck.pop(), deck.pop()];
    p.score = calculateSekaScore(p.hand);
    p.status = 'active';
    p.currentBet = p.currentBet || 0;
  });
}

// --- OYUN MƏNTİQİ ---
async function finishGame(roomId, winnerData = null) {
  const room = rooms[roomId];
  if (!room) return;
  if (turnTimers[roomId]) { clearTimeout(turnTimers[roomId]); delete turnTimers[roomId]; }
  if (sekaTimers[roomId]) { clearTimeout(sekaTimers[roomId]); delete sekaTimers[roomId]; }

  let winner = winnerData || room.players.filter(p => p.status === 'active').sort((a, b) => b.score - a.score)[0];

  if (winner) {
    const { newBalance, finalAmount } = await handleWin(roomId, winner.username, room.totalBank);
    io.to(roomId).emit('game_over', {
      winner: winner.username,
      winAmount: finalAmount.toFixed(2),
      newBalance: newBalance,
      allHands: room.players.map(p => ({ username: p.username, hand: p.hand, score: p.score }))
    });
  } else {
    io.to(roomId).emit('game_over', { winner: null, message: 'Heç kim qalib gəlmədi' });
  }

  // otağı sıfırla
  room.status = 'waiting';
  room.totalBank = 0;
  room.lastBet = room.minBet;
  room.players.forEach(p => { p.status = 'waiting'; p.hand = []; p.score = 0; p.currentBet = 0; });
  broadcastRooms();
}

function nextTurn(roomId) {
  const room = rooms[roomId];
  if (!room || room.status !== 'playing') return;

  const activePlayers = room.players.filter(p => p.status === 'active');
  if (activePlayers.length < 2) {
    finishGame(roomId, activePlayers[0]);
    return;
  }

  // turnIndex təhlükəsizliyi
  room.turnIndex = (typeof room.turnIndex === 'number') ? room.turnIndex : 0;
  room.turnIndex = room.turnIndex % activePlayers.length;
  // növbəti oyunçu
  room.turnIndex = (room.turnIndex + 1) % activePlayers.length;
  const nextPlayer = activePlayers[room.turnIndex];

  if (turnTimers[roomId]) clearTimeout(turnTimers[roomId]);

  io.to(roomId).emit('next_turn', {
    activePlayer: nextPlayer.username,
    turnIndex: room.turnIndex,
    totalBank: room.totalBank,
    lastBet: room.lastBet
  });

  // 30s timeout
  turnTimers[roomId] = setTimeout(() => {
    const activePlayersNow = room.players.filter(p => p.status === 'active');
    const currentPlayer = activePlayersNow[room.turnIndex];
    if (currentPlayer) {
      currentPlayer.status = 'folded';
      io.to(roomId).emit('move_made', { username: currentPlayer.username, moveType: 'timeout_fold' });
      nextTurn(roomId);
    }
  }, 30000);
}

function startSekaRound(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.status = 'playing';
  room.startTimerActive = false;

  // hazır olanları aktiv et
  room.players.forEach(p => {
    if (p.status === 'ready') p.status = 'active';
    p.currentBet = p.currentBet || 0;
  });

  const activePlayers = room.players.filter(p => p.status === 'active');
  if (activePlayers.length < 2) {
    // kifayət qədər oyunçu yoxdursa, raund başlamır
    room.status = 'waiting';
    broadcastRooms();
    return;
  }

  shuffleAndDeal(activePlayers);
  room.turnIndex = 0;

  io.to(roomId).emit('battle_start', {
    players: room.players,
    totalBank: room.totalBank,
    activePlayer: activePlayers[0].username,
    lastBet: room.lastBet || room.minBet
  });

  // start first player's timer
  if (turnTimers[roomId]) clearTimeout(turnTimers[roomId]);
  turnTimers[roomId] = setTimeout(() => {
    const current = room.players.find(p => p.status === 'active' && p.id === activePlayers[0].id);
    if (current) {
      current.status = 'folded';
      io.to(roomId).emit('move_made', { username: current.username, moveType: 'timeout_fold' });
      nextTurn(roomId);
    }
  }, 30000);
}

// --- SOCKET HADİSƏLƏRİ ---
io.on('connection', (socket) => {
  // login / user yaratma
  socket.on('join_room', async (data) => {
    try {
      let user = await User.findOne({ username: data.username });
      if (!user) user = await User.create({ username: data.username, balance: 1000 });
      socket.emit('login_confirmed', user);
      broadcastRooms();
    } catch (err) {
      socket.emit('error_message', 'Baza xətası: ' + err.message);
    }
  });

  // otaq yarat
  socket.on('create_custom_room', (data) => {
    const id = "room_" + Date.now();
    rooms[id] = {
      id,
      name: data.roomName || 'Unnamed',
      maxPlayers: parseInt(data.maxPlayers) || 10,
      minBet: parseFloat(data.minBet) || 0.20,
      players: [],
      totalBank: 0,
      lastBet: parseFloat(data.minBet) || 0.20,
      status: 'waiting',
      turnIndex: 0
    };
    socket.emit('room_created_success', rooms[id]);
    broadcastRooms();
  });

  // otağa qoşulma
  socket.on('join_custom_room', (data) => {
    const room = rooms[data.roomId];
    if (!room) {
      socket.emit('error_msg', 'Otaq tapılmadı!');
      return;
    }

    // eyni adla təkrarlanmanı aradan qaldır
    room.players = room.players.filter(p => p.username !== data.username);

    if (room.players.length < room.maxPlayers) {
      const newUser = {
        username: data.username,
        id: socket.id,
        status: 'waiting',
        hand: [],
        score: 0,
        currentBet: 0
      };
      room.players.push(newUser);
      socket.join(data.roomId);
      socket.emit('room_joined_success', room);
      io.to(data.roomId).emit('player_joined', { players: room.players });
      broadcastRooms();
    } else {
      socket.emit('error_msg', 'Otaq doludur!');
    }
  });

  socket.on('leave_room', (data) => {
    const room = rooms[data.roomId];
    if (!room) return;
    room.players = room.players.filter(p => p.username !== data.username);
    socket.leave(data.roomId);
    if (room.players.length === 0) {
      delete rooms[data.roomId];
      console.log(`Otaq silindi: ${data.roomId}`);
    } else {
      io.to(data.roomId).emit('update_players', { players: room.players });
    }
    broadcastRooms();
  });

  // raunda daxil olma (entry fee çıxılır və ready olur)
  socket.on('enter_round', async (data) => {
    const room = rooms[data.roomId];
    if (!room) return;
    const player = room.players.find(p => p.username === data.username);
    const entryFee = room.minBet;
    if (!player) return;

    if (player.status !== 'waiting') {
      socket.emit('error_message', 'Siz artıq raundda iştirak edirsiniz və ya hazır vəziyyətsiniz.');
      return;
    }

    const currentDbUser = await User.findOne({ username: data.username });
    if (!currentDbUser || currentDbUser.balance < entryFee) {
      socket.emit('error_message', 'Balans kifayət deyil!');
      return;
    }

    const newBal = await updateDbBalance(data.username, -entryFee);
    if (newBal === null) {
      socket.emit('error_message', 'Balans yenilənmədi.');
      return;
    }

    player.status = 'ready';
    player.currentBet = entryFee;
    room.totalBank = parseFloat((room.totalBank + entryFee).toFixed(2));

    io.to(data.roomId).emit('update_players', {
      players: room.players,
      totalBank: room.totalBank,
      username: data.username,
      newBalance: newBal
    });

    // hazır oyunçular 10s countdown ilə raundu başlada bilər
    const readyPlayers = room.players.filter(p => p.status === 'ready');
    if (readyPlayers.length >= 2 && !room.startTimerActive) {
      room.startTimerActive = true;
      let timeLeft = 10;
      const countdown = setInterval(() => {
        io.to(data.roomId).emit('start_countdown', { timeLeft });
        timeLeft--;
        if (timeLeft < 0) {
          clearInterval(countdown);
          startSekaRound(data.roomId);
        }
      }, 1000);
    }
  });

  // təklif cavabı (split / seka)
  socket.on('offer_response', async (data) => {
    const room = rooms[data.roomId];
    if (!room) return;

    if (data.accepted) {
      if (data.type === 'offer_split') {
        // split: ortadakı məbləği aktiv oyunçulara bərabər böl və balanslara əlavə et
        const activePlayers = room.players.filter(p => p.status === 'active');
        if (activePlayers.length === 0) return;
        const share = parseFloat((room.totalBank / activePlayers.length).toFixed(2));
        for (let p of activePlayers) {
          await updateDbBalance(p.username, share);
        }
        io.to(data.roomId).emit('game_over', {
          winner: "BÖLÜNDÜ",
          winAmount: share,
          isSplit: true
        });
        finishGame(data.roomId, { username: "BÖLÜNDÜ" });
      } else if (data.type === 'offer_seka') {
        // seka: seka pending vəziyyətinə keç və digər oyunçulara seka üçün requiredAmount bildir
        room.status = 'seka_pending';
        const requiredAmount = parseFloat((room.totalBank / 2).toFixed(2));
        io.to(data.roomId).emit('seka_started', { requiredAmount });
        // seka üçün 10s deadline; qəbul edənlər requiredAmount ödəyib raunda daxil ola bilərlər
        if (sekaTimers[roomId]) clearTimeout(sekaTimers[roomId]);
        sekaTimers[roomId] = setTimeout(() => {
          // seka müddəti bitdi, seka pending-ləri ləğv et
          room.status = 'playing';
          delete sekaTimers[roomId];
          io.to(data.roomId).emit('seka_ended');
        }, 10000);
      }
    } else {
      // rədd edildisə təklif göndərənə məlumat ver
      const sender = room.players.find(p => p.username === data.from);
      if (sender) {
        io.to(sender.id).emit('error_message', 'Təklif rədd edildi.');
      }
    }
  });

  // oyun gedişləri
  socket.on('make_move', async (data) => {
    const room = rooms[data.roomId];
    if (!room) return;

    const activePlayers = room.players.filter(p => p.status === 'active');
    const currentPlayer = activePlayers[room.turnIndex];

    // pass / fold (istənilən vaxt)
    if (data.moveType === 'pass' || data.moveType === 'fold') {
      const p = room.players.find(u => u.username === data.username);
      if (p) {
        p.status = 'folded';
        io.to(data.roomId).emit('move_made', { username: data.username, moveType: 'fold' });

        const rem = room.players.filter(p => p.status === 'active');
        if (rem.length === 1) return finishGame(data.roomId, rem[0]);
        if (currentPlayer && currentPlayer.username === data.username) nextTurn(data.roomId);
      }
      return;
    }

    // növbəli gedislər: yalnız növbədə olan oyunçu
    if (!currentPlayer || currentPlayer.username !== data.username) return;

    if (data.moveType === 'raise') {
      const amount = parseFloat(data.amount);
      if (isNaN(amount) || amount < room.lastBet) {
        return socket.emit('error_message', 'Minimum mərcdən az qoymaq olmaz!');
      }

      // cari oyunçunun əvvəlki bet fərqini çıx
      const player = room.players.find(p => p.username === data.username);
      const diff = parseFloat((amount - (player.currentBet || 0)).toFixed(2));
      if (diff > 0) {
        const newBal = await updateDbBalance(data.username, -diff);
        if (newBal === null) {
          socket.emit('error_message', 'Balans yenilənmədi.');
          return;
        }
        player.currentBet = amount;
        room.totalBank = parseFloat((room.totalBank + diff).toFixed(2));
        room.lastBet = amount;
      }

      io.to(data.roomId).emit('update_game_state', { players: room.players, totalBank: room.totalBank, lastBet: room.lastBet, activePlayer: data.username });
      // əgər raundda 2-dən çox oyunçu varsa növbə dərhal keçsin
      if (room.players.filter(p => p.status === 'active').length > 2) {
        nextTurn(data.roomId);
      } else {
        // final iki oyunçu qaldıqda, show düyməsi clientdə 10s üçün göstərilə bilər
        io.to(data.roomId).emit('final_two_raise', { by: data.username, amount });
      }
    } else if (data.moveType === 'offer_seka' || data.moveType === 'offer_split') {
      const opponent = activePlayers.find(p => p.username !== data.username);
      if (opponent) {
        io.to(opponent.id).emit('offer_received', { type: data.moveType, from: data.username });
      }
    } else if (data.moveType === 'show') {
      // iki oyunçu kartlarını açır və müqayisə edilir
      const pActive = room.players.filter(p => p.status === 'active');
      if (pActive.length === 2) {
        const [p1, p2] = pActive;
        if (p1.score === p2.score) {
          // seka: 5% komissiya serverdə tutulur, sonra bank qaydaya görə bölünə bilər
          io.to(data.roomId).emit('seka_event', { message: "Xallar bərabərdir! SEKA başladı!" });
          // burada seka məntiqi daha geniş tətbiq oluna bilər
        } else {
          finishGame(data.roomId);
        }
      }
    }
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(roomId => {
      const room = rooms[roomId];
      const pIndex = room.players.findIndex(p => p.id === socket.id);
      if (pIndex !== -1) {
        room.players.splice(pIndex, 1);
        if (room.players.length === 0) {
          delete rooms[roomId];
        } else {
          io.to(roomId).emit('update_players', { players: room.players });
        }
      }
    });
    broadcastRooms();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Seka Server ${PORT} portunda aktivdir...`);
});
