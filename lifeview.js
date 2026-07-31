// lifeview.js — pure view model: frames → per-cell alpha with death afterglow.
// No WebGL, no canvas, no DOM — unit-testable transformation only.

// Reusable scratch buffers to avoid allocations each frame.
let scratchBuffer = null;
let lastFrameSetCellCount = 0;

/**
 * A cell's death history, in CSR (compressed sparse row) layout.
 *
 * WHY NOT ONE SCALAR PER CELL: alpha at generation G needs "the most recent
 * death AT OR BEFORE G". A single global most-recent-death scalar cannot answer
 * that. Recording only the FIRST death makes multi-death cells fade from a stale
 * generation; recording only the LAST death, plus a `<= G` guard, makes a
 * BACKWARD SCRUB into an earlier death window return 0 instead of the afterglow.
 * The player bar scrubs freely, so both directions are normal paths. Storing the
 * FULL, ascending list of death generations per cell answers the query for any G.
 *
 * Layout:
 *   offsets: Int32Array(cellCount + 1) — cell i owns gens[offsets[i] .. offsets[i+1])
 *   gens:    Int32Array(totalDeaths)   — death generations, ASCENDING within a cell
 *
 * Memory: 4 bytes per cell + 4 bytes per death event. For Helsinki's 108,170
 * cells that is 433 KB of offsets plus 4 bytes × (total 1→0 transitions across
 * all frames). A cell that never dies contributes zero entries.
 */
class DeathIndex {
  constructor(cellCount, offsets, gens) {
    this.cellCount = cellCount;
    this.offsets = offsets;
    this.gens = gens;
  }

  /**
   * Most recent death generation at or before `gen` for cell `i`, or -1 if the
   * cell has no death at or before `gen`. Binary search over that cell's slice,
   * so O(log k) with k = number of deaths for this cell (typically tiny).
   * Allocation-free.
   */
  lastDeathAtOrBefore(i, gen) {
    const gens = this.gens;
    let lo = this.offsets[i];
    let hi = this.offsets[i + 1] - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (gens[mid] <= gen) {
        found = gens[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }
}

/**
 * Precompute the death history of every cell.
 *
 * Two forward passes over the frames (count, then fill) build a CSR index of
 * every 1 → 0 transition. One-time O(nFrames × cellCount) cost at load; the
 * per-frame path then never rescans frames.
 *
 * @param {Object} frames - decoded frame data { cellCount, nFrames, frames }
 * @returns {DeathIndex} pass this as opts.deathGen to cellAlpha()
 */
export function precomputeDeaths(frames) {
  const { cellCount, nFrames, frames: frameList } = frames;

  // Pass 1: count deaths per cell, so the CSR arrays can be sized exactly.
  const counts = new Int32Array(cellCount);
  for (let gen = 1; gen < nFrames; gen++) {
    const prevFrame = frameList[gen - 1];
    const currFrame = frameList[gen];
    for (let i = 0; i < cellCount; i++) {
      if (prevFrame[i] === 1 && currFrame[i] === 0) counts[i]++;
    }
  }

  // Prefix-sum the counts into offsets.
  const offsets = new Int32Array(cellCount + 1);
  let total = 0;
  for (let i = 0; i < cellCount; i++) {
    offsets[i] = total;
    total += counts[i];
  }
  offsets[cellCount] = total;

  // Pass 2: fill. Scanning generations in ascending order means each cell's
  // slice comes out sorted ascending for free — the binary search relies on it.
  const gens = new Int32Array(total);
  const cursor = new Int32Array(cellCount);
  cursor.set(offsets.subarray(0, cellCount));
  for (let gen = 1; gen < nFrames; gen++) {
    const prevFrame = frameList[gen - 1];
    const currFrame = frameList[gen];
    for (let i = 0; i < cellCount; i++) {
      if (prevFrame[i] === 1 && currFrame[i] === 0) {
        gens[cursor[i]++] = gen;
      }
    }
  }

  return new DeathIndex(cellCount, offsets, gens);
}

/**
 * Per-cell, per-generation "last-seen live mode" — the afterglow colour index.
 *
 * WHY THIS EXISTS: the wire format (`worldripples/lifepack.py` `pack_modes`)
 * stores 2 mode bits per LIVE cell only, in that frame's popcount order. A
 * dead cell's mode bits are never on the wire — `unpack_modes` / `decodeLife`
 * prefill NO_MODE (255) for every dead index because there is nothing else
 * they could do. So `life.modes[gen][i]` for a currently-dead cell is ALWAYS
 * 255, regardless of what the Python bake's internal `modes` array held
 * before `modes[~state] = NO_MODE` zeroed it at death — that assignment
 * happens after `pack_modes` has already dropped dead-cell modes, so it does
 * not change a single byte written to disk. Changing the bake cannot fix the
 * afterglow colour; only the renderer, which sees every frame in order, can
 * remember what a cell looked like the last time it was actually alive.
 *
 * This is a forward pass exactly like `precomputeDeaths`: for each cell, walk
 * generations ascending, and whenever the cell is alive record its mode as
 * the "last live mode so far". A cell that has never been alive at or before
 * a given generation reports NO_MODE — it must not borrow slot 0 (metro) by
 * virtue of a zero-initialized array.
 *
 * Layout mirrors DeathIndex's memory shape: one Uint8Array per generation,
 * cellCount bytes each. This trades a bit more memory (1 byte x cellCount x
 * nFrames, same order as the decoded mode frames themselves) for O(1)
 * lookups with no per-frame scanning, which is the same allocation-light
 * contract cellAlpha's deathGen requires.
 */
export function precomputeLastMode(frames) {
  const { cellCount, nFrames, frames: frameList, modes: modeList } = frames;
  if (!modeList) {
    throw new Error("precomputeLastMode: frames.modes is required (decodeLife output)");
  }

  const lastMode = new Array(nFrames);
  let running = new Uint8Array(cellCount).fill(255); // NO_MODE
  for (let gen = 0; gen < nFrames; gen++) {
    const state = frameList[gen];
    const modeFrame = modeList[gen];
    // Copy-on-write per generation so each slot is independently queryable
    // (a later generation's update must not retroactively change an earlier
    // generation's already-returned array).
    const next = running.slice();
    for (let i = 0; i < cellCount; i++) {
      if (state[i] === 1) next[i] = modeFrame[i];
    }
    lastMode[gen] = next;
    running = next;
  }
  return lastMode;
}

// Afterglow horizon: ~0.5 seconds of wall-clock time.
//
// This is a VISIBILITY horizon, not the exponential time constant. By
// AFTERGLOW_HORIZON_SEC after death a cell must be below the renderer's
// display floor — actually gone, not merely dimmer.
//
// The distinction is the whole bug this constant used to carry. Using 0.5 as
// the time constant directly leaves alpha at exp(-1) = 0.368 after 0.5 s, and
// the renderer's floor is LIFE_ALPHA_EPS = (1/255)/LIFE_STAMP_GAIN = 0.00697.
// Decaying from 1 to that floor takes ln(1/EPS) = 4.97 time constants, so the
// "0.5 s horizon" actually kept cells lit for 2.48 s — five times the spec,
// and ~15 generations at the default 6 gen/s. That is what made generation 1
// render identically to the generation-0 seed (measured IoU 0.986): all
// 64,755 cells that died in the collapse were still drawn at full alpha.
//
// Dividing by ln(1/EPS) makes the horizon mean what it says. At 6 gen/s a
// death now trails ~3 generations, matching app.js's LIFE_GENS_PER_SEC note.
//
// EPS is duplicated from app.js rather than imported to keep this module free
// of render dependencies (it is a pure view model, unit-tested standalone);
// web/tests/lifeview.test.mjs pins both sides to the same value.
const AFTERGLOW_HORIZON_SEC = 0.5;
const RENDER_ALPHA_EPS = (1 / 255) / 0.5625;
const AFTERGLOW_TAU_SEC = AFTERGLOW_HORIZON_SEC / Math.log(1 / RENDER_ALPHA_EPS);

/**
 * cellAlpha(frames, gen, frac, opts) -> Float32Array (borrowed, valid until next call)
 *
 * Compute per-cell alpha for the current playback state.
 * IMPORTANT: Returned array is borrowed and reused. Caller must not hold a reference across calls.
 *
 * @param {Object} frames - decoded frame data { cellCount, nFrames, frames }
 * @param {number} gen - generation index (0 <= gen < nFrames)
 * @param {number} frac - sub-generation fraction (0 <= frac <= 1)
 * @param {Object} opts - options { speed, playbackRate, deathGen }
 *   - speed: playback speed multiplier (1 = 1x, 60 = 60x); must be > 0
 *   - playbackRate: generations per second in the bake (e.g. 10); must be > 0
 *   - deathGen: REQUIRED. DeathIndex from precomputeDeaths(). Omitting it throws.
 * @returns {Float32Array} per-cell alpha, length = cellCount (borrowed, reused on next call)
 */
export function cellAlpha(frames, gen, frac, opts) {
  const { cellCount, nFrames, frames: frameList } = frames;
  let { speed, playbackRate, deathGen } = opts;

  // Guard against invalid inputs that would cause NaN.
  if (speed <= 0) speed = 1; // Default to 1x if invalid
  if (playbackRate <= 0) playbackRate = 1; // Default to 1 gen/sec if invalid

  // Reuse scratch buffer across calls (but reset on cell count change).
  if (scratchBuffer === null || lastFrameSetCellCount !== cellCount) {
    scratchBuffer = new Float32Array(cellCount);
    lastFrameSetCellCount = cellCount;
  }
  const alphas = scratchBuffer;

  // deathGen is REQUIRED. Caller must precompute via precomputeDeaths() for O(cellCount) per-frame cost.
  // Omitting it silently reintroduces O(nFrames × cellCount) per-frame cost (Finding 1 regression).
  if (!deathGen) {
    throw new Error(
      "cellAlpha: opts.deathGen is required. Call precomputeDeaths(frames) once and pass the result. " +
      "Omitting it silently reintroduces per-frame allocation and O(nFrames) scan overhead."
    );
  }

  // Clamp gen to valid range.
  const clampedGen = Math.max(0, Math.min(nFrames - 1, gen));
  const currentFrame = frameList[clampedGen];

  // Compute alpha for each cell from its death history.
  for (let i = 0; i < cellCount; i++) {
    if (currentFrame[i] === 1) {
      // Cell is alive in the current frame -> full alpha.
      alphas[i] = 1.0;
      continue;
    }

    // Dead at the queried generation. Fade from the MOST RECENT death AT OR
    // BEFORE this generation — not the cell's globally-latest death. That
    // distinction is what makes a backward scrub into an earlier death window
    // show the afterglow instead of 0, while a death that has not happened yet
    // at this generation still contributes nothing.
    const diedAtGen = deathGen.lastDeathAtOrBefore(i, clampedGen);

    if (diedAtGen >= 0) {
      // Wall-clock time since death.
      // Death occurred at: diedAtGen (beginning of that generation).
      // Current time is: clampedGen + frac (in generations).
      // Time difference in generations: (clampedGen + frac) - diedAtGen.
      // Convert to simulation seconds: difference / playbackRate.
      // Convert to wall-clock seconds: sim-seconds / speed (following field.js idiom).
      const timeSinceDeathGen = (clampedGen + frac) - diedAtGen;
      const timeSinceDeathSimSec = timeSinceDeathGen / playbackRate;
      const timeSinceDeathWallSec = timeSinceDeathSimSec / speed;

      // Apply exponential decay: alpha = exp(-timeSinceDeath / tau), where tau
      // is sized so alpha crosses the display floor exactly at
      // AFTERGLOW_HORIZON_SEC. Past the horizon the cell is invisible.
      // Guard with isFinite() in case timeSinceDeathWallSec is NaN (shouldn't happen post-guarding).
      let alpha = Math.exp(-timeSinceDeathWallSec / AFTERGLOW_TAU_SEC);
      if (!isFinite(alpha)) alpha = 0; // Safety: NaN or Infinity -> 0
      alphas[i] = Math.max(0, Math.min(1, alpha)); // Clamp to [0, 1].
    } else {
      // No death at or before this generation: the cell has either never lived,
      // or every death it will ever have is still in the future. Either way it
      // must not glow.
      alphas[i] = 0.0;
    }
  }

  // Return borrowed buffer (valid until next cellAlpha call).
  // No copy: caller receives immediately per frame and uploads to GPU; no cross-call retention.
  return alphas;
}
