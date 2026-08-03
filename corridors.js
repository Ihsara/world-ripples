// corridors.js — pure corridor preparation helpers.

export function deriveCorridorWeights(manifest, stopMode, stampIndex, stampIntensity) {
  const modeCodes = manifest.mode_codes || {};
  const capacity = manifest.capacity || {};
  if (capacity.mode_weights) return { ...capacity.mode_weights };
  const peaks = new Float64Array(Object.keys(modeCodes).length);
  for (let stop = 0; stop < stopMode.length; stop++) {
    const mode = stopMode[stop], off = stampIndex[2 * stop], count = stampIndex[2 * stop + 1];
    for (let k = off; k < off + count; k++) peaks[mode] = Math.max(peaks[mode], stampIntensity[k]);
  }
  const refCode = modeCodes[capacity.reference_mode || "bus"];
  const refPeak = peaks[refCode] || 1;
  return Object.fromEntries(Object.entries(modeCodes).map(([mode, code]) =>
    [mode, peaks[code] ? peaks[code] / refPeak : 1]));
}

export function buildCorridorGeometry(routes, shapeCoords, weights) {
  if (!Array.isArray(routes) || !shapeCoords) return { vertices: new Float32Array(), batches: [] };
  const byMode = new Map();
  for (const route of routes) {
    if (!route || !Number.isInteger(route.v0) || !Number.isInteger(route.vcount) || route.vcount < 2) continue;
    if (route.v0 < 0 || 2 * (route.v0 + route.vcount) > shapeCoords.length) continue;
    if (!byMode.has(route.mode)) byMode.set(route.mode, []);
    byMode.get(route.mode).push(route);
  }
  const data = [], batches = [];
  for (const [mode, modeRoutes] of byMode) {
    const first = data.length / 4;
    for (const route of modeRoutes) {
      for (let i = route.v0; i < route.v0 + route.vcount - 1; i++) {
        const ax = shapeCoords[2*i], ay = shapeCoords[2*i+1], bx = shapeCoords[2*i+2], by = shapeCoords[2*i+3];
        if (![ax, ay, bx, by].every(Number.isFinite) || (ax === bx && ay === by)) continue;
        data.push(ax, ay, bx, by);
      }
    }
    const count = data.length / 4 - first;
    if (count) batches.push({ mode, first, count, weight: weights[mode] || 1 });
  }
  return { vertices: Float32Array.from(data), batches };
}

export function corridorWidth(weight) {
  return 0.9 + Math.log2(Math.max(1, weight));
}

export function corridorBrightness(weight) {
  return 0.025 + 0.025 * Math.log2(Math.max(1, weight));
}

// --- colour modes ---------------------------------------------------------
//
// WHY THIS EXISTS. Ripple stamps blend ADDITIVELY (gl.blendFunc(ONE, ONE)), and
// hue encodes mode identity. Measured on the shipped Helsinki bundle: 83,946
// street edges are lit, each claimed by 3.68 stops on average (max 47), and
// 27.0% of lit edges receive ripples from MORE THAN ONE mode. Where they meet,
// the hues SUM into colours that are not in the palette and encode nothing:
// bus+tram (18,225 edges) sums to a saturated cyan; bus+metro+tram (1,172)
// goes near-white. A reader sees a colour that names no mode.
//
// Two coherent resolutions, selectable at runtime so they can be compared:
//   "identity" — hue = mode, value = intensity. One mode WINS a shared edge.
//   "overlap"  — hue = how many distinct modes serve the edge; mixing IS the
//                story ("served by bus AND tram" is a real fact about a place).
// "additive" keeps the original behaviour so the defect stays reproducible.
export const COLOUR_MODES = ["additive", "identity", "overlap"];

// Rank for "which mode wins a shared edge" under identity mode. This is NOT a
// new rule: worldripples/lifeseed.py's MODE_SLOT already establishes that
// ascending slot order (metro < train < tram < bus) is exactly DESCENDING
// per-vehicle capacity (800 > 500 > 200 > 80). Lowest rank wins = highest
// capacity wins; the two readings are the same rule. Ferry (capacity 150) sits
// between tram and bus, matching its weight rather than its shared colour slot.
export const MODE_RANK = { metro: 0, train: 1, tram: 2, ferry: 3, bus: 4 };

export function winningMode(modes) {
  let best = null, bestRank = Infinity;
  for (const m of modes) {
    const r = MODE_RANK[m] ?? Infinity;
    if (r < bestRank) { bestRank = r; best = m; }
  }
  return best;
}

// Sequential ramp for "how many DISTINCT modes serve this edge".
// Measured distribution: 1 mode 73.0%, 2 modes 24.8%, 3 modes 2.0%, 4 modes 0.2%.
// 97.8% of edges are 1-or-2, so the ramp must separate 1 from 2 DECISIVELY and
// must not spend its range on the rare 3-4 tail. Hues run cool -> warm with
// rising value, which keeps the ordering readable on the dark canvas without
// colliding with any MODE_COLORS hue.
export const OVERLAP_RAMP = [
  [0.22, 0.30, 0.48], // 1 mode  — deep recessive slate; 73% of edges, must sit back
  [0.15, 0.90, 0.80], // 2 modes — bright teal, the decisive step (24.8% of edges)
  [1.00, 0.75, 0.25], // 3 modes — amber
  [1.00, 0.35, 0.45], // 4+ modes — red, the rare tail
];

export function overlapColour(modeCount) {
  const i = Math.max(1, Math.min(OVERLAP_RAMP.length, modeCount | 0)) - 1;
  return OVERLAP_RAMP[i];
}

// Count DISTINCT modes per street edge. Returns a Uint8Array indexed by edge id,
// so the renderer can look up an edge's overlap class in O(1) per stamp.
export function edgeModeCounts(stopMode, stampIndex, stampEdge, modeNames) {
  let maxEdge = 0;
  for (let i = 0; i < stampEdge.length; i++) if (stampEdge[i] > maxEdge) maxEdge = stampEdge[i];
  // One bit per mode per edge, then popcount. Cheaper and far smaller than a
  // Set per edge (83,946 edges x a Set would dwarf the data it describes).
  const bits = new Uint8Array(maxEdge + 1);
  const stops = stampIndex.length / 2;
  for (let stop = 0; stop < stops; stop++) {
    const mode = stopMode[stop], off = stampIndex[2 * stop], count = stampIndex[2 * stop + 1];
    if (mode >= modeNames.length) continue;
    const bit = 1 << mode;
    for (let k = off; k < off + count; k++) bits[stampEdge[k]] |= bit;
  }
  const counts = new Uint8Array(maxEdge + 1);
  for (let e = 0; e < bits.length; e++) {
    let v = bits[e], n = 0;
    while (v) { n += v & 1; v >>= 1; }
    counts[e] = n;
  }
  return counts;
}
