'use strict';

const Game = require('./Game');
const Player = require('./Player');

const MAX_PLAYERS = 5;
const MIN_PLAYERS_TO_START = 4;
// 60-second reconnection window per the DOORS spec.
const DISCONNECT_GRACE_MS = 60000;
// Shorter grace for lobby/finished disconnects so a refresh isn't a hard kick.
const LOBBY_DISCONNECT_GRACE_MS = 30000;
// Tick interval for broadcasting the countdown to remaining players.
const COUNTDOWN_TICK_MS = 1000;

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // insertion-ordered Map<id, Player>
    this.hostId = null;
    this.game = null;
    this.state = 'lobby'; // lobby | playing | finished
    this.graceTimers = new Map();    // playerId → { timeout, interval, remaining }
  }

  // ── Lobby management ──────────────────────────────────────────────

  addPlayer(playerId, name, ws) {
    if (this.state !== 'lobby') return { success: false, error: 'Game already in progress' };
    if (this.players.size >= MAX_PLAYERS) return { success: false, error: 'Room is full' };
    const player = new Player(playerId, name, ws);
    this.players.set(playerId, player);
    if (!this.hostId) this.hostId = playerId;
    return { success: true };
  }

  getPlayer(playerId) { return this.players.get(playerId); }
  hasPlayer(playerId) { return this.players.has(playerId); }

  isEmpty() {
    if (this.players.size === 0) return true;
    for (const p of this.players.values()) if (p.connected) return false;
    return true;
  }

  connectedCount() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  // ── Disconnect / reconnect ────────────────────────────────────────

  handleDisconnect(playerId, oldWs) {
    const player = this.players.get(playerId);
    if (!player) return;
    // If the player has already reconnected via a different ws (e.g. tab refresh
    // races the old socket's close event), ignore the stale disconnect.
    if (oldWs && player.ws && player.ws !== oldWs) return;
    player.connected = false;
    player.ws = null;

    if (this.state === 'lobby') {
      // Keep the slot reserved briefly so a tab-refresh can rejoin.
      this.broadcast({ type: 'player_disconnected', playerId, playerName: player.name, ...this.getState() });
      this._startLobbyGraceTimer(playerId);
      return;
    }

    if (this.state === 'playing' && this.game) {
      this._startGraceTimer(playerId);
      return;
    }

    // finished — leave the player in the list but mark disconnected
    // (summary screen is still visible to connected players)
    this.broadcast({ type: 'player_disconnected', playerId, ...this.getState() });
  }

  removeOccupant(playerId) {
    // Deliberate leave from lobby
    if (this.state === 'lobby') {
      this._removeLobbyPlayer(playerId);
    }
    // During a game, voluntary leave is handled as disconnect (no fast-path)
    // The spec doesn't distinguish voluntary quit from drop — both go through
    // the 60s grace window.
  }

  reconnect(playerId, ws) {
    const player = this.players.get(playerId);
    if (!player) return { success: false, error: 'Player not found in this room' };
    player.ws = ws;
    player.connected = true;
    this._clearGraceTimer(playerId);
    return { success: true };
  }

  // ── Grace timers ──────────────────────────────────────────────────

  _startGraceTimer(playerId) {
    this._clearGraceTimer(playerId);
    const player = this.players.get(playerId);
    if (!player) return;

    let remaining = DISCONNECT_GRACE_MS;

    // Announce disconnect + initial countdown
    this.broadcast({
      type: 'player_disconnected',
      playerId,
      playerName: player.name,
      graceMs: remaining,
      ...this.getState(),
    });

    // Tick every second to update the countdown
    const interval = setInterval(() => {
      remaining -= COUNTDOWN_TICK_MS;
      if (remaining <= 0) return; // timeout will fire
      this.broadcast({ type: 'disconnect_tick', playerId, remainingMs: remaining });
    }, COUNTDOWN_TICK_MS);

    const timeout = setTimeout(() => {
      clearInterval(interval);
      this.graceTimers.delete(playerId);
      this._onGraceExpired(playerId);
    }, DISCONNECT_GRACE_MS);

    this.graceTimers.set(playerId, { timeout, interval });
  }

  _clearGraceTimer(playerId) {
    const entry = this.graceTimers.get(playerId);
    if (entry) {
      clearTimeout(entry.timeout);
      if (entry.interval) clearInterval(entry.interval);
      this.graceTimers.delete(playerId);
    }
  }

  _startLobbyGraceTimer(playerId) {
    this._clearGraceTimer(playerId);
    const timeout = setTimeout(() => {
      this.graceTimers.delete(playerId);
      const p = this.players.get(playerId);
      if (!p || p.connected) return;
      // Grace expired without rejoin — actually remove from lobby.
      if (this.state === 'lobby') this._removeLobbyPlayer(playerId);
    }, LOBBY_DISCONNECT_GRACE_MS);
    this.graceTimers.set(playerId, { timeout, interval: null });
  }

  _onGraceExpired(playerId) {
    const player = this.players.get(playerId);
    if (!player || player.connected) return; // already reconnected
    if (this.state !== 'playing' || !this.game) return;
    this.game.eliminatePlayer(playerId, 'disconnect');
  }

  // ── Game lifecycle ────────────────────────────────────────────────

  startGame() {
    if (this.state !== 'lobby') return { success: false, error: 'Game already started' };
    if (this.players.size < MIN_PLAYERS_TO_START) {
      return { success: false, error: `Need at least ${MIN_PLAYERS_TO_START} players to start` };
    }
    this.state = 'playing';
    this.game = new Game(this.players, this.broadcast.bind(this), this._onGameEnd.bind(this));
    this.game.start();
    return { success: true };
  }

  playAgain() {
    if (this.game) { this.game.destroy(); this.game = null; }
    for (const entry of this.graceTimers.values()) {
      clearTimeout(entry.timeout);
      clearInterval(entry.interval);
    }
    this.graceTimers.clear();
    this.state = 'playing';
    this.game = new Game(this.players, this.broadcast.bind(this), this._onGameEnd.bind(this));
    this.game.start();
    return { success: true };
  }

  _onGameEnd() {
    this.state = 'finished';
  }

  // ── Broadcast helpers ─────────────────────────────────────────────

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.connected && p.ws && p.ws.readyState === 1) p.ws.send(data);
    }
  }

  broadcastExcept(excludeId, msg) {
    const data = JSON.stringify(msg);
    for (const [id, p] of this.players) {
      if (id === excludeId) continue;
      if (p.connected && p.ws && p.ws.readyState === 1) p.ws.send(data);
    }
  }

  // ── State helpers ─────────────────────────────────────────────────

  getState() {
    return {
      roomCode: this.code,
      hostId: this.hostId,
      roomState: this.state,
      players: Array.from(this.players.values()).map(p => p.toJSON()),
    };
  }

  getFullState() {
    const s = this.getState();
    if (this.game) Object.assign(s, this.game.getPublicState());
    return s;
  }

  // ── Private helpers ───────────────────────────────────────────────

  _removeLobbyPlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    const playerName = player.name;
    this.players.delete(playerId);
    if (this.hostId === playerId) {
      const next = this.players.keys().next();
      this.hostId = next.done ? null : next.value;
    }
    this.broadcast({ type: 'player_left', playerId, playerName, ...this.getState() });
  }

  destroy() {
    for (const entry of this.graceTimers.values()) {
      clearTimeout(entry.timeout);
      clearInterval(entry.interval);
    }
    this.graceTimers.clear();
    if (this.game) this.game.destroy();
  }
}

module.exports = Room;
