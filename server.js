const mongoose = require('mongoose');
const http = require('http');

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end("Seka Server is Live!");
});

const io = require('socket.io')(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling']
});

const uri = "mongodb+srv://admin:123@cluster0.1xrr77f.mongodb.net/seka_game?retryWrites=true&w=majority";

mongoose.connect(uri)
    .then(() => console.log("✅ MongoDB connected"))
    .catch(err => console.log("Mongo error:", err.message));

/* ===================== DB ===================== */

const UserSchema = new mongoose.Schema({
    username: { type: String, unique: true },
    balance: { type: Number, default: 1000 }
});
const User = mongoose.model('User', UserSchema);

/* ===================== MEMORY ===================== */

let rooms = {};
let turnTimers = {};

/* ===================== HELPERS ===================== */

async function updateBalance(username, amount) {
    const user = await User.findOneAndUpdate(
        { username },
        { $inc: { balance: amount } },
        { new: true }
    );
    return user ? user.balance : 0;
}

function calculateScore(hand) {
    const tuses = hand.filter(c => c.value === 'T');
    if (tuses.length === 3) return 33;
    if (tuses.length === 2) return 22;

    let max = 0;
    ['Hearts','Spades','Clubs','Diamonds'].forEach(s => {
        const sum = hand
            .filter(c => c.suit === s)
            .reduce((a,b)=>a+b.score,0);
        if (sum > max) max = sum;
    });
    return max;
}

function shuffleAndDeal(players) {
    const suits = ['Hearts','Spades','Clubs','Diamonds'];
    const values = [
        { v:'6', s:6 }, { v:'7', s:7 }, { v:'8', s:8 },
        { v:'9', s:9 }, { v:'10', s:10 },
        { v:'B', s:10 }, { v:'D', s:10 },
        { v:'K', s:10 }, { v:'T', s:11 }
    ];

    let deck = [];
    suits.forEach(suit=>{
        values.forEach(val=>{
            deck.push({ suit, value:val.v, score:val.s });
        });
    });

    deck.sort(()=>Math.random()-0.5);

    players.forEach(p=>{
        p.hand = [deck.pop(), deck.pop(), deck.pop()];
        p.score = calculateScore(p.hand);
        p.status = 'active';
    });
}

function nextTurn(roomId){
    const room = rooms[roomId];
    if(!room || room.status !== 'playing') return;

    const active = room.players.filter(p=>p.status==='active');

    if(active.length < 2){
        finishGame(roomId);
        return;
    }

    room.turnIndex = (room.turnIndex + 1) % active.length;
    const player = active[room.turnIndex];

    io.to(roomId).emit('next_turn',{
        activePlayer: player.username,
        totalBank: room.totalBank,
        lastBet: room.lastBet
    });

    if(turnTimers[roomId]) clearTimeout(turnTimers[roomId]);

    turnTimers[roomId] = setTimeout(()=>{
        const activePlayers = room.players.filter(p=>p.status==='active');
        const current = activePlayers[room.turnIndex];
        if(current){
            current.status = 'folded';
            io.to(roomId).emit('update_game_state',{
                players: room.players,
                totalBank: room.totalBank
            });
            nextTurn(roomId);
        }
    },30000);
}

async function finishGame(roomId){
    const room = rooms[roomId];
    if(!room) return;

    if(turnTimers[roomId]) clearTimeout(turnTimers[roomId]);

    const active = room.players.filter(p=>p.status==='active');

    if(active.length === 0){
        room.status='waiting';
        return;
    }

    const winner = active.sort((a,b)=>b.score-a.score)[0];

    const newBal = await updateBalance(winner.username, room.totalBank);

    io.to(roomId).emit('game_over',{
        winner: winner.username,
        winAmount: room.totalBank,
        newBalance: newBal,
        allHands: room.players
    });

    room.status='waiting';
    room.totalBank=0;
    room.lastBet=0.20;

    room.players.forEach(p=>{
        p.status='waiting';
        p.hand=[];
        p.score=0;
    });
}

/* ===================== SOCKET ===================== */

io.on('connection',(socket)=>{

    socket.on('join_room', async (data)=>{
        let user = await User.findOne({ username:data.username });
        if(!user){
            user = await User.create({ username:data.username });
        }
        socket.emit('login_confirmed', user);
    });

    socket.on('create_room',(data)=>{
        const id = "room_"+Date.now();
        rooms[id]={
            id,
            players:[{
                username:data.username,
                id:socket.id,
                status:'waiting',
                hand:[],
                score:0
            }],
            totalBank:0,
            lastBet:0.20,
            status:'waiting',
            turnIndex:0
        };
        socket.join(id);
        socket.emit('room_created', rooms[id]);
    });

    socket.on('enter_round', async (data)=>{
        const room = rooms[data.roomId];
        if(!room) return;

        const player = room.players.find(p=>p.username===data.username);
        if(!player || player.status!=='waiting') return;

        const dbUser = await User.findOne({ username:data.username });
        if(dbUser.balance < 0.20){
            socket.emit('error','Balans azdır');
            return;
        }

        await updateBalance(data.username,-0.20);
        player.status='ready';
        room.totalBank+=0.20;

        const ready = room.players.filter(p=>p.status==='ready');

        if(ready.length>=2){
            room.status='playing';
            shuffleAndDeal(ready);
            room.turnIndex=0;

            io.to(data.roomId).emit('battle_start',{
                players:room.players,
                totalBank:room.totalBank,
                activePlayer: ready[0].username,
                lastBet:0.20
            });
        }
    });

    socket.on('make_move', async (data)=>{
        const room = rooms[data.roomId];
        if(!room || room.status!=='playing') return;

        let active = room.players.filter(p=>p.status==='active');
        let current = active[room.turnIndex];

        // PASS növbəsiz
        if(data.moveType!=='pass'){
            if(!current || current.username!==data.username) return;
        }

        if(data.moveType==='raise'){
            const bet = parseFloat(data.amount);
            const dbUser = await User.findOne({ username:data.username });

            if(dbUser.balance < bet){
                socket.emit('error','Balans çatmır');
                return;
            }

            await updateBalance(data.username,-bet);
            room.totalBank+=bet;
            room.lastBet=bet;

            nextTurn(data.roomId);
        }

        else if(data.moveType==='pass'){
            const player = room.players.find(p=>p.username===data.username);
            if(player) player.status='folded';

            const remain = room.players.filter(p=>p.status==='active');
            if(remain.length<2){
                finishGame(data.roomId);
            }else{
                nextTurn(data.roomId);
            }
        }

        else if(data.moveType==='show'){
            finishGame(data.roomId);
        }

        else if(data.moveType==='offer_split'){
            const activePlayers = room.players.filter(p=>p.status==='active');
            if(activePlayers.length===2){
                const opponent = activePlayers.find(p=>p.username!==data.username);
                io.to(opponent.id).emit('offer_received',{
                    type:'offer_split',
                    from:data.username
                });
            }
        }

        else if(data.moveType==='offer_seka'){
            const activePlayers = room.players.filter(p=>p.status==='active');
            if(activePlayers.length===2){
                const opponent = activePlayers.find(p=>p.username!==data.username);
                io.to(opponent.id).emit('offer_received',{
                    type:'offer_seka',
                    from:data.username
                });
            }
        }
    });

    socket.on('offer_response', async (data)=>{
        const room = rooms[data.roomId];
        if(!room) return;

        const active = room.players.filter(p=>p.status==='active');
        if(active.length!==2) return;

        if(data.type==='offer_split' && data.accepted){
            const half = room.totalBank/2;

            for(let p of active){
                await updateBalance(p.username, half);
            }

            io.to(data.roomId).emit('game_over',{
                winner:"50/50",
                winAmount:half
            });

            room.status='waiting';
            room.totalBank=0;
        }

        if(data.type==='offer_seka' && data.accepted){
            io.to(data.roomId).emit('seka_started');
        }
    });

});

server.listen(PORT,'0.0.0.0',()=>{
    console.log("🚀 Server running on "+PORT);
});
