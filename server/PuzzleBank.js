'use strict';

const fs = require('fs');
const path = require('path');

const PUZZLES_PATH = path.join(__dirname, 'data/puzzles_v2.json');
const MAX_ROLL_ATTEMPTS = 20;

// ─────────────────────────────────────────────────────────────────
// Expression evaluator
// Supports: arithmetic, math.* helpers, ternary, array indexing.
// The puzzle JSON may use ^ for exponentiation (mapped to **).

// `round` supports both round(n) and round(n, decimals).
function roundTo(n, decimals) {
  if (decimals === undefined) return Math.round(n);
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

const _math = {
  ceil: Math.ceil, floor: Math.floor, round: roundTo,
  abs: Math.abs, min: Math.min, max: Math.max,
  sqrt: Math.sqrt, pow: Math.pow,
};

// Bare helpers exposed directly so puzzle expressions can write round(x) etc.
const _bareHelpers = {
  ceil: Math.ceil, floor: Math.floor, round: roundTo,
  abs: Math.abs, min: Math.min, max: Math.max,
};

function evalExpr(expr, scope) {
  const safe = String(expr).replace(/\^/g, '**');
  const merged = { ..._bareHelpers, ...scope, math: _math };
  const keys = Object.keys(merged);
  const vals = Object.values(merged);
  return new Function(...keys, '"use strict"; return (' + safe + ')').apply(null, vals);
}

// ─────────────────────────────────────────────────────────────────
// Helpers

function toOrdinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function shuffled(arr) { return shuffleInPlace([...arr]); }

function drawN(pool, n) {
  return shuffled(pool).slice(0, n);
}

function randInt(lo, hi) {
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function randomInts(count, lo, hi) {
  return Array.from({ length: count }, () => randInt(lo, hi));
}

// ─────────────────────────────────────────────────────────────────
// Flash sequence + grid generators (keyed by `source` field in JSON)

function generateSequence(source, pools) {
  switch (source) {
    case 'draw_5_from_word_pool':
      return drawN(pools.word_pool, 5);
    case 'draw_5_from_color_pool':
      return drawN(pools.color_pool, 5);
    case '5_random_ints_10_99':
      return randomInts(5, 10, 99);
    case '5_random_ints_3_19':
      return randomInts(5, 3, 19);
    case 'draw_6_from_word_pool_with_2or3_sharing_initial':
      return drawWordsWithSharedInitial(pools.word_pool);
    default:
      throw new Error(`Unknown flash_sequence source: ${source}`);
  }
}

function drawWordsWithSharedInitial(pool) {
  const byLetter = {};
  for (const w of pool) {
    const l = w[0];
    (byLetter[l] = byLetter[l] || []).push(w);
  }
  const candidateLetters = Object.entries(byLetter).filter(([, ws]) => ws.length >= 2);
  if (candidateLetters.length === 0) return drawN(pool, 6);

  const [letter, words] = candidateLetters[Math.floor(Math.random() * candidateLetters.length)];
  const shareCount = Math.min(words.length, 2 + Math.floor(Math.random() * 2)); // 2 or 3
  const shared = drawN(words, shareCount);
  const others = pool.filter(w => w[0] !== letter);
  const filler = drawN(others, 6 - shared.length);
  return shuffled([...shared, ...filler]);
}

function generateGrid(source) {
  if (source === 'random_4x4_letters_pool_AEIOULNRST') {
    const pool = 'AEIOULNRST'.split('');
    const grid = [];
    for (let r = 0; r < 4; r++) {
      const row = [];
      for (let c = 0; c < 4; c++) row.push(pool[Math.floor(Math.random() * pool.length)]);
      grid.push(row);
    }
    return grid;
  }
  throw new Error(`Unknown grid source: ${source}`);
}

// ─────────────────────────────────────────────────────────────────
// Target-letter picker: choose a letter that appears N times in the data.

function pickTargetLetterFromSequence(sequence, minCount, maxCount) {
  const counts = {};
  for (const w of sequence) {
    const l = String(w)[0];
    counts[l] = (counts[l] || 0) + 1;
  }
  const candidates = Object.entries(counts).filter(([, c]) => c >= minCount && c <= maxCount);
  if (candidates.length > 0) {
    return candidates[Math.floor(Math.random() * candidates.length)][0];
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function pickTargetLetterFromGrid(grid, minCount, maxCount) {
  const counts = {};
  for (const row of grid) for (const c of row) counts[c] = (counts[c] || 0) + 1;
  const candidates = Object.entries(counts).filter(([, c]) => c >= minCount && c <= maxCount);
  if (candidates.length > 0) {
    return candidates[Math.floor(Math.random() * candidates.length)][0];
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// ─────────────────────────────────────────────────────────────────
// Strategic options generation (recall puzzles)
// Dispatched by puzzle ID. The FIRST returned option is always correct.

function strategicOptions(template, params, sequence, grid, pools) {
  switch (template.id) {

    case 'word_recall_position':
    case 'color_recall_position': {
      const ask = params.ask_position;
      const correct = sequence[ask - 1];
      const otherIdxs = sequence.map((_, i) => i).filter(i => i !== ask - 1);
      const other = sequence[otherIdxs[Math.floor(Math.random() * otherIdxs.length)]];
      const pool = template.id === 'word_recall_position' ? pools.word_pool : pools.color_pool;
      const unshown = pool.filter(x => !sequence.includes(x));
      const [u1, u2] = drawN(unshown, 2);
      return [correct, other, u1, u2];
    }

    case 'number_recall_position': {
      const ask = params.ask_position;
      const correct = sequence[ask - 1];
      const otherIdxs = sequence.map((_, i) => i).filter(i => i !== ask - 1);
      const other = sequence[otherIdxs[Math.floor(Math.random() * otherIdxs.length)]];
      const used = new Set(sequence);
      let u1, u2;
      do { u1 = randInt(10, 99); } while (used.has(u1));
      used.add(u1);
      do { u2 = randInt(10, 99); } while (used.has(u2));
      return [correct, other, u1, u2].map(String);
    }

    case 'word_recall_count_starting_letter': {
      const target = params.target_letter;
      const correctCount = sequence.filter(w => String(w)[0] === target).length;
      const drift = Math.random() < 0.5 ? 2 : -2;
      const distractor4 = Math.max(0, correctCount + drift);
      const opts = [correctCount, correctCount + 1, Math.max(0, correctCount - 1), distractor4];
      return dedupNumeric(opts).map(String);
    }

    case 'grid_letter_count': {
      const target = params.target_letter;
      const flat = grid.flat();
      const correctCount = flat.filter(c => c === target).length;
      const opts = [correctCount, correctCount + 1, Math.max(0, correctCount - 1), correctCount + 2];
      return dedupNumeric(opts).map(String);
    }

    case 'word_recall_immediate_after': {
      // anchor_position is 1-indexed (1..4). The anchor word is sequence[anchor_position-1].
      // The correct answer is sequence[anchor_position] (the word AFTER the anchor).
      const anchor = params.anchor_position;
      const correct = sequence[anchor];
      const anchorWord = sequence[anchor - 1];
      const afterAfter = anchor + 1 < sequence.length ? sequence[anchor + 1] : null;
      const used = [correct, anchorWord, afterAfter].filter(Boolean);
      const unshown = pools.word_pool.filter(x => !sequence.includes(x) && !used.includes(x));
      const u1 = afterAfter || drawN(unshown, 1)[0];
      const remaining = unshown.filter(x => x !== u1);
      const u2 = drawN(remaining, 1)[0];
      return [correct, anchorWord, u1, u2];
    }

    default:
      throw new Error(`No options_strategy handler for puzzle: ${template.id}`);
  }
}

// Ensure all numeric options are distinct; if a collision occurs, nudge.
function dedupNumeric(opts) {
  const seen = new Set();
  const out = [];
  for (let v of opts) {
    let n = v;
    while (seen.has(n)) n += 1;
    seen.add(n);
    out.push(n);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Flash duration profiles

function flashTiming(profile, flashItems, grid, stimulusText) {
  switch (profile) {
    case 'single_digit_per_item':
    case 'single_letter_per_item':
      return { perItem: 1000, total: (flashItems?.length || 0) * 1000 };
    case 'short_word_per_item':
      return { perItem: 1200, total: (flashItems?.length || 0) * 1200 };
    case 'long_word_per_item':
      return { perItem: 1500, total: (flashItems?.length || 0) * 1500 };
    case 'multi_digit_per_item':
      return { perItem: 1500, total: (flashItems?.length || 0) * 1500 };
    case 'grid_3x3':
      return { perItem: 0, total: 4000 };
    case 'grid_4x4':
      return { perItem: 0, total: 6000 };
    case 'grid_5x5':
      return { perItem: 0, total: 8000 };
    case 'flash_text_short':
      return { perItem: 0, total: 2500 };
    case 'flash_text_medium':
      return { perItem: 0, total: 4000 };
    case 'flash_text_long':
      return { perItem: 0, total: 6000 };
    default:
      // Auto-pick for flash_text by length
      if (stimulusText && typeof stimulusText === 'string') {
        const len = stimulusText.length;
        if (len <= 20) return { perItem: 0, total: 2500 };
        if (len <= 50) return { perItem: 0, total: 4000 };
        return { perItem: 0, total: 6000 };
      }
      return { perItem: 0, total: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────
// Parameter rolling

function rollParam(spec) {
  if (spec.type === 'fixed') return spec.value;
  if (spec.type === 'choice') return spec.values[Math.floor(Math.random() * spec.values.length)];
  if (spec.type === 'int') {
    const step = spec.step || 1;
    const slots = Math.floor((spec.max - spec.min) / step) + 1;
    return spec.min + Math.floor(Math.random() * slots) * step;
  }
  throw new Error(`Unknown param type: ${spec.type}`);
}

function rollParamsWithConstraints(paramSpec, constraints, puzzleId) {
  if (!paramSpec) return {};
  for (let attempt = 0; attempt < MAX_ROLL_ATTEMPTS; attempt++) {
    const params = {};
    for (const [key, spec] of Object.entries(paramSpec)) {
      params[key] = rollParam(spec);
    }
    let ok = true;
    if (constraints && constraints.length) {
      for (const c of constraints) {
        try {
          if (!evalExpr(c, params)) { ok = false; break; }
        } catch { ok = false; break; }
      }
    }
    if (ok) return params;
  }
  throw new Error(`Could not satisfy constraints for puzzle "${puzzleId}"`);
}

// ─────────────────────────────────────────────────────────────────
// Text substitution: {param}, {param_ordinal}, {expression}, {sequence[i]}

function substitute(text, params, sequence) {
  if (!text) return '';
  const scope = { ...params };
  if (sequence !== undefined) scope.sequence = sequence;
  return String(text).replace(/\{([^}]+)\}/g, (m, raw) => {
    const expr = raw.trim();
    // {name_ordinal} — convert int to '1st', '2nd', etc.
    const ord = expr.match(/^(\w+)_ordinal$/);
    if (ord && params[ord[1]] !== undefined) return toOrdinal(params[ord[1]]);
    try {
      const v = evalExpr(expr, scope);
      return String(v);
    } catch {
      return m;
    }
  });
}

// ─────────────────────────────────────────────────────────────────
// Bank

class PuzzleBank {
  constructor() {
    const raw = JSON.parse(fs.readFileSync(PUZZLES_PATH, 'utf8'));
    this.pools = raw._pools || {};
    // Filter out any non-puzzle entries; require id + level + category.
    this.puzzles = (raw.puzzles || []).filter(p => p && p.id && p.level && p.category);
  }

  getAll() { return this.puzzles; }
  getById(id) { return this.puzzles.find(p => p.id === id) || null; }
  getRoomOneDefault() {
    return this.puzzles.find(p => p.is_room_one_default) || null;
  }

  // Resolve a puzzle template into a concrete playable puzzle.
  // Returned puzzle has _answer / _correctOption fields for server-side use;
  // call clientView() to strip those before broadcasting.
  resolve(template) {
    // ── 1. Pick a variant if applicable ──────────────────────────
    let active = template;
    if (Array.isArray(template.variants) && template.variants.length > 0) {
      const variant = template.variants[Math.floor(Math.random() * template.variants.length)];
      // Variant may carry stimulus as a string or as an object — normalize.
      let stimulus = variant.stimulus;
      if (typeof stimulus === 'string') stimulus = { type: 'static_text', text: stimulus };
      active = {
        ...template,
        stimulus: stimulus || template.stimulus,
        question: variant.question || template.question,
        options: variant.options || template.options,
        answer: variant.answer !== undefined ? variant.answer : template.answer,
        accepted_answers: variant.accepted_answers || template.accepted_answers,
      };
    }

    // ── 2. Roll parameters ───────────────────────────────────────
    const params = active.parameterized
      ? rollParamsWithConstraints(active.params, active.constraints, active.id)
      : {};

    // ── 3. Generate stimulus content (sequence/grid) ─────────────
    let flashItems = null;
    let grid = null;
    let stimulusText = '';
    let stimulusType = 'static_text';

    if (active.stimulus) {
      stimulusType = active.stimulus.type;
      if (stimulusType === 'flash_sequence') {
        flashItems = generateSequence(active.stimulus.source, this.pools);
        // Special: derive target_letter for puzzles that need one.
        if (active.id === 'word_recall_count_starting_letter') {
          params.target_letter = pickTargetLetterFromSequence(flashItems, 2, 3);
        }
      } else if (stimulusType === 'grid') {
        grid = generateGrid(active.stimulus.source);
        if (active.id === 'grid_letter_count') {
          params.target_letter = pickTargetLetterFromGrid(grid, 2, 5);
        }
      } else {
        // static_text or flash_text
        stimulusText = substitute(active.stimulus.text || '', params, flashItems);
      }
    }

    // ── 4. Substitute params + sequence into question ────────────
    const question = substitute(active.question || '', params, flashItems);

    // ── 5. Build options (MCQ) ───────────────────────────────────
    let options = null;
    let correctOption = null;
    if (active.format === 'mcq') {
      let raw;
      if (active.options) {
        raw = active.options.map(o => substitute(o, params, flashItems));
      } else if (active.options_expression) {
        raw = active.options_expression.map(expr => {
          try { return String(evalExpr(expr, { ...params, sequence: flashItems })); }
          catch (e) { throw new Error(`options_expression "${expr}" failed in ${active.id}: ${e.message}`); }
        });
      } else if (active.options_strategy) {
        raw = strategicOptions(active, params, flashItems, grid, this.pools)
          .map(v => String(v));
      } else {
        throw new Error(`MCQ puzzle "${active.id}" has no options/options_expression/options_strategy`);
      }
      correctOption = raw[0];
      // Shuffle server-side. Client sends the chosen index; we look up the text.
      options = shuffled(raw);
    }

    // ── 6. Compute free-form answer ──────────────────────────────
    let answer = null;
    if (active.format === 'free_form') {
      if (active.answer_expression) {
        const scope = { ...params, sequence: flashItems };
        try { answer = String(evalExpr(active.answer_expression, scope)); }
        catch (e) { throw new Error(`answer_expression "${active.answer_expression}" failed in ${active.id}: ${e.message}`); }
      } else if (active.answer !== undefined) {
        answer = String(active.answer);
      }
    }

    // ── 7. Flash timing ──────────────────────────────────────────
    const profile = active.stimulus?.duration_profile;
    const timing = flashTiming(profile, flashItems, grid, stimulusText);

    return {
      id: active.id,
      level: active.level,
      category: active.category,
      format: active.format,
      stimulusType,
      stimulusText,
      flashItems,
      grid,
      flashItemDurationMs: timing.perItem,
      flashTotalMs: timing.total,
      question,
      options,
      answerTolerance: active.answer_tolerance || 0,
      // Server-private
      _answer: answer,
      _correctOption: correctOption,
      _acceptedAnswers: active.accepted_answers || null,
      _caseInsensitive: active.case_insensitive !== false,
    };
  }

  // ── Answer checking ────────────────────────────────────────────
  checkAnswer(resolved, submitted) {
    const { format, options, _answer, _correctOption, _acceptedAnswers, _caseInsensitive, answerTolerance } = resolved;
    const subRaw = String(submitted ?? '').trim();

    if (format === 'mcq') {
      // Client sends the chosen index in the shuffled options array.
      if (/^\d+$/.test(subRaw)) {
        const idx = parseInt(subRaw, 10);
        if (options && idx >= 0 && idx < options.length) {
          return { correct: options[idx] === _correctOption };
        }
      }
      // Fallback: compare submitted text to correctOption
      return { correct: subRaw === _correctOption };
    }

    // free_form
    // Numeric path: if answer looks numeric, do numeric comparison with tolerance.
    if (_answer !== null && /^-?\d+(\.\d+)?$/.test(_answer)) {
      const sub = parseFloat(subRaw.replace(/,/g, ''));
      const ans = parseFloat(_answer);
      if (!isNaN(sub) && !isNaN(ans)) {
        return { correct: Math.abs(sub - ans) <= (answerTolerance || 0) };
      }
      return { correct: false };
    }

    // Text path
    const norm = s => {
      const t = String(s).trim();
      return _caseInsensitive ? t.toLowerCase() : t;
    };
    const subN = norm(subRaw);
    if (_answer !== null && norm(_answer) === subN) return { correct: true };
    if (_acceptedAnswers) {
      for (const a of _acceptedAnswers) {
        if (norm(a) === subN) return { correct: true };
      }
    }
    return { correct: false };
  }

  // Strip server-private fields for client broadcast.
  clientView(resolved) {
    const { _answer, _correctOption, _acceptedAnswers, _caseInsensitive, ...pub } = resolved;
    return pub;
  }
}

module.exports = new PuzzleBank();
