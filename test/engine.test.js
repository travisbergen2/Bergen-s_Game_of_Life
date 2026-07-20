/* Unit tests for Bergen's Game of Life engine. Run: node test/engine.test.js */
"use strict";
const assert = require("assert");
const L = require("../engine.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("  PASS  " + name); }
  catch (e) { failed++; console.error("  FAIL  " + name + "\n        " + e.message); }
}

// ---------- Conway baseline correctness ----------

test("Conway: blinker has period 2", () => {
  const w = new L.World(8, 8, { mode: L.MODE_CONWAY, seed: 1 });
  w.clear();
  // horizontal blinker at row 3
  w.setAlive(2, 3, true); w.setAlive(3, 3, true); w.setAlive(4, 3, true);
  w.step();
  // should now be vertical
  assert.strictEqual(w.getAlive(3, 2), 1);
  assert.strictEqual(w.getAlive(3, 3), 1);
  assert.strictEqual(w.getAlive(3, 4), 1);
  assert.strictEqual(w.getAlive(2, 3), 0);
  assert.strictEqual(w.getAlive(4, 3), 0);
  w.step();
  // back to horizontal
  assert.strictEqual(w.getAlive(2, 3), 1);
  assert.strictEqual(w.getAlive(3, 3), 1);
  assert.strictEqual(w.getAlive(4, 3), 1);
});

test("Conway: glider translates by (1,1) after 4 steps", () => {
  const w = new L.World(16, 16, { mode: L.MODE_CONWAY, seed: 1 });
  w.clear();
  // standard glider
  const cells = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]];
  cells.forEach(([x, y]) => w.setAlive(x + 4, y + 4, true));
  for (let i = 0; i < 4; i++) w.step();
  cells.forEach(([x, y]) => {
    assert.strictEqual(w.getAlive(x + 5, y + 5), 1, `expected alive at ${x + 5},${y + 5}`);
  });
  // population conserved for a glider
  assert.strictEqual(w.stats().alive, 5);
});

test("Conway: empty world stays empty", () => {
  const w = new L.World(10, 10, { mode: L.MODE_CONWAY, seed: 1 });
  w.clear();
  for (let i = 0; i < 5; i++) w.step();
  assert.strictEqual(w.stats().alive, 0);
});

// ---------- Entropy ----------

test("binaryEntropy: H(0)=H(1)=0, H(0.5)=1, symmetric", () => {
  assert.strictEqual(L.binaryEntropy(0), 0);
  assert.strictEqual(L.binaryEntropy(1), 0);
  assert.ok(Math.abs(L.binaryEntropy(0.5) - 1) < 1e-12);
  assert.ok(Math.abs(L.binaryEntropy(0.25) - L.binaryEntropy(0.75)) < 1e-12);
});

test("localEntropy: bounded in [H_FLOOR, 1] and floors at calm", () => {
  const w = new L.World(4, 4, { seed: 1 });
  assert.strictEqual(w.localEntropy(0, 0), L.PARAMS.H_FLOOR); // dead calm -> floor
  assert.ok(w.localEntropy(4, 8) <= 1);                        // max mix + max flicker
  assert.ok(w.localEntropy(4, 8) > w.localEntropy(4, 0));      // flicker raises H
});

// ---------- Matching Principle ----------

test("matchQuality: maximal exactly at TI = clamp(1/H) and falls off both sides", () => {
  const w = new L.World(4, 4, { seed: 1 });
  const H = 0.25; // target TI = 4
  const atTarget = w.matchQuality(4, H);
  assert.ok(atTarget > 0.999);
  assert.ok(w.matchQuality(2, H) < atTarget);
  assert.ok(w.matchQuality(8, H) < atTarget);
  // symmetric in log space
  assert.ok(Math.abs(w.matchQuality(2, H) - w.matchQuality(8, H)) < 1e-9);
});

test("mismatch sign convention: TI too high > 0 (freeze side), too low < 0", () => {
  const w = new L.World(4, 4, { seed: 1 });
  assert.ok(w.mismatch(16, 0.5) > 0);
  assert.ok(w.mismatch(1, 0.1) < 0);
});

// ---------- Failure-mode classification ----------

test("classify: overload when SG*H exceeds overload point", () => {
  const w = new L.World(4, 4, { seed: 1 });
  w.clear();
  const i = w.idx(1, 1);
  w.alive[i] = 1;
  w.sg[i] = 3.0; w.ti[i] = 2;
  assert.strictEqual(w.classify(i, 0.9), L.OVERLOAD); // 2.7 > 1.6
});

test("classify: freeze when TI far above 1/H, oscillation when far below", () => {
  const w = new L.World(4, 4, { seed: 1 });
  w.clear();
  const i = w.idx(1, 1);
  w.alive[i] = 1; w.sg[i] = 0.5;
  w.ti[i] = 16; assert.strictEqual(w.classify(i, 0.9), L.FREEZE);      // target ~1.1
  w.ti[i] = 1;  assert.strictEqual(w.classify(i, 0.08), L.OSCILLATION); // target 12.5
  w.ti[i] = 2;  assert.strictEqual(w.classify(i, 0.5), L.HEALTHY);      // target 2
});

test("classify: dead cells are DEAD regardless of parameters", () => {
  const w = new L.World(4, 4, { seed: 1 });
  w.clear();
  const i = w.idx(0, 0);
  w.ti[i] = 16; w.sg[i] = 3;
  assert.strictEqual(w.classify(i, 0.9), L.DEAD);
});

// ---------- Learning (UE) ----------

test("UE: cells adapt TI toward the matched value over time", () => {
  const w = new L.World(24, 24, { mode: L.MODE_BERGEN, seed: 7 });
  w.seedRandom(0.35);
  // force eager learners
  w.ue.fill(0.3);
  const meanAbsMismatch = () => {
    let s = 0, c = 0;
    for (let i = 0; i < w.w * w.h; i++) {
      if (w.alive[i]) { s += Math.abs(w.mismatch(w.ti[i], Math.max(w.hEff[i], L.PARAMS.H_FLOOR))); c++; }
    }
    return c ? s / c : 0;
  };
  for (let i = 0; i < 3; i++) w.step(); // let hEff populate
  const before = meanAbsMismatch();
  for (let i = 0; i < 40; i++) w.step();
  const after = meanAbsMismatch();
  assert.ok(w.stats().alive > 0, "population died out entirely");
  assert.ok(after < before, `mismatch should shrink: before=${before.toFixed(3)} after=${after.toFixed(3)}`);
});

// ---------- Determinism & general sanity ----------

test("determinism: same seed gives identical trajectories", () => {
  const a = new L.World(20, 20, { mode: L.MODE_BERGEN, seed: 123 });
  const b = new L.World(20, 20, { mode: L.MODE_BERGEN, seed: 123 });
  a.seedRandom(); b.seedRandom();
  for (let i = 0; i < 25; i++) { a.step(); b.step(); }
  assert.deepStrictEqual(Array.from(a.alive), Array.from(b.alive));
  const sa = a.stats(), sb = b.stats();
  assert.deepStrictEqual(sa, sb);
});

test("different seeds give different trajectories", () => {
  const a = new L.World(20, 20, { mode: L.MODE_BERGEN, seed: 1 });
  const b = new L.World(20, 20, { mode: L.MODE_BERGEN, seed: 2 });
  a.seedRandom(); b.seedRandom();
  for (let i = 0; i < 10; i++) { a.step(); b.step(); }
  assert.notDeepStrictEqual(Array.from(a.alive), Array.from(b.alive));
});

test("stats: category counts never exceed alive count", () => {
  const w = new L.World(30, 30, { mode: L.MODE_BERGEN, seed: 5 });
  w.seedRandom();
  for (let i = 0; i < 30; i++) {
    w.step();
    const s = w.stats();
    assert.ok(s.healthy + s.oscillation + s.freeze + s.overload <= s.alive + 0,
      "status categories exceed alive population");
  }
});

test("energies stay bounded in [0, 1]", () => {
  const w = new L.World(24, 24, { mode: L.MODE_BERGEN, seed: 9 });
  w.seedRandom();
  for (let s = 0; s < 40; s++) {
    w.step();
    for (let i = 0; i < w.w * w.h; i++) {
      assert.ok(w.energy[i] >= 0 && w.energy[i] <= 1, "energy out of bounds");
    }
  }
});

// ---------- Preset seeds ----------

test("preset twoWorlds: left half sparser than right half", () => {
  const w = new L.World(40, 30, { mode: L.MODE_BERGEN, seed: 11 });
  w.seedTwoWorlds();
  let left = 0, right = 0;
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < 40; x++) {
      if (w.alive[y * 40 + x]) { if (x < 20) left++; else right++; }
    }
  }
  assert.ok(left > 0 && right > 0, "both halves populated");
  assert.ok(right > left * 2, `right (${right}) should be much denser than left (${left})`);
});

test("preset showcase: all three failure modes visible within a few steps", () => {
  const w = new L.World(60, 40, { mode: L.MODE_BERGEN, seed: 13 });
  w.seedShowcase();
  let sawOsc = false, sawFrz = false, sawOvl = false;
  for (let s = 0; s < 6; s++) {
    w.step();
    const t = w.stats();
    if (t.oscillation > 0) sawOsc = true;
    if (t.freeze > 0) sawFrz = true;
    if (t.overload > 0) sawOvl = true;
  }
  assert.ok(sawOsc, "no oscillation cells appeared");
  assert.ok(sawFrz, "no frozen cells appeared");
  assert.ok(sawOvl, "no overloaded cells appeared");
});

test("preset showcase: colonies have UE=0 (cannot self-repair)", () => {
  const w = new L.World(60, 40, { mode: L.MODE_BERGEN, seed: 13 });
  w.seedShowcase();
  let zeroUE = 0;
  for (let i = 0; i < 60 * 40; i++) if (w.alive[i] && w.ue[i] === 0) zeroUE++;
  assert.ok(zeroUE > 50, `expected many UE=0 colony cells, got ${zeroUE}`);
});

test("preset gliders: 4 gliders translate correctly in Conway mode", () => {
  const w = new L.World(40, 30, { mode: L.MODE_CONWAY, seed: 17 });
  w.seedGliders();
  assert.strictEqual(w.stats().alive, 20); // 4 gliders x 5 cells
  for (let i = 0; i < 4; i++) w.step();
  assert.strictEqual(w.stats().alive, 20, "gliders should be conserved after one period");
  // first glider seeded at (4,4) translates to (5,5)
  const glider = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]];
  glider.forEach(([x, y]) => assert.strictEqual(w.getAlive(5 + x, 5 + y), 1));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
