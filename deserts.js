// Transit deserts: the streets no scheduled service reaches.
//
// The claim this layer makes is deliberately WEAK. A desert cell is further
// than the bake's horizon (300s) from every stop, so it means "more than a
// 5-minute walk from any service" -- NOT "unreachable". desertLabel() derives
// that wording from the baked horizon so the copy can never drift from the
// data.
//
// Cities whose feed is too thin to support the claim at all (Tokyo: 149 stops
// for 705k edges, rail-only pending an ODPT key) are marked coverage_ok:false
// at bake time and are refused here rather than being drawn with a caveat.

export function unpackDesertBits(buf, nCells) {
  const bytes = new Uint8Array(buf);
  const out = new Uint8Array(nCells);
  for (let i = 0; i < nCells; i += 1) {
    out[i] = (bytes[i >> 3] >> (i & 7)) & 1;   // LSB-first: matches np.packbits
  }
  return out;
}

export function desertAvailable(desertsJson, subareaNames) {
  if (!desertsJson || !desertsJson.subareas) return false;
  return subareaNames.some((n) => desertsJson.subareas[n]?.coverage_ok === true);
}

export function desertLabel(horizonSec) {
  const mins = Math.round(Number(horizonSec) / 60);
  return `Streets more than a ${mins}-minute walk from any stop`;
}

export function rankSubareas(desertsJson) {
  const subs = desertsJson?.subareas ?? {};
  return Object.entries(subs)
    .filter(([, e]) => e.coverage_ok === true)
    .map(([name, e]) => ({
      name, fraction: e.fraction, cells: e.cells, desert: e.desert,
    }))
    .sort((a, b) => b.fraction - a.fraction);
}

// Absence, not alarm. One flat pass over the seg buffer: every 4 floats is
// one cell (x1,y1,x2,y2), the same order the bitmap indexes, so cell i's bit
// is bits[i] and its coords start at 4*i. Reached cells are NOT drawn -- the
// negative space is the whole image.
export function drawDeserts(ctx, segs, bits, project, style) {
  const { colour = "#8a8578", alpha = 0.55, width = 0.8 } = style ?? {};
  ctx.strokeStyle = colour;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.beginPath();
  let drew = false;
  for (let i = 0; i < bits.length; i += 1) {
    if (!bits[i]) continue;
    const o = i * 4;
    const [x1, y1] = project(segs[o], segs[o + 1]);
    const [x2, y2] = project(segs[o + 2], segs[o + 3]);
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    drew = true;
  }
  if (drew) ctx.stroke();
  ctx.globalAlpha = 1;
}
