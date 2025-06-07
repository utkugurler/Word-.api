const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const GameManager = require('./gameManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*'
  }
});

app.use(cors());

const PORT = process.env.PORT || 3001;
const ROOMS_FILE = path.join(__dirname, 'rooms.json');
let rooms = {};

// Yardımcı: rooms'u dosyaya kaydet
function saveRoomsToFile() {
  const replacer = (key, value) => {
    // roundTimer gibi circular/fonksiyonel property'leri kaydetme
    if (key === 'roundTimer' || typeof value === 'function') {
      return undefined;
    }
    // GameManager instance'ı ve fonksiyonları serialize etme
    if (key === 'game' && value instanceof GameManager) {
      return { ...value, _isGameManager: true };
    }
    return value;
  };
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, replacer, 2));
}
// Yardımcı: dosyadan rooms'u yükle
function loadRoomsFromFile() {
  if (fs.existsSync(ROOMS_FILE)) {
    try {
      const raw = fs.readFileSync(ROOMS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      // GameManager instance'ını tekrar oluştur
      for (const roomId in parsed) {
        if (parsed[roomId].game && parsed[roomId].game._isGameManager) {
          parsed[roomId].game = new GameManager();
        }
      }
      rooms = parsed;
    } catch (e) {
      console.error('rooms.json okunamadı:', e);
    }
  }
}
// Sunucu başlarken yükle
loadRoomsFromFile();

io.on('connection', (socket) => {
  console.log(`🔌 ${socket.id} connected`);

  socket.on('set_username', (username) => {
    socket.data.username = username;
    socket.emit('username_set', username);
    socket.emit('your_id', socket.id);
  });

  socket.on('create_room', (roomName) => {
    const roomId = `room-${Math.random().toString(36).substring(2, 8)}`;
    rooms[roomId] = {
      host: socket.id,
      players: [socket.id],
      name: roomName || roomId,
      game: new GameManager(),
      readyStates: { [socket.id]: false }
    };
    saveRoomsToFile();
    socket.join(roomId);
    socket.emit('room_created', roomId);
    io.to(roomId).emit('room_update', getRoomState(roomId));
    io.emit('rooms_update', getAllRoomsState());
  });

  socket.on('join_room', (roomId) => {
    if (!rooms[roomId]) return socket.emit('error_msg', 'Room not found');
    rooms[roomId].players.push(socket.id);
    // Her oyuncu için isReady başta false
    if (!rooms[roomId].readyStates) rooms[roomId].readyStates = {};
    rooms[roomId].readyStates[socket.id] = false;
    saveRoomsToFile();
    socket.join(roomId);
    io.to(roomId).emit('room_update', getRoomState(roomId));
    io.emit('rooms_update', getAllRoomsState());
  });

  socket.on('start_game', (roomId) => {
    const room = rooms[roomId];
    if (room && socket.id === room.host) {
      // Tüm oyuncular hazır mı kontrolü
      const allReady = room.players.length >= 2 && room.players.every(pid => room.readyStates && room.readyStates[pid]);
      if (!allReady) {
        socket.emit('error_msg', 'Tüm oyuncular hazır olmalı!');
        return;
      }
      room.game.startGame();
      // Oyun başlatıldığında önce game_started, ardından ilk round_end eventini gönder
      io.to(roomId).emit('game_started', { ...room.game.getState(), roundTime: 30, players: getRoomState(roomId).players });
      io.to(roomId).emit('round_end', { 
        ...room.game.getState(), 
        roundTime: 30, 
        players: getRoomState(roomId).players,
        currentRound: room.game.round
      });
      // --- ROUND TIMER BAŞLAT ---
      if (room.roundTimer) clearTimeout(room.roundTimer);
      const startNextRound = () => {
        // Eğer mevcut round < maxRounds ise yeni round başlat
        if (room.game.round < room.game.maxRounds) {
          room.game.round++;
          room.game.startNewRound();
          io.to(roomId).emit('round_end', { 
            ...room.game.getState(), 
            roundTime: 30, 
            players: getRoomState(roomId).players,
            currentRound: room.game.round
          });
          if (room.game.round < room.game.maxRounds) {
            room.roundTimer = setTimeout(startNextRound, 30000);
          } else {
            // Son round oynandıktan sonra 30 saniye beklemeden game_over gönder
            setTimeout(() => {
              io.to(roomId).emit('game_over', room.game.getState());
              room.roundTimer = null;
            }, 30000);
          }
        }
      };
      room.roundTimer = setTimeout(startNextRound, 30000);
    }
  });

  socket.on('submit_word', async ({ roomId, word }) => {
    const username = socket.data.username;
    const room = rooms[roomId];
    if (!room) return;
    const result = await room.game.submitWord(username, word);
    io.to(roomId).emit('word_result', { 
      ...result, 
      players: getRoomState(roomId).players,
      currentRound: room.game.round,
      currentRound: room.game.round
    });
    if (result.gameOver) {
      io.to(roomId).emit('game_over', room.game.getState());
    }
  });

  socket.on('send_message', ({ roomId, message }) => {
    const username = socket.data.username;
    io.to(roomId).emit('new_message', {
      username,
      message
    });
  });

  socket.on('disconnect', () => {
    console.log(`❌ ${socket.id} disconnected`);
    // Oda temizlik işlemleri
    for (const roomId in rooms) {
      const room = rooms[roomId];
      room.players = room.players.filter((id) => id !== socket.id);
      if (room.readyStates) {
        delete room.readyStates[socket.id];
      }
      if (room.players.length === 0) {
        delete rooms[roomId];
      } else {
        // Host ayrılırsa yeni host ata
        if (room.host === socket.id) {
          room.host = room.players[0];
        }
      }
    }
    saveRoomsToFile();
    io.emit('rooms_update', getAllRoomsState());
  });

  socket.on('toggle_ready', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    if (!room.readyStates) room.readyStates = {};
    room.readyStates[socket.id] = !room.readyStates[socket.id];
    saveRoomsToFile();
    io.to(roomId).emit('room_update', getRoomState(roomId));
    io.emit('rooms_update', getAllRoomsState());
  });

  // Kullanıcı odadan çıkmak istiyor
  socket.on('leave_room', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    room.players = room.players.filter((id) => id !== socket.id);
    if (room.readyStates) {
      delete room.readyStates[socket.id];
    }
    // Eğer oyun başladıysa ve oyuncu çıkarsa, oyunu sıfırla
    if (room.game && room.players.length > 0 && room.game.round > 1) {
      // Yeni bir GameManager başlat
      room.game = new GameManager();
      // Ready state'leri sıfırla
      room.readyStates = {};
      room.isGameStarted = false;
      // Herkese oyun sıfırlandı bildirimi gönder
      io.to(roomId).emit('game_reset', getRoomState(roomId));
    }
    if (room.players.length === 0) {
      delete rooms[roomId];
    } else {
      if (room.host === socket.id) {
        // Host çıkarsa odayı tamamen kapat, herkesi lobiye at
        io.to(roomId).emit('room_closed');
        delete rooms[roomId];
        saveRoomsToFile();
        io.emit('rooms_update', getAllRoomsState());
        return;
      } else {
        room.host = room.players[0];
      }
    }
    saveRoomsToFile();
    io.to(roomId).emit('room_update', getRoomState(roomId));
    io.emit('rooms_update', getAllRoomsState());
  });
});

function getRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return {};
  return {
    id: roomId,
    name: room.name,
    players: room.players.map((id) => {
      let username = io.sockets.sockets.get(id)?.data.username;
      // Eğer username bulunamazsa, room.game.players içindeki ilk key'i kullan
      if (!username) {
        const keys = Object.keys(room.game.players);
        username = keys[0] || 'Unknown';
      }
      if (room.game.players[username] === undefined) {
        room.game.players[username] = 0;
      }
      // DEBUG
      console.log('getRoomState player:', { id, username, score: room.game.players[username] });
      return {
        id,
        name: username,
        isReady: room.readyStates ? room.readyStates[id] : false,
        score: room.game.players[username],
        isActive: false // İleride aktif oyuncu mantığı eklenirse güncellenir
      };
    }),
    host: room.host
  };
}

// Tüm odaların özetini döner
function getAllRoomsState() {
  return Object.entries(rooms).map(([roomId, room]) => ({
    id: roomId,
    name: room.name || roomId,
    players: room.players.map((id) => ({
      id,
      name: io.sockets.sockets.get(id)?.data.username || id, // id göster
      isReady: room.readyStates ? room.readyStates[id] : false
    })),
    maxPlayers: 2,
    isGameStarted: false,
    currentRound: 1,
    totalRounds: 10
  }));
}

server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
