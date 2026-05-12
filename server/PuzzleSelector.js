'use strict';

const bank = require('./PuzzleBank');

// Selects the puzzle template for each room according to the DOORS spec:
//   Room 1:    always word_recall_5 (level 1, recall)
//   Rooms 2–5: levels 1–3; never same level or category as previous room;
//              never a previously used puzzle.
//   Rooms 6–10: levels 1–4, same constraints, plus at most one level-4
//               puzzle per game.
//
// Falls back gracefully (relaxing category, then level constraint) if the
// puzzle bank is too small to satisfy strict rules — this should not happen
// with the 20-puzzle v1 bank but guards against edge cases.

class PuzzleSelector {
  constructor() {
    this.reset();
  }

  reset() {
    this.usedIds = new Set();
    this.previousLevel = null;
    this.previousCategory = null;
    this.level4Used = false;
  }

  // Returns a puzzle template (not yet resolved) for the given room number.
  selectForRoom(roomNumber) {
    if (roomNumber === 1) {
      const tmpl = bank.getById('word_recall_5');
      this._record(tmpl);
      return tmpl;
    }

    const maxLevel = roomNumber <= 5 ? 3 : 4;

    // Try progressively relaxed constraint sets until we find a candidate.
    const pool = bank.getAll();
    const tiers = [
      // Tier 1 – full constraints
      p => this._baseFilter(p, maxLevel) && p.level !== this.previousLevel && p.category !== this.previousCategory,
      // Tier 2 – relax category
      p => this._baseFilter(p, maxLevel) && p.level !== this.previousLevel,
      // Tier 3 – relax level too
      p => this._baseFilter(p, maxLevel),
      // Tier 4 – any unused puzzle within level cap
      p => !this.usedIds.has(p.id) && p.level <= maxLevel,
    ];

    for (const filter of tiers) {
      const candidates = pool.filter(filter);
      if (candidates.length > 0) {
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        this._record(pick);
        return pick;
      }
    }

    // Should never reach here with the 20-puzzle bank but handle gracefully.
    const fallback = pool.find(p => p.level <= maxLevel);
    this._record(fallback);
    return fallback;
  }

  _baseFilter(p, maxLevel) {
    if (this.usedIds.has(p.id)) return false;
    if (p.level > maxLevel) return false;
    if (p.level === 4 && this.level4Used) return false;
    return true;
  }

  _record(tmpl) {
    if (!tmpl) return;
    this.usedIds.add(tmpl.id);
    if (tmpl.level === 4) this.level4Used = true;
    this.previousLevel = tmpl.level;
    this.previousCategory = tmpl.category;
  }
}

module.exports = PuzzleSelector;
