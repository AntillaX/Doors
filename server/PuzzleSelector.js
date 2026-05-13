'use strict';

const bank = require('./PuzzleBank');

// DOORS v2 puzzle selection algorithm.
// Per DOORS_SPEC.md "Puzzle Selection Algorithm":
//
//   Hard constraints (always enforced):
//     1. No repeat puzzle ID
//     2. Room 1: the `is_room_one_default` puzzle (L1 recall MCQ)
//     3. Level cap by room: rooms_cleared < 5 → L1–L3 only; ≥5 → L1–L4
//     4. L4 cap: 1 for 4-player, 2 for 5-player
//     5. L3 cap: 2
//     6. No same LEVEL as previous puzzle
//     7. No same CATEGORY as previous puzzle
//     8. No same FORMAT (mcq/free_form) as previous puzzle
//
//   Soft constraint:
//     9. L2 pacing: weight L2 puzzles 3× when rooms_cleared ≥ 5 and l2_count < 2;
//        weight 5× when rooms_cleared ≥ 8 and l2_count < 4.
//
//   Failsafe (when no candidate passes all hard constraints):
//     - relax constraint 8 (format)        ← handles ~18% of games per spec
//     - then relax 7 (category)
//     - then relax 6 (level)
//     - hard constraints 1–5 are NEVER relaxed.

class PuzzleSelector {
  constructor(maxLevel4 = 1) {
    this.maxLevel4 = maxLevel4;
    this.reset();
  }

  reset() {
    this.drawnIds        = new Set();
    this.levelHistory    = [];
    this.categoryHistory = [];
    this.formatHistory   = [];
    this.l4DrawnCount    = 0;
    this.l3DrawnCount    = 0;
    this.l2DrawnCount    = 0;
    this.failsafeUsage   = { format: 0, category: 0, level: 0 };
  }

  // roomNumber:    current room (1-indexed)
  // roomsCleared:  number of rooms cleared so far (0 entering room 1)
  selectForRoom(roomNumber, roomsCleared) {
    // Room 1 hard rule: always the is_room_one_default puzzle (only first draw).
    if (roomNumber === 1 && this.drawnIds.size === 0) {
      const t = bank.getRoomOneDefault();
      if (!t) throw new Error('No is_room_one_default puzzle in bank');
      this._record(t);
      return t;
    }

    const pool = bank.getAll();
    const cleared = roomsCleared !== undefined ? roomsCleared : (roomNumber - 1);
    const prevLevel    = this.levelHistory[this.levelHistory.length - 1];
    const prevCategory = this.categoryHistory[this.categoryHistory.length - 1];
    const prevFormat   = this.formatHistory[this.formatHistory.length - 1];

    // Core hard constraints (NEVER relaxed).
    const corePredicate = p => {
      if (this.drawnIds.has(p.id)) return false;
      const maxLevel = cleared >= 5 ? 4 : 3;
      if (p.level > maxLevel) return false;
      if (p.level === 4 && this.l4DrawnCount >= this.maxLevel4) return false;
      if (p.level === 3 && this.l3DrawnCount >= 2) return false;
      return true;
    };

    const tiers = [
      { name: 'full', pred: p => corePredicate(p)
          && p.level    !== prevLevel
          && p.category !== prevCategory
          && p.format   !== prevFormat },
      { name: 'no_format', pred: p => corePredicate(p)
          && p.level    !== prevLevel
          && p.category !== prevCategory },
      { name: 'no_format_category', pred: p => corePredicate(p)
          && p.level    !== prevLevel },
      { name: 'no_format_category_level', pred: p => corePredicate(p) },
    ];

    let candidates = null;
    let usedTier = null;
    for (const tier of tiers) {
      const c = pool.filter(tier.pred);
      if (c.length > 0) { candidates = c; usedTier = tier.name; break; }
    }
    if (!candidates) {
      throw new Error('Puzzle selection deadlock: no candidates even after full relaxation');
    }
    if (usedTier !== 'full') {
      const key = usedTier === 'no_format' ? 'format'
                : usedTier === 'no_format_category' ? 'category' : 'level';
      this.failsafeUsage[key]++;
    }

    // Soft constraint: L2 pacing weight.
    const weighted = this._applyL2Weighting(candidates, cleared);
    const pick = weighted[Math.floor(Math.random() * weighted.length)];
    this._record(pick);
    return pick;
  }

  _applyL2Weighting(candidates, cleared) {
    let weight = 1;
    if (cleared >= 5 && this.l2DrawnCount < 2) weight = 3;
    if (cleared >= 8 && this.l2DrawnCount < 4) weight = 5;
    if (weight === 1) return candidates;
    const out = [];
    for (const c of candidates) {
      const w = c.level === 2 ? weight : 1;
      for (let i = 0; i < w; i++) out.push(c);
    }
    return out;
  }

  _record(t) {
    if (!t) return;
    this.drawnIds.add(t.id);
    this.levelHistory.push(t.level);
    this.categoryHistory.push(t.category);
    this.formatHistory.push(t.format);
    if (t.level === 2) this.l2DrawnCount++;
    if (t.level === 3) this.l3DrawnCount++;
    if (t.level === 4) this.l4DrawnCount++;
  }
}

module.exports = PuzzleSelector;
