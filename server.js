'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');
const Room = require('./server/Room');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-store');
  },
}));

const rooms = new Map();
const ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';

function generateRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function generatePlayerId() { return crypto.randomBytes(8).toString('hex'); }
function sanitizeName(name) {
  if (!name || typeof name !== 'string') return 'Player';
  return name.trim().slice(0, 16) || 'Player';
}

// Purge empty rooms every minute
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.isEmpty()) { room.destroy(); rooms.delete(code); }
  }
}, 60000);

// Heartbeat to detect dead connections
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.playerId = null;
  ws.roomCode = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    if (ws.roomCode && ws.playerId) {
      const room = rooms.get(ws.roomCode);
      if (room) {
        room.handleDisconnect(ws.playerId, ws);
        if (room.isEmpty()) { room.destroy(); rooms.delete(ws.roomCode); }
      }
    }
  });
});

function handleMessage(ws, msg) {
  switch (msg.type) {

    case 'create_room': {
      const name = sanitizeName(msg.playerName);
      const code = generateRoomCode();
      const playerId = generatePlayerId();
      const room = new Room(code);
      rooms.set(code, room);
      room.addPlayer(playerId, name, ws);
      ws.playerId = playerId;
      ws.roomCode = code;
      ws.send(JSON.stringify({ type: 'room_created', roomCode: code, playerId, ...room.getState() }));
      break;
    }

    case 'join_room': {
      const code = (msg.roomCode || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found' })); return; }
      const name = sanitizeName(msg.playerName);
      const playerId = generatePlayerId();
      const result = room.addPlayer(playerId, name, ws);
      if (!result.success) { ws.send(JSON.stringify({ type: 'error', message: result.error })); return; }
      ws.playerId = playerId;
      ws.roomCode = code;
      ws.send(JSON.stringify({ type: 'room_joined', roomCode: code, playerId, ...room.getState() }));
      room.broadcastExcept(playerId, { type: 'player_joined', ...room.getState() });
      break;
    }

    case 'reconnect': {
      const code = (msg.roomCode || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found' })); return; }
      const result = room.reconnect(msg.playerId, ws);
      if (!result.success) { ws.send(JSON.stringify({ type: 'error', message: result.error })); return; }
      ws.playerId = msg.playerId;
      ws.roomCode = code;
      // Notify game of reconnection so it can update connected state
      if (room.game) room.game.markReconnected(msg.playerId);
      ws.send(JSON.stringify({ type: 'reconnected', playerId: msg.playerId, ...room.getFullState() }));
      room.broadcastExcept(msg.playerId, { type: 'player_reconnected', playerId: msg.playerId, ...room.getState() });
      break;
    }

    case 'start_game': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (room.hostId !== ws.playerId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Only the host can start' })); return;
      }
      const r = room.startGame();
      if (!r.success) ws.send(JSON.stringify({ type: 'error', message: r.error }));
      break;
    }

    case 'play_again': {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      if (room.hostId !== ws.playerId) {
        ws.send(JSON.stringify({ type: 'error', message: 'Only the host can restart' })); return;
      }
      room.playAgain();
      break;
    }

    case 'game_action': {
      const room = rooms.get(ws.roomCode);
      if (!room || !room.game) return;
      const r = room.game.handleAction(ws.playerId, msg.action);
      if (r && !r.success) ws.send(JSON.stringify({ type: 'error', message: r.error }));
      break;
    }

    case 'leave_room': {
      if (ws.roomCode && ws.playerId) {
        const room = rooms.get(ws.roomCode);
        if (room) {
          room.removeOccupant(ws.playerId);
          if (room.isEmpty()) { room.destroy(); rooms.delete(ws.roomCode); }
        }
      }
      ws.playerId = null;
      ws.roomCode = null;
      ws.send(JSON.stringify({ type: 'left_room' }));
      break;
    }

    default:
      ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`DOORS server running on port ${PORT}`));
