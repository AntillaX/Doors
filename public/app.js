'use strict';

const SESSION_KEY = 'doors_session';

// ── Local state ───────────────────────────────────────────────
let ws = null;
let myId = null;
let roomCode = null;
let myName = '';
let isHost = false;
let lastState = null;
let prevPoints = {};
let typingThrottle = null;
let currentRoomRendered = 0;
let flashRunning = false;
let submitHandler = null;
let inputHandler = null;
let keydownHandler = null;
let doorTriggeredByAnswer = false;  // set by onCorrectAnswer so onNewRoom skips re-triggering
let rulesCountdownTimer = null;

const $ = id => document.getElementById(id);

// ── Boot ──────────────────────────────────────────────────────
function init() {
  buildProgressMarks(10);
  attachLandingListeners();
  attachLobbyListeners();
  attachRulesListeners();
  attachGameOverListeners();

  gtag('event', 'doors_lobby_visit');

  const session = loadSession();
  if (session) {
    myId = session.playerId;
    roomCode = session.roomCode;
    connect(true);
  }
}

// ── WebSocket ─────────────────────────────────────────────────
function connect(isReconnect) {
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${loc.host}${loc.pathname}`);

  ws.onopen = () => {
    if (isReconnect && myId && roomCode) {
      send({ type: 'reconnect', playerId: myId, roomCode });
    }
  };

  ws.onmessage = (e) => {
    try { handleMessage(JSON.parse(e.data)); } catch {}
  };

  ws.onclose = () => {
    if (myId && roomCode) setTimeout(() => connect(true), 2000);
  };

  ws.onerror = () => {};
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function sendAction(action) {
  send({ type: 'game_action', action });
}

// ── Master message handler ────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {

    case 'room_created':
      myId = msg.playerId;
      roomCode = msg.roomCode;
      isHost = true;
      saveSession(roomCode, myId);
      renderLobby(msg);
      showScreen('lobby');
      gtag('event', 'doors_game_created', { room_code: roomCode });
      break;

    case 'room_joined':
      myId = msg.playerId;
      roomCode = msg.roomCode;
      isHost = false;
      saveSession(roomCode, myId);
      renderLobby(msg);
      showScreen('lobby');
      gtag('event', 'doors_game_joined', { room_code: roomCode });
      break;

    case 'reconnected': {
      const me = (msg.players || []).find(p => p.id === myId);
      if (me) myName = me.name;
      isHost = msg.hostId === myId;
      if (msg.roomState === 'lobby') {
        renderLobby(msg);
        showScreen('lobby');
      } else {
        buildProgressMarks(msg.totalRooms || 10);
        showScreen('game');
        applyFullState(msg);
      }
      break;
    }

    case 'error':
      if (msg.message === 'Room not found' || msg.message === 'Player not found in this room') {
        clearSession(); myId = null; roomCode = null;
        showScreen('landing');
      }
      setLandingError(msg.message);
      break;

    case 'player_joined':
    case 'player_left':
      renderLobby(msg);
      break;

    case 'game_starting':
      showScreen('game');
      applyFullState(msg);
      buildProgressMarks(msg.totalRooms || 10);
      showRulesModal(true, msg.countdown || 5);
      break;

    case 'room_started': {
      showScreen('game');
      hideRulesModal();
      // Clear any lingering resolve message immediately
      const rm = $('resolve-msg');
      rm.classList.remove('visible');
      rm.hidden = true;
      if (msg.currentRoom === 1) buildProgressMarks(msg.totalRooms || 10);
      applyFullState(msg);
      break;
    }

    case 'vote_opened':
    case 'vote_cast':
      applyFullState(msg);
      break;

    case 'deliverer_selected':
      applyFullState(msg);
      break;

    case 'answer_typing':
      if (msg.delivererId !== myId) {
        const live = $('live-answer');
        if (!live.hidden) live.textContent = msg.text || '';
        if (typeof msg.text === 'string' && msg.text.startsWith('[choice:')) {
          const idx = parseInt(msg.text.replace('[choice:', ''), 10);
          document.querySelectorAll('#choice-options .choice-btn').forEach((b, i) => {
            b.classList.toggle('hovered', i === idx);
          });
        }
      }
      if (lastState) lastState.delivererText = msg.text;
      break;

    case 'answer_correct':
      applyFullState(msg);
      onCorrectAnswer(msg);
      break;

    case 'answer_wrong':
      applyFullState(msg);
      onWrongAnswer(msg);
      break;

    case 'player_eliminated':
      applyFullState(msg);
      onPlayerEliminated(msg);
      break;

    case 'player_disconnected':
      showDisconnectNotice(msg.playerId, msg.playerName, msg.graceMs);
      if (msg.phase) applyFullState(msg);
      break;

    case 'disconnect_tick':
      updateDisconnectNotice(msg.playerId, msg.remainingMs);
      break;

    case 'player_reconnected':
      clearDisconnectNotice(msg.playerId);
      if (msg.phase) applyFullState(msg);
      break;

    case 'game_timer':
      renderTimer(msg.remainingMs);
      break;

    case 'game_ended':
      applyFullState(msg);
      setTimeout(() => renderGameOver(msg), 800);
      break;

    case 'left_room':
      clearSession(); myId = null; roomCode = null;
      showScreen('landing');
      break;
  }
}

// ── State application ─────────────────────────────────────────
function applyFullState(state) {
  if (!state || !state.phase) return;
  lastState = state;
  if (state.phase === 'game_end') return;

  renderPlayerBar(state);
  renderProgress(state);
  renderPuzzleArea(state);
  renderVoteArea(state);
  renderDeliverArea(state);
  renderTimer(state.gameTimerMs);
  setRoomAmbient(state.currentRoom);
}

// ── Screen navigation ─────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = $(`${name}-screen`);
  if (el) el.classList.add('active');
}

// ── Landing ───────────────────────────────────────────────────
function attachLandingListeners() {
  const nameInput = $('player-name-input');
  const codeInput = $('room-code-input');

  $('create-btn').addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) { setLandingError('Enter your name first'); return; }
    myName = name;
    ensureConnected(() => send({ type: 'create_room', playerName: name }));
  });

  $('join-btn').addEventListener('click', () => {
    const name = nameInput.value.trim();
    const code = codeInput.value.trim().toUpperCase();
    if (!name) { setLandingError('Enter your name first'); return; }
    if (code.length < 4) { setLandingError('Enter a 4-letter room code'); return; }
    myName = name;
    ensureConnected(() => send({ type: 'join_room', playerName: name, roomCode: code }));
  });

  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('create-btn').click(); });
  codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('join-btn').click(); });
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '');
  });
}

function ensureConnected(fn) {
  if (!ws || ws.readyState > 1) {
    connect(false);
    ws.addEventListener('open', fn, { once: true });
  } else if (ws.readyState === 0) {
    ws.addEventListener('open', fn, { once: true });
  } else {
    fn();
  }
}

function setLandingError(msg) {
  const el = $('landing-error');
  if (el) el.textContent = msg || '';
}

// ── Lobby ─────────────────────────────────────────────────────
function attachLobbyListeners() {
  $('start-btn').addEventListener('click', () => send({ type: 'start_game' }));

  $('lobby-leave-btn').addEventListener('click', () => {
    send({ type: 'leave_room' });
    clearSession(); myId = null; roomCode = null;
    showScreen('landing');
  });

  $('room-code-display').addEventListener('click', () => {
    navigator.clipboard.writeText(roomCode || '').then(() => showToast('Copied!'));
  });
}

function renderLobby(state) {
  isHost = state.hostId === myId;
  roomCode = state.roomCode;
  const players = state.players || [];
  const me = players.find(p => p.id === myId);
  if (me && !myName) myName = me.name;

  $('room-code-display').textContent = roomCode;

  const list = $('lobby-players');
  list.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const li = document.createElement('li');
    li.className = 'lobby-player-item';
    const p = players[i];
    const dot = document.createElement('span');
    dot.className = 'lobby-player-dot';
    li.appendChild(dot);
    if (p) {
      const nameSpan = document.createElement('span');
      nameSpan.textContent = p.name + (p.id === myId ? ' (you)' : '');
      li.appendChild(nameSpan);
      if (state.hostId === p.id) {
        const badge = document.createElement('span');
        badge.className = 'lobby-host-badge';
        badge.textContent = 'host';
        li.appendChild(badge);
      }
    } else {
      li.classList.add('empty');
      if (i === 4) li.classList.add('optional-seat');
      li.appendChild(document.createTextNode(i === 4 ? 'Optional seat' : `Seat ${i + 1}`));
    }
    list.appendChild(li);
  }

  const hint = $('lobby-hint');
  const needed = Math.max(0, 4 - players.length);
  if (needed > 0) {
    hint.textContent = `Waiting for ${needed} more player${needed !== 1 ? 's' : ''}…`;
  } else if (players.length < 5) {
    hint.textContent = '4 players ready — or wait for a 5th.';
  } else {
    hint.textContent = 'All 5 players ready.';
  }

  const startBtn = $('start-btn');
  startBtn.disabled = !(isHost && players.length >= 4);
  startBtn.textContent = isHost ? 'Start Game' : 'Waiting for host…';
}

// ── Rules modal ───────────────────────────────────────────────
function attachRulesListeners() {
  $('lobby-rules-btn').addEventListener('click', () => showRulesModal(false));
  $('game-rules-btn').addEventListener('click', () => showRulesModal(false));
  $('rules-close-btn').addEventListener('click', hideRulesModal);
  $('rules-overlay').addEventListener('click', e => {
    if (e.target === $('rules-overlay')) hideRulesModal();
  });
}

function showRulesModal(withCountdown, seconds) {
  const overlay = $('rules-overlay');
  const cd = $('rules-countdown');
  const closeBtn = $('rules-close-btn');
  overlay.hidden = false;

  if (withCountdown && seconds > 0) {
    cd.hidden = false;
    closeBtn.hidden = true;
    let remaining = seconds;
    cd.textContent = `Starting in ${remaining}…`;
    rulesCountdownTimer = setInterval(() => {
      remaining--;
      if (remaining > 0) {
        cd.textContent = `Starting in ${remaining}…`;
      } else {
        hideRulesModal();
      }
    }, 1000);
  } else {
    cd.hidden = true;
    closeBtn.hidden = false;
  }
}

function hideRulesModal() {
  if (rulesCountdownTimer) { clearInterval(rulesCountdownTimer); rulesCountdownTimer = null; }
  $('rules-overlay').hidden = true;
  $('rules-countdown').hidden = true;
  $('rules-close-btn').hidden = false;
}

// ── Player bar ────────────────────────────────────────────────
function renderPlayerBar(state) {
  const bar = $('player-bar');
  const players = state.players || [];

  const existing = bar.querySelectorAll('.player-slot');
  if (existing.length !== players.length) {
    bar.innerHTML = '';
    for (const p of players) bar.appendChild(makePlayerSlot(p, state));
  } else {
    players.forEach((p, i) => updatePlayerSlot(existing[i], p, state));
  }
}

function makePlayerSlot(p, state) {
  const slot = document.createElement('div');
  slot.className = 'player-slot';
  slot.setAttribute('role', 'listitem');
  slot.dataset.playerId = p.id;
  if (p.id === myId) slot.classList.add('me');

  const nameEl = document.createElement('div');
  nameEl.className = 'player-slot-name';
  slot.appendChild(nameEl);

  const ptsEl = document.createElement('div');
  ptsEl.className = 'player-slot-points';
  slot.appendChild(ptsEl);

  updatePlayerSlot(slot, p, state);
  return slot;
}

function updatePlayerSlot(slot, p, state) {
  const nameEl = slot.querySelector('.player-slot-name');
  const ptsEl = slot.querySelector('.player-slot-points');

  nameEl.textContent = p.name;

  const prev = prevPoints[p.id];
  const changed = prev !== undefined && prev !== p.points;
  const lost = changed && p.points < prev;
  prevPoints[p.id] = p.points;

  slot.classList.toggle('eliminated', !!p.eliminated);
  slot.classList.toggle('deliverer', p.id === state.delivererId);

  if (!p.eliminated) ptsEl.textContent = p.points;
  else ptsEl.textContent = '';

  if (lost) {
    slot.classList.remove('points-lost');
    void slot.offsetWidth;
    slot.classList.add('points-lost');
    setTimeout(() => slot.classList.remove('points-lost'), 700);
  }
}

// ── Puzzle area ───────────────────────────────────────────────
function renderPuzzleArea(state) {
  const { puzzle, phase, currentRoom, roomNumeral } = state;

  if (currentRoom && currentRoom !== currentRoomRendered) {
    currentRoomRendered = currentRoom;
    onNewRoom(roomNumeral, puzzle);
  }

  if ((phase === 'room_vote' || phase === 'room_deliver' || phase === 'room_resolve') && puzzle) {
    $('question-text').textContent = puzzle.question || '';
    if (puzzle.stimulusType !== 'flash_sequence') {
      $('stimulus-text').textContent = puzzle.stimulusText || '';
    }
  }
}

function onNewRoom(numeral, puzzle) {
  $('stimulus-text').textContent = '';
  $('question-text').textContent = '';
  $('flash-display').hidden = true;
  $('flash-display').style.opacity = '0';
  $('flash-display').textContent = '';
  $('resolve-msg').hidden = true;
  $('resolve-msg').classList.remove('visible', 'correct', 'wrong');
  clearDisconnectNotices();
  flashRunning = false;

  showRoomNumeral(numeral);

  // Trigger door open unless onCorrectAnswer already did it
  if (doorTriggeredByAnswer) {
    doorTriggeredByAnswer = false;
  } else {
    triggerDoorOpen();
  }

  if (!puzzle) return;

  if (puzzle.stimulusType === 'flash_sequence' && puzzle.flashItems && puzzle.flashItems.length) {
    runFlashSequence(puzzle.flashItems, puzzle.flashItemDurationMs || 800);
  } else {
    $('stimulus-text').textContent = puzzle.stimulusText || '';
    $('question-text').textContent = puzzle.question || '';
  }
}

function showRoomNumeral(numeral) {
  const el = $('room-numeral');
  el.textContent = numeral || '';
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 1200);
}

async function runFlashSequence(items, durationMs) {
  if (flashRunning) return;
  flashRunning = true;
  const display = $('flash-display');
  display.hidden = false;
  display.style.transition = 'none';
  display.style.opacity = '0';

  for (const item of items) {
    display.textContent = String(item);
    await sleep(40);
    display.style.transition = 'opacity 150ms ease';
    display.style.opacity = '1';
    await sleep(Math.max(durationMs - 350, 100));
    display.style.transition = 'opacity 200ms ease';
    display.style.opacity = '0';
    await sleep(260);
  }
  display.hidden = true;
  flashRunning = false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Vote area ─────────────────────────────────────────────────
function renderVoteArea(state) {
  const { phase, players, votes, tally, majorityThreshold } = state;
  const voteArea = $('vote-area');

  if (phase !== 'room_vote') {
    voteArea.hidden = true;
    return;
  }
  voteArea.hidden = false;

  const me = (players || []).find(p => p.id === myId);
  const canVote = me && !me.eliminated && me.connected;
  const myVote = votes ? votes[myId] : null;

  const container = $('vote-buttons');
  container.innerHTML = '';

  for (const p of (players || [])) {
    if (p.id === myId || p.eliminated || !p.connected) continue;

    const voteCount = (tally && tally[p.id]) || 0;

    const btn = document.createElement('button');
    btn.className = 'vote-btn';
    btn.setAttribute('data-votes', voteCount);
    btn.setAttribute('aria-pressed', votes && votes[myId] === p.id ? 'true' : 'false');
    btn.disabled = !canVote;
    if (myVote === p.id) btn.classList.add('my-vote');
    btn.dataset.targetId = p.id;

    const nameEl = document.createElement('span');
    nameEl.className = 'vote-btn-name';
    nameEl.textContent = p.name;
    btn.appendChild(nameEl);

    const countEl = document.createElement('span');
    countEl.className = 'vote-btn-count';
    countEl.textContent = voteCount > 0 ? `${voteCount}` : '';
    btn.appendChild(countEl);

    btn.addEventListener('click', () => sendAction({ type: 'cast_vote', targetId: p.id }));
    container.appendChild(btn);
  }

  const thresholdHint = $('vote-threshold-hint');
  if (thresholdHint && majorityThreshold) {
    thresholdHint.textContent = `${majorityThreshold} vote${majorityThreshold !== 1 ? 's' : ''} needed`;
  }
}

// ── Deliver area ──────────────────────────────────────────────
function renderDeliverArea(state) {
  const { phase, delivererId, delivererText, puzzle } = state;
  const deliverArea = $('deliver-area');

  if (phase !== 'room_deliver' && phase !== 'room_resolve') {
    deliverArea.hidden = true;
    return;
  }
  deliverArea.hidden = false;
  $('vote-area').hidden = true;

  const amDeliverer = delivererId === myId;
  const delivererPlayer = (state.players || []).find(p => p.id === delivererId);
  const label = $('deliverer-label');
  label.textContent = amDeliverer
    ? 'You are delivering'
    : (delivererPlayer ? `${delivererPlayer.name} is delivering` : 'Delivering…');

  if (!puzzle) return;

  if (puzzle.answerType === 'choice') {
    $('text-input-wrap').hidden = true;
    $('live-answer').hidden = true;
    renderChoiceOptions(puzzle, amDeliverer, delivererText, phase);
  } else {
    $('choice-options').hidden = true;
    $('choice-options').innerHTML = '';
    if (amDeliverer && phase === 'room_deliver') {
      $('live-answer').hidden = true;
      setupTextInput();
    } else {
      $('text-input-wrap').hidden = true;
      const live = $('live-answer');
      live.hidden = false;
      live.textContent = delivererText || '';
    }
  }
}

function setupTextInput() {
  const input = $('answer-input');
  const btn = $('submit-btn');
  const wrap = $('text-input-wrap');
  wrap.hidden = false;

  if (inputHandler) input.removeEventListener('input', inputHandler);
  if (keydownHandler) input.removeEventListener('keydown', keydownHandler);
  if (submitHandler) btn.removeEventListener('click', submitHandler);

  input.value = '';
  btn.disabled = false;

  inputHandler = () => sendTyping(input.value);
  keydownHandler = (e) => { if (e.key === 'Enter' && !btn.disabled) btn.click(); };
  submitHandler = () => {
    const answer = input.value;
    if (btn.disabled) return;
    sendAction({ type: 'submit_answer', answer });
    btn.disabled = true;
  };

  input.addEventListener('input', inputHandler);
  input.addEventListener('keydown', keydownHandler);
  btn.addEventListener('click', submitHandler);

  requestAnimationFrame(() => input.focus());
}

function renderChoiceOptions(puzzle, amDeliverer, delivererText, phase) {
  const wrap = $('choice-options');
  wrap.hidden = false;

  if (wrap.dataset.puzzleId !== puzzle.id) {
    wrap.dataset.puzzleId = puzzle.id;
    wrap.innerHTML = '';
    (puzzle.options || []).forEach((opt, idx) => {
      const btn = document.createElement('button');
      btn.className = 'choice-btn';
      btn.textContent = opt;
      btn.dataset.idx = idx;
      wrap.appendChild(btn);
    });
  }

  const allBtns = wrap.querySelectorAll('.choice-btn');

  if (amDeliverer && phase === 'room_deliver') {
    allBtns.forEach((btn, idx) => {
      btn.disabled = false;
      btn.onclick = null;
      btn.onmouseenter = () => sendAction({ type: 'answer_typing', text: `[choice:${idx}]` });
      btn.onclick = () => sendAction({ type: 'submit_answer', answer: String(idx) });
    });
  } else {
    allBtns.forEach(btn => {
      btn.disabled = true;
      btn.onmouseenter = null;
      btn.onclick = null;
    });
    if (typeof delivererText === 'string' && delivererText.startsWith('[choice:')) {
      const hovIdx = parseInt(delivererText.replace('[choice:', ''), 10);
      allBtns.forEach((b, i) => b.classList.toggle('hovered', i === hovIdx));
    }
  }
}

function sendTyping(text) {
  if (typingThrottle) return;
  sendAction({ type: 'answer_typing', text });
  typingThrottle = setTimeout(() => { typingThrottle = null; }, 200);
}

// ── Answer result effects ─────────────────────────────────────
function onCorrectAnswer(msg) {
  const wrap = $('puzzle-wrap');
  wrap.classList.add('gold-glow');
  showResolveMsg('Correct.', 'correct');

  if (msg.currentRoom) gtag('event', 'doors_room_cleared', { room: msg.currentRoom });

  setTimeout(() => {
    wrap.classList.remove('gold-glow');
    doorTriggeredByAnswer = true;
    triggerDoorOpen();
  }, 400);
}

function onWrongAnswer() {
  showResolveMsg('Wrong — a new puzzle is coming.', 'wrong');
  // Reset so the incoming room_started (same room number) triggers onNewRoom
  currentRoomRendered = 0;
}

function onPlayerEliminated(msg) {
  if (msg.playerId === myId) {
    gtag('event', 'doors_player_eliminated', { room: msg.currentRoom, cause: msg.cause });
  }
  if (msg.distribution) {
    const distribPlayer = (msg.players || []).find(p => p.id === msg.playerId);
    const name = distribPlayer ? distribPlayer.name : 'Player';
    showDistributionNotice(name, msg.distribution.amount);
    gtag('event', 'doors_points_distributed', { amount: msg.distribution.amount });
  }
}

function showResolveMsg(text, cls) {
  const el = $('resolve-msg');
  el.textContent = text;
  el.className = `resolve-msg ${cls}`;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => { el.hidden = true; }, 300);
  }, 2500);
}

function triggerDoorOpen() {
  const wrap = $('puzzle-wrap');
  wrap.classList.remove('door-opening', 'door-closing');
  void wrap.offsetWidth;
  wrap.classList.add('door-opening');
  setTimeout(() => wrap.classList.remove('door-opening'), 800);
}

// ── Progress indicator ────────────────────────────────────────
function buildProgressMarks(count) {
  const container = $('progress-indicator');
  container.innerHTML = '';
  for (let i = 1; i <= (count || 10); i++) {
    const m = document.createElement('div');
    m.className = 'progress-mark';
    m.dataset.room = i;
    container.appendChild(m);
  }
}

function renderProgress(state) {
  const { currentRoom } = state;
  document.querySelectorAll('.progress-mark').forEach(m => {
    const r = parseInt(m.dataset.room, 10);
    m.className = 'progress-mark';
    if (r < currentRoom) m.classList.add('cleared');
    else if (r === currentRoom) m.classList.add('current');
  });
}

// ── Game timer ────────────────────────────────────────────────
function renderTimer(ms) {
  if (ms === undefined || ms === null) return;
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  $('game-timer').textContent = `${m}:${String(s).padStart(2, '0')}`;
  $('game-timer').classList.toggle('warning', totalSec < 300);
}

// ── Ambient gradient ──────────────────────────────────────────
const ROOM_AMBIENTS = [
  'rgba(55,65,90,0.045)',   // 1 cool-blue
  'rgba(50,62,88,0.042)',   // 2
  'rgba(48,58,82,0.040)',   // 3
  'rgba(50,55,76,0.040)',   // 4
  'rgba(52,54,70,0.040)',   // 5 neutral
  'rgba(58,54,66,0.040)',   // 6
  'rgba(68,56,58,0.042)',   // 7 warming
  'rgba(78,60,50,0.044)',   // 8
  'rgba(90,66,46,0.046)',   // 9
  'rgba(102,74,42,0.050)',  // 10
  'rgba(114,80,38,0.054)',  // 11 warm amber
];

function setRoomAmbient(roomNum) {
  const color = ROOM_AMBIENTS[Math.max(0, (roomNum || 1) - 1)] || 'transparent';
  document.body.style.setProperty('--room-ambient', color);
}

// ── Disconnect notices ────────────────────────────────────────
const activeDisconnects = new Map();

function showDisconnectNotice(playerId, playerName, graceMs) {
  clearDisconnectNotice(playerId);
  const el = document.createElement('div');
  el.className = 'disconnect-notice';
  el.dataset.name = playerName || 'Player';
  el.textContent = `${playerName} disconnected — ${Math.ceil((graceMs || 0) / 1000)}s to rejoin`;
  $('disconnect-notices').appendChild(el);
  activeDisconnects.set(playerId, el);
}

function updateDisconnectNotice(playerId, remainingMs) {
  const el = activeDisconnects.get(playerId);
  if (!el) return;
  const name = el.dataset.name || 'Player';
  el.textContent = `${name} disconnected — ${Math.ceil(remainingMs / 1000)}s to rejoin`;
}

function clearDisconnectNotice(playerId) {
  const el = activeDisconnects.get(playerId);
  if (el) { el.remove(); activeDisconnects.delete(playerId); }
}

function clearDisconnectNotices() {
  activeDisconnects.forEach(el => el.remove());
  activeDisconnects.clear();
}

function showDistributionNotice(name, amount) {
  const el = document.createElement('div');
  el.className = 'disconnect-notice distribution';
  el.textContent = `${name} eliminated — +${amount} pts to each remaining player`;
  $('disconnect-notices').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ── Game over ─────────────────────────────────────────────────
function attachGameOverListeners() {
  $('play-again-btn').addEventListener('click', () => {
    gtag('event', 'doors_play_again_clicked');
    send({ type: 'play_again' });
    resetGameLocals();
  });
}

function renderGameOver(state) {
  const { reason, roomsCleared, summary } = state;
  const totalRooms = (lastState && lastState.totalRooms) || 10;

  const titleEl = $('over-title');
  if (reason === 'cleared') {
    titleEl.textContent = 'CLEARED';
    titleEl.className = 'over-title cleared';
    gtag('event', 'doors_game_won');
  } else {
    titleEl.textContent = 'FAILED';
    titleEl.className = 'over-title';
    const me = (summary || []).find(p => p.id === myId);
    if (me && me.result !== 'won') gtag('event', 'doors_game_lost');
    if (reason === 'table_failed') gtag('event', 'doors_table_failed');
  }

  const subtitleEl = $('over-subtitle');
  if (reason === 'table_failed') subtitleEl.textContent = 'Table failed — not enough players.';
  else if (reason === 'timeout') subtitleEl.textContent = `Time expired. ${roomsCleared || 0} / ${totalRooms} rooms cleared.`;
  else if (reason === 'cleared') subtitleEl.textContent = `All ${totalRooms} rooms cleared.`;
  else subtitleEl.textContent = `${roomsCleared || 0} / ${totalRooms} rooms cleared.`;

  const summaryEl = $('over-summary');
  summaryEl.innerHTML = '';
  for (const p of (summary || [])) {
    const row = document.createElement('div');
    row.className = 'over-player-row';
    row.setAttribute('role', 'listitem');
    if (p.result === 'won') row.classList.add('won');
    else if (p.result && p.result.startsWith('eliminated')) row.classList.add('eliminated');

    const nameEl = document.createElement('span');
    nameEl.className = 'over-player-name';
    nameEl.textContent = p.name + (p.id === myId ? ' (you)' : '');
    row.appendChild(nameEl);

    const ptsEl = document.createElement('span');
    ptsEl.className = 'over-player-pts';
    ptsEl.textContent = p.finalPoints;
    row.appendChild(ptsEl);

    const resultEl = document.createElement('span');
    resultEl.className = 'over-player-result';
    if (p.result === 'won') resultEl.textContent = 'WON';
    else if (p.result === 'table_failed') resultEl.textContent = 'FAILED';
    else if (p.result && p.result.startsWith('eliminated_room')) {
      const r = p.result.replace('eliminated_room_', '');
      resultEl.textContent = `ELIM R${r}`;
    } else resultEl.textContent = 'FAILED';
    row.appendChild(resultEl);

    summaryEl.appendChild(row);
  }

  const playAgainBtn = $('play-again-btn');
  playAgainBtn.hidden = !isHost;

  showScreen('gameover');
}

function resetGameLocals() {
  prevPoints = {};
  currentRoomRendered = 0;
  flashRunning = false;
  doorTriggeredByAnswer = false;
  if (rulesCountdownTimer) { clearInterval(rulesCountdownTimer); rulesCountdownTimer = null; }
  clearDisconnectNotices();
  $('answer-input').value = '';
  $('submit-btn').disabled = false;
  $('choice-options').innerHTML = '';
  $('choice-options').dataset.puzzleId = '';
  $('resolve-msg').hidden = true;
  $('deliver-area').hidden = true;
  $('vote-area').hidden = true;
  $('stimulus-text').textContent = '';
  $('question-text').textContent = '';
  document.body.style.removeProperty('--room-ambient');
  if (inputHandler) { $('answer-input').removeEventListener('input', inputHandler); inputHandler = null; }
  if (keydownHandler) { $('answer-input').removeEventListener('keydown', keydownHandler); keydownHandler = null; }
  if (submitHandler) { $('submit-btn').removeEventListener('click', submitHandler); submitHandler = null; }
  showScreen('lobby');
}

// ── Session management ────────────────────────────────────────
function saveSession(rc, pid) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode: rc, playerId: pid }));
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function clearSession() { localStorage.removeItem(SESSION_KEY); }

// ── Toast ─────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

// ── gtag guard ────────────────────────────────────────────────
function gtag() {
  if (typeof window.gtag === 'function') window.gtag(...arguments);
}

// ── Start ─────────────────────────────────────────────────────
init();
