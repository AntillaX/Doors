'use strict';

const fs = require('fs');
const path = require('path');

const PUZZLES_PATH = path.join(__dirname, 'data/puzzles.json');
const MAX_ROLL_ATTEMPTS = 20;

// Math helpers injected into expression evaluation scope
const _math = { ceil: Math.ceil, floor: Math.floor, round: Math.round, abs: Math.abs, min: Math.min, max: Math.max };

// Evaluate a JS-like expression with a given scope of named values.
// ^ is replaced with ** so puzzle JSON can use caret for exponentiation.
function evalExpr(expr, scope) {
  const safeExpr = expr.replace(/\^/g, '**');
  const keys = ['math', 'min', 'abs', 'ceil', 'floor', 'round', ...Object.keys(scope)];
  const vals = [_math, Math.min, Math.abs, Math.ceil, Math.floor, Math.round,
                ...Object.keys(scope).map(k => scope[k])];
  try {
    return new Function(...keys, '"use strict"; return (' + safeExpr + ')').apply(null, vals);
  } catch (e) {
    throw new Error(`evalExpr failed for "${expr}": ${e.message}`);
  }
}

function rollParam(spec) {
  if (spec.type === 'choice') {
    return spec.values[Math.floor(Math.random() * spec.values.length)];
  }
  const step = spec.step || 1;
  const slots = Math.floor((spec.max - spec.min) / step) + 1;
  return spec.min + Math.floor(Math.random() * slots) * step;
}

function rollParams(paramSpec) {
  const params = {};
  for (const [key, spec] of Object.entries(paramSpec)) {
    params[key] = rollParam(spec);
  }
  return params;
}

function checkConstraints(constraints, params) {
  for (const expr of constraints) {
    if (!evalExpr(expr, params)) return false;
  }
  return true;
}

// Fisher-Yates partial shuffle to draw `count` items from a pool without replacement.
function drawFromPool(pool, count) {
  const copy = [...pool];
  const n = copy.length;
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (n - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

function randomIntegers(count, min, max) {
  return Array.from({ length: count }, () => min + Math.floor(Math.random() * (max - min + 1)));
}

// Compute clock-time string after adding `ahead` whole hours.
// start_period is 'AM' | 'PM', hour is 1–12 (12-hour clock).
function compute_time(hour, period, ahead) {
  // Convert to 24-hour minutes-from-midnight
  let h24 = hour % 12; // 12 → 0, 1–11 → 1–11
  if (period === 'PM') h24 += 12;
  let totalMin = h24 * 60 + ahead * 60;
  totalMin = ((totalMin % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(totalMin / 60);
  const newHour = h % 12 || 12;
  const newPeriod = h < 12 ? 'AM' : 'PM';
  return `${newHour}:00 ${newPeriod}`;
}

// Compute PM arrival time string. Start time is always PM in these puzzles.
function compute_arrival(startHour, startMinute, durHours, durMinutes) {
  const totalMin = startHour * 60 + startMinute + durHours * 60 + durMinutes;
  const h = Math.floor(totalMin / 60) % 12 || 12;
  const m = totalMin % 60;
  return `${h}:${String(m).padStart(2, '0')} PM`;
}

// Canonical fraction string for a two-dice sum probability.
function dice_sum_fraction(target) {
  const map = { 5: '1/9', 6: '5/36', 7: '1/6', 8: '5/36', 9: '1/9' };
  return map[target] || '?';
}

// Substitute {expr} placeholders in a template string.
// Handles: {name}, {name:02d}, arithmetic like {start+2*step}, and the
// special variants[key].options joined by '...' pattern.
function substitutePlaceholders(text, params, questionFormat) {
  if (!text) return '';
  return text.replace(/\{([^}]+)\}/g, (match, raw) => {
    const expr = raw.trim();

    // Special: variants[varKey].options joined by 'sep'
    const joinMatch = expr.match(/^variants\[(\w+)\]\.options\s+joined\s+by\s+'([^']*)'/);
    if (joinMatch) {
      const v = params.variants[params[joinMatch[1]]];
      return v ? v.options.join(joinMatch[2]) : match;
    }

    // Zero-pad format: name:02d
    const padMatch = expr.match(/^(\w+):02d$/);
    if (padMatch) {
      const val = params[padMatch[1]];
      return val !== undefined ? String(val).padStart(2, '0') : match;
    }

    // Ordinal via question_format
    if (questionFormat && questionFormat[expr] !== undefined && params[expr] !== undefined) {
      const mapping = questionFormat[expr];
      if (Array.isArray(mapping)) {
        const idx = params[expr] - 1;
        if (mapping[idx] !== undefined) return mapping[idx];
      }
    }

    // General arithmetic / field expression
    try {
      const result = evalExpr(expr, params);
      return String(result);
    } catch {
      return match;
    }
  });
}

class PuzzleBank {
  constructor() {
    const raw = JSON.parse(fs.readFileSync(PUZZLES_PATH, 'utf8'));
    this.puzzles = raw.puzzles;
  }

  getAll() { return this.puzzles; }
  getById(id) { return this.puzzles.find(p => p.id === id) || null; }

  // Resolve a puzzle template into a concrete, ready-to-play puzzle.
  // The returned object is safe to broadcast to clients (no answer field).
  // Call checkAnswer(resolved, submitted) to verify responses.
  resolve(template) {
    // ── 1. Roll parameters ──────────────────────────────────────────
    let params = {};
    if (template.parameterized && template.params) {
      let attempts = 0;
      do {
        params = rollParams(template.params);
        if (++attempts > MAX_ROLL_ATTEMPTS) {
          throw new Error(`Constraint satisfaction failed for puzzle "${template.id}"`);
        }
      } while (template.constraints && !checkConstraints(template.constraints, params));
    }

    // Expose variants array so answer_expression can index into it
    if (template.variants) params.variants = template.variants;

    // ── 2. Resolve flash_sequence data ─────────────────────────────
    let flashItems = null;
    if (template.stimulus && template.stimulus.type === 'flash_sequence') {
      const s = template.stimulus;
      if (s.source === 'draw_from_word_pool') {
        const count = template.word_count || params.word_count || 5;
        flashItems = drawFromPool(template.word_pool, count);
        params.selected_words = flashItems; // available to answer_expression
      } else if (s.source === 'random_integers') {
        const count = params[s.count_field];
        const [lo, hi] = s.value_range;
        flashItems = randomIntegers(count, lo, hi);
        params.sequence = flashItems;
      }
    }

    // ── 3. Substitute text fields ───────────────────────────────────
    const stimulusText = template.stimulus ? substitutePlaceholders(template.stimulus.text, params, null) : '';
    const question = substitutePlaceholders(template.question, params, template.question_format);

    let options = null;
    if (template.answer_type === 'choice' && template.options) {
      options = template.options.map(o => substitutePlaceholders(o, params, null));
    }

    // ── 4. Compute answer (server-side only) ────────────────────────
    let answer;
    let acceptedAnswers = template.accepted_answers ? [...template.accepted_answers] : null;

    if (template.answer_expression) {
      const scope = { ...params, compute_time, compute_arrival, dice_sum_fraction };
      const raw = evalExpr(template.answer_expression, scope);
      answer = String(raw);

      // dice_sum_probability: expand accepted answers from per-target map
      if (template.accepted_answers_per_target) {
        acceptedAnswers = template.accepted_answers_per_target[String(params.target_sum)] || [];
        // Ensure canonical answer is also accepted
        if (!acceptedAnswers.includes(answer)) acceptedAnswers = [answer, ...acceptedAnswers];
      }
    } else if (template.answer_type === 'choice') {
      // For choice puzzles, the canonical answer is the option index as a string.
      answer = String(template.correct_option !== undefined ? template.correct_option : 0);
    } else {
      answer = template.answer;
    }

    // ── 5. Assemble resolved puzzle ─────────────────────────────────
    return {
      id: template.id,
      level: template.level,
      category: template.category,
      stimulusType: template.stimulus ? template.stimulus.type : 'static_text',
      stimulusText,
      flashItems,
      flashItemDurationMs: template.stimulus ? (template.stimulus.item_duration_ms || 0) : 0,
      question,
      answerType: template.answer_type,
      options,
      correctOption: template.correct_option !== undefined ? template.correct_option : null,
      answerTolerance: template.answer_tolerance || 0,
      caseInsensitive: template.case_insensitive !== false,
      // Server-private fields (never broadcast):
      _answer: answer,
      _acceptedAnswers: acceptedAnswers,
    };
  }

  // Returns { correct: bool }
  checkAnswer(resolved, submitted) {
    const { answerType, answerTolerance, correctOption, caseInsensitive, _answer, _acceptedAnswers } = resolved;

    if (answerType === 'numeric') {
      const n = parseFloat(String(submitted).trim());
      const a = parseFloat(_answer);
      if (isNaN(n)) return { correct: false };
      return { correct: Math.abs(n - a) <= answerTolerance };
    }

    if (answerType === 'choice') {
      return { correct: parseInt(submitted, 10) === correctOption };
    }

    // text
    const norm = s => { const t = String(s).trim(); return caseInsensitive ? t.toLowerCase() : t; };
    const sub = norm(submitted);
    if (norm(_answer) === sub) return { correct: true };
    if (_acceptedAnswers) {
      for (const a of _acceptedAnswers) {
        if (norm(a) === sub) return { correct: true };
      }
    }
    return { correct: false };
  }

  // Return a client-safe copy of a resolved puzzle (strip private fields).
  clientView(resolved) {
    const { _answer, _acceptedAnswers, ...pub } = resolved;
    return pub;
  }
}

module.exports = new PuzzleBank();
