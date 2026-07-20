# Bergen's Game of Life

**Live site:** https://travisbergen2.github.io/Bergen-s_Game_of_Life/

A Game of Life where every cell is a tiny listener. Cells that keep pace with
their world thrive. Cells that listen too fast, too slow, or too loud fail —
in three different, visible ways.

Classic Conway (B3/S23) is included as a toggleable baseline so you can see
what's different.

## What this is (and isn't)

This is an **illustration** of concepts from the
[Information Manifold Model](https://doi.org/10.5281/zenodo.19697792) paper
series — specifically the RPCS-1 receiver primitives (Paper 9), the Matching
Principle (Pred-09-5), and the receiver failure modes (Paper 11, Theorem 11-2).

It is an artistic sandbox, **not evidence**. Nothing that happens on this grid
bears on whether any IMM claim is true. The Matching Principle is a registered
prediction of the framework, not an established law.

## How it works

Each live cell carries five continuous parameters (the RPCS-1 receiver
primitives) instead of a single alive/dead bit:

| Primitive | Meaning here | Range |
|---|---|---|
| `TI` — temporal integration | EMA window over the neighborhood's alive fraction | 1–16 steps |
| `SG` — sensitivity/gain | Amplification of the detected signal | 0.2–3.0 |
| `FT` — filter threshold | Minimum neighborhood signal that registers | 0–0.6 |
| `UE` — update eagerness | Learning rate: how fast the cell re-tunes its own TI | 0–0.5 |
| `AR` — anticipation | Directional guess about the neighborhood's next move; correct guesses earn a small energy bonus | ±1 |

**Environment coordinate.** Local entropy `H ∈ [0.02, 1]` is half spatial
(binary entropy of the 8-neighborhood alive fraction) and half temporal
(fraction of neighbors that flipped last step).

**Survival rule (Matching Principle).** A cell earns energy in proportion to
how well `TI ≈ 1/H` holds, with mismatch scored symmetrically in log space:

```
mismatch = ln( TI / clamp(1/H, 1, 16) )
match    = exp( −mismatch² / 2σ² ),  σ = 0.9
```

Energy budget per step: `+0.16·match` + gated/amplified neighborhood signal
(`SG·max(0, integrated − FT)`, capped) + anticipation bonus − metabolic cost
(0.11) − crowding/isolation penalties. A cell is alive while energy > 0.35.

**Failure modes** (rendered as distinct colors):

- **Oscillation** (amber) — `TI` far below `1/H`: reacts to every flicker.
- **Freeze/rigidity** (blue) — `TI` far above `1/H`: stops responding to real change.
- **Overload** (red) — `SG·H > 1.6`: too much gain in too noisy a world; drains energy directly.

**Learning.** Each step, live cells drift `TI` toward `1/H` at rate `UE` (plus
noise). Births need ≥3 energized neighbors and inherit the neighborhood's mean
`TI` (culture, not genetics) plus noise. Set the *Learning* slider to zero and
failure modes accumulate.

The simulation is deterministic given a seed (mulberry32 PRNG).

**Preset worlds** (dropdown in the toolbar):

- **Random soup** — uniform random seed (default).
- **Two worlds** — calm sparse left half vs dense noisy right half; the same
  learning rule drives TI to opposite targets on each side.
- **Failure showcase** — three colonies with deliberately mis-set,
  non-learning receivers (UE = 0): one listening too fast (oscillation), one
  too slow (freeze), one turned up too loud (overload). Each displays its
  failure color, then pays for it.
- **Gliders** — classic Conway gliders (auto-switches to baseline mode).

## Files

- `index.html` — the site (vanilla JS + Canvas, no build step, no dependencies)
- `engine.js` — pure simulation engine (UMD: works in browser and Node)
- `test/engine.test.js` — unit tests

## Running locally

Open `index.html` in a browser (or `python3 -m http.server` in the repo root).

## Running the tests

```
node test/engine.test.js
```

Covers: Conway blinker/glider/empty-world correctness, entropy properties,
Matching-Principle kernel shape and sign conventions, failure-mode
classification, UE adaptation (mean |mismatch| shrinks over time),
determinism per seed, boundedness invariants, and preset seeds (density
split, all three failure modes appearing, glider conservation). 19 tests.

## Credits

- Baseline cellular automaton rules: John Conway, *Game of Life* (1970).
- Receiver concepts: IMM Papers 9 and 11 (Travis Bergen,
  [Zenodo series](https://doi.org/10.5281/zenodo.19697792)).
- Receiver tuning in practice: [rpcs1.dev](https://rpcs1.dev).

## License

See [LICENSE](LICENSE).
