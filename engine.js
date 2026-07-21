/*
 * Bergen's Game of Life — engine
 *
 * A cellular automaton where each cell is a bounded receiver carrying the
 * five RPCS-1 primitives (IMM Paper 9) as continuous state:
 *
 *   TI — temporal integration: how long a window of the past the cell averages over
 *   SG — sensitivity/gain:     how strongly it amplifies the neighborhood signal
 *   FT — filter threshold:     minimum signal needed to register at all
 *   UE — update eagerness:     learning rate on its own parameters
 *   AR — anticipation:         directional guess about the neighborhood's next move
 *
 * The environment coordinate is local neighborhood entropy H (spatial mix +
 * temporal flicker). The Matching Principle (Pred-09-5, TI ≈ 1/H) is the
 * survival rule: cells whose integration window matches their local world
 * keep energy; mismatched cells drift into the three failure modes of
 * IMM Paper 11 (Theorem 11-2): oscillation, freeze/rigidity, overload.
 *
 * EPISTEMIC NOTE: this is an illustration of IMM/RPCS-1 concepts, not
 * evidence for any IMM claim. Nothing here bears on the framework's truth.
 *
 * Classic Conway (B3/S23) is included as a baseline mode.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BergenLife = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Deterministic PRNG (mulberry32) so runs are reproducible from a seed.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- Parameter ranges (documented in README parameter table) ----
  const P = {
    TI_MIN: 1, TI_MAX: 16,       // integration window (steps)
    SG_MIN: 0.2, SG_MAX: 3.0,    // gain
    FT_MIN: 0.0, FT_MAX: 0.6,    // detection threshold on neighborhood fraction
    UE_MIN: 0.0, UE_MAX: 0.5,    // learning rate
    ENERGY_ALIVE: 0.35,          // energy above which a cell counts as alive
    ENERGY_MAX: 1.0,
    METABOLIC_COST: 0.11,        // per-step upkeep
    MATCH_GAIN: 0.16,            // energy gained by a perfectly matched cell
    SIGNAL_GAIN: 0.05,           // energy from gated+amplified neighborhood signal
    AR_BONUS: 0.02,              // energy bonus for a correct anticipation
    BIRTH_NEIGHBORS: 3,          // energized neighbors needed to seed a dead cell
    BIRTH_ENERGY: 0.45,
    OVERLOAD_DRAIN: 0.10,        // extra drain when SG*H exceeds overload point
    OVERLOAD_POINT: 1.6,
    H_FLOOR: 0.02,               // entropy floor so 1/H stays finite
    MISMATCH_SIGMA: 0.9,         // width of the matching kernel in log space
    FAILURE_MISMATCH: 1.1        // |log(TI*Heff/TI_MAX-normalized)| beyond this = failure
  };

  const MODE_CONWAY = "conway";
  const MODE_BERGEN = "bergen";

  // Cell status codes (for rendering)
  const DEAD = 0, HEALTHY = 1, OSCILLATION = 2, FREEZE = 3, OVERLOAD = 4;

  function binaryEntropy(p) {
    if (p <= 0 || p >= 1) return 0;
    return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
  }

  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  function World(w, h, opts) {
    opts = opts || {};
    this.w = w;
    this.h = h;
    this.mode = opts.mode || MODE_BERGEN;
    // RNG state lives on the instance (not in a closure) so snapshots can
    // capture and restore it — rewinding then stepping forward reproduces
    // the exact same trajectory.
    this._rngState = (opts.seed == null ? 42 : opts.seed) >>> 0;
    const self = this;
    this.rng = function () {
      self._rngState |= 0;
      self._rngState = (self._rngState + 0x6d2b79f5) | 0;
      let t = Math.imul(self._rngState ^ (self._rngState >>> 15), 1 | self._rngState);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.step_ = 0;
    const n = w * h;
    // State arrays
    this.energy = new Float32Array(n);
    this.prevAlive = new Uint8Array(n);   // alive at t-1 (for flicker)
    this.alive = new Uint8Array(n);       // alive at t
    this.ti = new Float32Array(n);
    this.sg = new Float32Array(n);
    this.ft = new Float32Array(n);
    this.ue = new Float32Array(n);
    this.arPred = new Int8Array(n);       // predicted direction of neighborhood change
    this.lastNbFrac = new Float32Array(n);
    this.hEff = new Float32Array(n);      // last computed effective local entropy
    this.status = new Uint8Array(n);
    this.flipCount = new Uint8Array(n);   // recent state flips (oscillation telltale)
    // TI history: exponential moving average of neighborhood fraction with
    // per-cell window TI (EMA alpha = 1/TI) — O(1) memory per cell.
    this.integrated = new Float32Array(n);
  }

  World.prototype.idx = function (x, y) {
    // toroidal wrap
    const w = this.w, h = this.h;
    return ((y + h) % h) * w + ((x + w) % w);
  };

  World.prototype.randomizeCell = function (i, energized) {
    const r = this.rng;
    this.ti[i] = P.TI_MIN + r() * (P.TI_MAX - P.TI_MIN);
    this.sg[i] = P.SG_MIN + r() * (P.SG_MAX - P.SG_MIN);
    this.ft[i] = P.FT_MIN + r() * (P.FT_MAX - P.FT_MIN);
    this.ue[i] = P.UE_MIN + r() * (P.UE_MAX - P.UE_MIN);
    this.arPred[i] = r() < 0.5 ? -1 : 1;
    this.energy[i] = energized ? P.BIRTH_ENERGY + r() * 0.3 : 0;
    this.alive[i] = this.energy[i] > P.ENERGY_ALIVE ? 1 : 0;
  };

  World.prototype.seedRandom = function (density) {
    density = density == null ? 0.28 : density;
    for (let i = 0; i < this.w * this.h; i++) {
      this.randomizeCell(i, this.rng() < density);
    }
    this.syncPrev();
  };

  // ---- Preset seeds ----

  // Two worlds: calm sparse left half vs dense noisy right half.
  // Watch TI adapt to opposite targets on each side.
  World.prototype.seedTwoWorlds = function () {
    this.clear();
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        const density = x < this.w / 2 ? 0.10 : 0.45;
        this.randomizeCell(i, this.rng() < density);
      }
    }
    this.syncPrev();
  };

  // Failure showcase: three colonies with deliberately mis-set, non-learning
  // receivers (UE=0), plus a sparse background soup. Each colony displays one
  // failure mode, then pays for it.
  World.prototype.seedShowcase = function () {
    this.clear();
    const r = this.rng;
    for (let i = 0; i < this.w * this.h; i++) {
      this.randomizeCell(i, r() < 0.08);
    }
    const stamp = (cx, cy, rad, density, setup) => {
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (dx * dx + dy * dy > rad * rad) continue;
          if (r() >= density) continue;
          const i = this.idx(cx + dx, cy + dy);
          this.randomizeCell(i, true);
          setup(i);
        }
      }
    };
    const w = this.w, h = this.h, rad = Math.max(4, Math.floor(Math.min(w, h) / 7));
    // Jittery colony: solid calm block, but TI stuck at minimum (listens too fast)
    stamp(Math.floor(w * 0.2), Math.floor(h * 0.5), rad, 1.0, (i) => {
      this.ti[i] = P.TI_MIN; this.ue[i] = 0; this.sg[i] = 1.0;
    });
    // Frozen colony: scattered flickery region, but TI stuck at maximum (listens too slow)
    stamp(Math.floor(w * 0.5), Math.floor(h * 0.5), rad, 0.55, (i) => {
      this.ti[i] = P.TI_MAX; this.ue[i] = 0; this.sg[i] = 1.0;
    });
    // Overloaded colony: scattered noisy region with gain cranked to maximum
    stamp(Math.floor(w * 0.8), Math.floor(h * 0.5), rad, 0.55, (i) => {
      this.sg[i] = P.SG_MAX; this.ue[i] = 0;
    });
    this.syncPrev();
  };

  // Gliders: classic Conway gliders (intended for MODE_CONWAY).
  World.prototype.seedGliders = function () {
    this.clear();
    const glider = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]];
    const spots = [[4, 4], [Math.floor(this.w / 2), 8], [8, Math.floor(this.h / 2)],
                   [Math.floor(this.w * 0.7), Math.floor(this.h * 0.6)]];
    for (const [ox, oy] of spots) {
      for (const [x, y] of glider) this.setAlive(ox + x, oy + y, true);
    }
    this.syncPrev();
  };

  World.prototype.clear = function () {
    this.energy.fill(0); this.alive.fill(0); this.prevAlive.fill(0);
    this.status.fill(DEAD); this.flipCount.fill(0); this.integrated.fill(0);
    this.step_ = 0;
  };

  World.prototype.setAlive = function (x, y, on) {
    const i = this.idx(x, y);
    if (on) {
      this.randomizeCell(i, true);
      this.alive[i] = 1;
      this.energy[i] = 0.8;
    } else {
      this.alive[i] = 0;
      this.energy[i] = 0;
    }
    this.prevAlive[i] = this.alive[i];
  };

  World.prototype.getAlive = function (x, y) { return this.alive[this.idx(x, y)]; };

  World.prototype.syncPrev = function () { this.prevAlive.set(this.alive); };

  World.prototype.neighborStats = function (x, y) {
    // returns [aliveCount, flickerCount] over the 8-neighborhood
    let count = 0, flick = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const j = this.idx(x + dx, y + dy);
        count += this.alive[j];
        if (this.alive[j] !== this.prevAlive[j]) flick++;
      }
    }
    return [count, flick];
  };

  // Effective local entropy in [H_FLOOR, 1]:
  // half spatial (binary entropy of alive fraction), half temporal (flicker rate).
  World.prototype.localEntropy = function (aliveCount, flickerCount) {
    const pSpatial = aliveCount / 8;
    const hSpatial = binaryEntropy(pSpatial);
    const hTemporal = flickerCount / 8;
    return clamp(0.5 * hSpatial + 0.5 * hTemporal, P.H_FLOOR, 1);
  };

  // Matching Principle kernel: perfect when TI ≈ TI_MAX-scaled 1/H.
  // We normalize so that TI* = clamp(1/H, TI_MIN, TI_MAX); mismatch is measured
  // in log space (symmetric for too-fast vs too-slow).
  World.prototype.targetTI = function (hEff) {
    return clamp(1 / hEff, P.TI_MIN, P.TI_MAX);
  };

  World.prototype.mismatch = function (ti, hEff) {
    const tStar = this.targetTI(hEff);
    return Math.log(ti / tStar); // >0: TI too high (freeze side), <0: too low (oscillation side)
  };

  World.prototype.matchQuality = function (ti, hEff) {
    const m = this.mismatch(ti, hEff);
    return Math.exp(-(m * m) / (2 * P.MISMATCH_SIGMA * P.MISMATCH_SIGMA));
  };

  World.prototype.classify = function (i, hEff) {
    if (!this.alive[i]) return DEAD;
    if (this.sg[i] * hEff > P.OVERLOAD_POINT) return OVERLOAD;
    const m = this.mismatch(this.ti[i], hEff);
    if (m > P.FAILURE_MISMATCH) return FREEZE;
    if (m < -P.FAILURE_MISMATCH) return OSCILLATION;
    return HEALTHY;
  };

  World.prototype.stepConway = function () {
    const w = this.w, h = this.h;
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const [n] = this.neighborStats(x, y);
        next[i] = this.alive[i] ? (n === 2 || n === 3 ? 1 : 0) : (n === 3 ? 1 : 0);
      }
    }
    this.prevAlive.set(this.alive);
    this.alive.set(next);
    for (let i = 0; i < w * h; i++) {
      this.energy[i] = this.alive[i] ? 1 : 0;
      this.status[i] = this.alive[i] ? HEALTHY : DEAD;
    }
    this.step_++;
  };

  World.prototype.stepBergen = function () {
    const w = this.w, h = this.h, n = w * h;
    const nextEnergy = new Float32Array(n);
    const nextAlive = new Uint8Array(n);
    const r = this.rng;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const [aliveCount, flickerCount] = this.neighborStats(x, y);
        const nbFrac = aliveCount / 8;
        const hEff = this.localEntropy(aliveCount, flickerCount);
        this.hEff[i] = hEff;

        if (this.alive[i]) {
          // --- perception: FT gate, SG amplification, TI integration ---
          const alpha = 1 / this.ti[i];
          this.integrated[i] += alpha * (nbFrac - this.integrated[i]);
          const raw = this.integrated[i] - this.ft[i];
          const signal = raw > 0 ? this.sg[i] * raw : 0;

          // --- anticipation (AR): predict direction of neighborhood change ---
          const actualDir = nbFrac > this.lastNbFrac[i] ? 1 : nbFrac < this.lastNbFrac[i] ? -1 : 0;
          const arCorrect = actualDir !== 0 && actualDir === this.arPred[i];
          // next prediction: follow momentum
          this.arPred[i] = actualDir !== 0 ? actualDir : this.arPred[i];

          // --- energy budget ---
          const match = this.matchQuality(this.ti[i], hEff);
          let e = this.energy[i]
            + P.MATCH_GAIN * match
            + P.SIGNAL_GAIN * Math.min(signal, 1)
            + (arCorrect ? P.AR_BONUS : 0)
            - P.METABOLIC_COST;
          // overload drain: too much gain in too noisy a world
          if (this.sg[i] * hEff > P.OVERLOAD_POINT) e -= P.OVERLOAD_DRAIN;
          // isolation and crowding still matter (life is social):
          if (aliveCount < 2) e -= 0.08;
          if (aliveCount > 4) e -= (aliveCount - 4) * 0.045;
          nextEnergy[i] = clamp(e, 0, P.ENERGY_MAX);
          nextAlive[i] = nextEnergy[i] > P.ENERGY_ALIVE ? 1 : 0;

          // --- learning (UE): drift TI toward the matched value ---
          const tStar = this.targetTI(hEff);
          this.ti[i] = clamp(
            this.ti[i] + this.ue[i] * (tStar - this.ti[i]) + (r() - 0.5) * 0.1,
            P.TI_MIN, P.TI_MAX
          );
        } else {
          // birth: enough energized neighbors seed a new receiver that inherits
          // the neighborhood's mean TI (culture, not genetics) plus noise
          if (aliveCount >= P.BIRTH_NEIGHBORS && r() < 0.55) {
            let tiSum = 0, cnt = 0;
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const j = this.idx(x + dx, y + dy);
                if (this.alive[j]) { tiSum += this.ti[j]; cnt++; }
              }
            }
            this.randomizeCell(i, false);
            if (cnt > 0) this.ti[i] = clamp(tiSum / cnt + (r() - 0.5), P.TI_MIN, P.TI_MAX);
            nextEnergy[i] = P.BIRTH_ENERGY;
            nextAlive[i] = 1;
            this.integrated[i] = nbFrac;
          }
        }
        this.lastNbFrac[i] = nbFrac;
      }
    }

    // flip tracking + status classification
    for (let i = 0; i < n; i++) {
      if (nextAlive[i] !== this.alive[i]) {
        this.flipCount[i] = Math.min(this.flipCount[i] + 2, 8);
      } else if (this.flipCount[i] > 0) {
        this.flipCount[i]--;
      }
    }
    this.prevAlive.set(this.alive);
    this.alive.set(nextAlive);
    this.energy.set(nextEnergy);
    for (let i = 0; i < n; i++) this.status[i] = this.classify(i, this.hEff[i]);
    this.step_++;
  };

  World.prototype.step = function () {
    if (this.mode === MODE_CONWAY) this.stepConway();
    else this.stepBergen();
  };

  // Full-state snapshot for step-back / replay. Includes RNG state, so
  // restore() followed by step() reproduces the exact same trajectory.
  const SNAP_ARRAYS = ["energy", "prevAlive", "alive", "ti", "sg", "ft", "ue",
    "arPred", "lastNbFrac", "hEff", "status", "flipCount", "integrated"];

  World.prototype.snapshot = function () {
    const s = { step_: this.step_, _rngState: this._rngState, mode: this.mode };
    for (const k of SNAP_ARRAYS) s[k] = this[k].slice();
    return s;
  };

  World.prototype.restore = function (s) {
    this.step_ = s.step_;
    this._rngState = s._rngState;
    this.mode = s.mode;
    for (const k of SNAP_ARRAYS) this[k].set(s[k]);
  };

  World.prototype.stats = function () {
    let alive = 0, healthy = 0, osc = 0, frz = 0, ovl = 0;
    for (let i = 0; i < this.w * this.h; i++) {
      if (this.alive[i]) alive++;
      switch (this.status[i]) {
        case HEALTHY: healthy++; break;
        case OSCILLATION: osc++; break;
        case FREEZE: frz++; break;
        case OVERLOAD: ovl++; break;
      }
    }
    return { step: this.step_, alive, healthy, oscillation: osc, freeze: frz, overload: ovl };
  };

  return {
    World, mulberry32, binaryEntropy,
    PARAMS: P,
    MODE_CONWAY, MODE_BERGEN,
    DEAD, HEALTHY, OSCILLATION, FREEZE, OVERLOAD
  };
});
