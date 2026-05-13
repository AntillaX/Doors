'use strict';

const bank = require('./PuzzleBank');
const PuzzleSelector = require('./PuzzleSelector');

const STARTING_POINTS = 10;
const TOTAL_ROOMS = 10;                   // v2: 10 for both 4p and 5p
const CORRECT_PENALTY = 3;
const WRONG_PENALTY = 5;
const GAME_DURATION_MS = 30 * 60 * 1000;
const GAME_TIMER_INTERVAL_MS = 5000;
const MIN_ACTIVE_PLAYERS = 3;
const PRE_GAME_DELAY_MS = 45000;          // countdown before room 1 opens

// v2 timing budgets — configurable so v3 visuals can tune independently.
const ROOM_ENTRY_BEAT_MS = 1000;          // Roman numeral + room-entry pause before vote
const CORRECT_ANSWER_VERDICT_MS = 1000;   // gold flash on deliverer after correct
const ROOM_CLEARED_PAUSE_MS = 2000;       // door-open pause before next room (v3 fills with animation)
const WRONG_ANSWER_VERDICT_MS = 1000;     // amber pulse + verdict text on deliverer
const WRONG_NEW_PUZZLE_FADE_MS = 500;     // failed puzzle fades, new puzzle fades in

const ROMAN = ['I','II','III','IV','V','VI','VII','VIII','IX','X'];

class Game {
  constructor(players, broadcast, onGameEnd) {
    this.broadcast = broadcast;
    this.onGameEnd = onGameEnd || (() => {});
    const playerCount = players.size;
    this.playerCount = playerCount;
    this.totalRooms = TOTAL_ROOMS;
    this.maxLevel4  = playerCount >= 5 ? 2 : 1;
    this.selector = new PuzzleSelector(this.maxLevel4);

    // Per-player game state. Keyed by id.
    this.players = new Map();
    for (const [id, p] of players) {
      this.players.set(id, {
        id, name: p.name,
        points: STARTING_POINTS,
        connected: p.connected,
        eliminated: false,
        eliminatedRoom: null,
        eliminationCause: null,
        deliveriesAttempted: 0,
        deliveriesCorrect: 0,
        deliveriesWrong: 0,
      });
    }

    this.phase = 'lobby';
    this.currentRoom = 0;
    this.roomsCleared = 0;
    this.puzzle = null;          // full resolved puzzle (includes _answer — never broadcast)

    this.readyPlayers = new Set();
    this.votes = new Map();      // voterId → targetId
    this.delivererId = null;
    this.delivererText = '';

    this.gameStartTime = null;
    this.gameTimerInterval = null;
    this.phaseTimeout = null;
    this.gameEnded = false;
  }

  start() {
    this.gameStartTime = Date.now();
    this.gameTimerInterval = setInterval(() => this._tickGameTimer(), GAME_TIMER_INTERVAL_MS);
    this.readyPlayers = new Set();
    this.phase = 'game_starting';
    this.broadcast({ type: 'game_starting', countdown: Math.ceil(PRE_GAME_DELAY_MS / 1000), ...this.getPublicState() });
    this._schedulePhase(() => this._startRoom(1), PRE_GAME_DELAY_MS);
  }

  playerReady(playerId) {
    if (this.phase !== 'game_starting') return { success: false, error: 'Not in pre-game phase' };
    const ps = this.players.get(playerId);
    if (!ps || ps.eliminated) return { success: false, error: 'Player not found' };
    this.readyPlayers.add(playerId);
    const connected = this._activePlayers().filter(p => p.connected);
    const allReady = connected.length > 0 && connected.every(p => this.readyPlayers.has(p.id));
    this.broadcast({ type: 'player_ready', playerId, ...this.getPublicState() });
    if (allReady) {
      this._clearPhaseTimeout();
      this._startRoom(1);
    }
    return { success: true };
  }

  // ── Room lifecycle ────────────────────────────────────────────────

  _startRoom(roomNumber) {
    this.currentRoom = roomNumber;
    this.votes = new Map();
    this.delivererId = null;
    this.delivererText = '';

    const template = this.selector.selectForRoom(roomNumber, this.roomsCleared);
    this.puzzle = bank.resolve(template);

    // Flash time: per-item duration × item count, or total ms for grid/flash_text.
    const flashMs = this.puzzle.flashTotalMs || 0;

    this.phase = 'room_puzzle';
    this.broadcast({ type: 'room_started', ...this.getPublicState() });

    // After room entry beat + any flash sequence, open voting.
    this._schedulePhase(() => this._openVote(), ROOM_ENTRY_BEAT_MS + flashMs);
  }

  _openVote() {
    if (this.gameEnded) return;
    this.votes = new Map();
    this.delivererId = null;
    this.phase = 'room_vote';
    this.broadcast({ type: 'vote_opened', ...this.getPublicState() });
  }

  // ── Voting ────────────────────────────────────────────────────────

  castVote(voterId, targetId) {
    if (this.phase !== 'room_vote') return { success: false, error: 'Not in vote phase' };

    const voter = this.players.get(voterId);
    const target = this.players.get(targetId);
    if (!voter || voter.eliminated || !voter.connected) return { success: false, error: 'Cannot vote' };
    if (!target || target.eliminated || !target.connected) return { success: false, error: 'Invalid target' };
    if (voterId === targetId) return { success: false, error: 'Cannot vote for yourself' };

    this.votes.set(voterId, targetId);
    this.broadcast({ type: 'vote_cast', voterId, targetId, tally: this._computeTally(), ...this.getPublicState() });
    this._checkMajority();
    return { success: true };
  }

  _computeTally() {
    const activeIds = new Set(this._activePlayers().map(p => p.id));
    const tally = {};
    for (const [vid, tid] of this.votes) {
      if (!activeIds.has(vid) || !activeIds.has(tid)) continue;
      tally[tid] = (tally[tid] || 0) + 1;
    }
    return tally;
  }

  _checkMajority() {
    if (this.phase !== 'room_vote') return;
    const active = this._activePlayers();
    const threshold = Math.ceil((active.length + 1) / 2);
    const tally = this._computeTally();
    for (const [targetId, count] of Object.entries(tally)) {
      if (count >= threshold) {
        this._selectDeliverer(targetId);
        return;
      }
    }
  }

  _selectDeliverer(delivererId) {
    this.delivererId = delivererId;
    this.delivererText = '';
    this.phase = 'room_deliver';
    this.broadcast({ type: 'deliverer_selected', delivererId, ...this.getPublicState() });
  }

  // ── Delivery ──────────────────────────────────────────────────────

  delivererTyping(playerId, text) {
    if (this.phase !== 'room_deliver') return { success: false, error: 'Not in deliver phase' };
    if (playerId !== this.delivererId) return { success: false, error: 'Not the deliverer' };
    this.delivererText = String(text).slice(0, 300);
    this.broadcast({ type: 'answer_typing', text: this.delivererText, delivererId: playerId });
    return { success: true };
  }

  submitAnswer(playerId, rawAnswer) {
    if (this.phase !== 'room_deliver') return { success: false, error: 'Not in deliver phase' };
    if (playerId !== this.delivererId) return { success: false, error: 'Not the deliverer' };

    const ps = this.players.get(playerId);
    if (!ps) return { success: false, error: 'Player not found' };

    const { correct } = bank.checkAnswer(this.puzzle, rawAnswer);
    const penalty = correct ? CORRECT_PENALTY : WRONG_PENALTY;

    ps.deliveriesAttempted++;
    if (correct) ps.deliveriesCorrect++; else ps.deliveriesWrong++;
    ps.points -= penalty;

    this.phase = 'room_resolve';

    const hitZero = ps.points <= 0 && !ps.eliminated;
    if (hitZero) ps.points = 0;

    this.broadcast({
      type: correct ? 'answer_correct' : 'answer_wrong',
      delivererId: playerId,
      submittedAnswer: rawAnswer,
      correct,
      penalty,
      ...this.getPublicState(),
    });

    if (correct) {
      this._schedulePhase(() => {
        if (hitZero) this._doEliminate(playerId, 'zero_points', () => this._advanceRoom());
        else this._advanceRoom();
      }, CORRECT_ANSWER_VERDICT_MS + ROOM_CLEARED_PAUSE_MS);
    } else {
      this._schedulePhase(() => {
        if (hitZero) this._doEliminate(playerId, 'zero_points', () => this._startRoom(this.currentRoom));
        else this._startRoom(this.currentRoom);
      }, WRONG_ANSWER_VERDICT_MS + WRONG_NEW_PUZZLE_FADE_MS);
    }

    return { success: true };
  }

  // ── Elimination ───────────────────────────────────────────────────

  // Called by Room.js when a 60-second disconnect grace timer expires.
  eliminatePlayer(playerId, cause) {
    if (this.gameEnded) return;
    const ps = this.players.get(playerId);
    if (!ps || ps.eliminated) return;
    ps.connected = false;
    this._doEliminate(playerId, cause, null);
  }

  // Notify the game that a player has reconnected (Room.js handles WS).
  markReconnected(playerId) {
    const ps = this.players.get(playerId);
    if (ps) {
      ps.connected = true;
      this.broadcast({ type: 'player_reconnected', playerId, ...this.getPublicState() });
    }
  }

  _doEliminate(playerId, cause, afterCallback) {
    if (this.gameEnded) return;
    const ps = this.players.get(playerId);
    if (!ps || ps.eliminated) {
      if (afterCallback) afterCallback();
      return;
    }

    ps.eliminated = true;
    ps.eliminatedRoom = this.currentRoom;
    ps.eliminationCause = cause;

    // Distribute residual points on disconnect (if > 0)
    let distribution = null;
    if (cause === 'disconnect' && ps.points > 0) {
      const survivors = this._activePlayers(playerId);
      const N = survivors.length;
      const amount = N > 0 ? Math.floor(ps.points / N) : 0;
      if (amount > 0) {
        for (const s of survivors) s.points += amount;
        distribution = { amount, survivorIds: survivors.map(s => s.id) };
      }
    }
    ps.points = 0;

    const remaining = this._activePlayers();

    // Table-failed: active drops below minimum
    if (remaining.length < MIN_ACTIVE_PLAYERS) {
      this.broadcast({ type: 'player_eliminated', playerId, cause, distribution, ...this.getPublicState() });
      this._endGame('table_failed');
      return;
    }

    this.broadcast({ type: 'player_eliminated', playerId, cause, distribution, ...this.getPublicState() });

    if (remaining.length === 0) {
      this._endGame('all_eliminated');
      return;
    }

    // Phase-specific resume logic after disconnect-elimination
    if (cause === 'disconnect') {
      if (this.phase === 'room_vote') {
        this._checkMajority(); // threshold may have dropped, resolving existing votes
      } else if (this.phase === 'room_deliver' && playerId === this.delivererId) {
        this._openVote(); // deliverer gone — fresh vote on the same puzzle
      }
    }

    if (afterCallback) afterCallback();
  }

  // ── Room advance ──────────────────────────────────────────────────

  _advanceRoom() {
    if (this.gameEnded) return;
    this.roomsCleared++;
    if (this.currentRoom >= this.totalRooms) {
      this._endGame('cleared');
    } else {
      this._startRoom(this.currentRoom + 1);
    }
  }

  // ── Game timer ────────────────────────────────────────────────────

  _tickGameTimer() {
    if (this.gameEnded) return;
    const elapsed = Date.now() - this.gameStartTime;
    const remaining = Math.max(0, GAME_DURATION_MS - elapsed);
    this.broadcast({ type: 'game_timer', remainingMs: remaining });
    if (remaining === 0) this._endGame('timeout');
  }

  // ── Game end ──────────────────────────────────────────────────────

  _endGame(reason) {
    if (this.gameEnded) return;
    this.gameEnded = true;
    this.phase = 'game_end';
    this._clearPhaseTimeout();
    if (this.gameTimerInterval) { clearInterval(this.gameTimerInterval); this.gameTimerInterval = null; }

    const summary = [...this.players.values()].map(ps => {
      let result;
      if (ps.eliminated) {
        result = ps.eliminationCause === 'table_failed'
          ? 'table_failed'
          : `eliminated_room_${ps.eliminatedRoom}`;
      } else if (reason === 'cleared') {
        result = 'won';
      } else if (reason === 'table_failed') {
        result = 'table_failed';
      } else {
        result = 'failed';
      }
      return {
        id: ps.id, name: ps.name, finalPoints: ps.points, result,
        deliveriesAttempted: ps.deliveriesAttempted,
        deliveriesCorrect: ps.deliveriesCorrect,
        deliveriesWrong: ps.deliveriesWrong,
      };
    });

    this.broadcast({ type: 'game_ended', reason, roomsCleared: this.roomsCleared, summary, ...this.getPublicState() });
    this.onGameEnd();
  }

  // ── Public state ──────────────────────────────────────────────────

  getPublicState() {
    const elapsed = this.gameStartTime ? Date.now() - this.gameStartTime : 0;
    const active = this._activePlayers();
    return {
      phase: this.phase,
      totalRooms: this.totalRooms,
      currentRoom: this.currentRoom,
      roomNumeral: this.currentRoom >= 1 ? ROMAN[this.currentRoom - 1] : '',
      roomsCleared: this.roomsCleared,
      players: [...this.players.values()].map(ps => ({
        id: ps.id, name: ps.name, points: ps.points,
        connected: ps.connected, eliminated: ps.eliminated,
        eliminatedRoom: ps.eliminatedRoom, eliminationCause: ps.eliminationCause,
      })),
      puzzle: this.puzzle ? bank.clientView(this.puzzle) : null,
      readyPlayerIds: [...this.readyPlayers],
      votes: Object.fromEntries(this.votes),
      tally: this._computeTally(),
      majorityThreshold: Math.ceil((active.length + 1) / 2),
      delivererId: this.delivererId,
      delivererText: this.delivererText,
      gameTimerMs: Math.max(0, GAME_DURATION_MS - elapsed),
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────

  _activePlayers(excludeId = null) {
    return [...this.players.values()].filter(p => !p.eliminated && p.id !== excludeId);
  }

  _schedulePhase(fn, delayMs) {
    this._clearPhaseTimeout();
    this.phaseTimeout = setTimeout(() => { this.phaseTimeout = null; fn(); }, delayMs);
  }

  _clearPhaseTimeout() {
    if (this.phaseTimeout) { clearTimeout(this.phaseTimeout); this.phaseTimeout = null; }
  }

  handleAction(playerId, action) {
    if (!action || typeof action !== 'object') return { success: false, error: 'Bad action' };
    switch (action.type) {
      case 'player_ready':  return this.playerReady(playerId);
      case 'cast_vote':     return this.castVote(playerId, action.targetId);
      case 'answer_typing': return this.delivererTyping(playerId, action.text || '');
      case 'submit_answer': return this.submitAnswer(playerId, action.answer ?? action.text ?? '');
      default: return { success: false, error: `Unknown action: ${action.type}` };
    }
  }

  destroy() {
    this._clearPhaseTimeout();
    if (this.gameTimerInterval) { clearInterval(this.gameTimerInterval); this.gameTimerInterval = null; }
  }
}

module.exports = Game;
