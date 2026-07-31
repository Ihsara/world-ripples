// life.js — decode the baked Life stream. The browser NEVER runs a generation;
// the CA ran in the bake and this only replays it.
//
// Format is produced by worldripples/lifepack.py and must agree byte-for-byte;
// web/tests/life.test.mjs asserts that against a Python-generated fixture.
const MAGIC = 0x464c5257; // "WRLF" read as little-endian u32
const HEADER_BYTES = 16;

// v3 layout per frame: the alive bitset, ceil(cellCount/8) bytes, then a
// SPARSE mode section -- 2 bits per LIVE cell in ascending cell order,
// ceil(2*popcount/8) bytes, LSB-first in both sections. Frames are therefore
// VARIABLE-LENGTH (the mode section's size depends on that frame's
// population), so this walks sequentially rather than seeking by a fixed
// stride, and validates incrementally: it throws the moment a read would run
// past the buffer, rather than checking one total expected length up front
// (that check does not exist in v3 -- there is no fixed stride to multiply).
export function decodeLife(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error("life: bad magic");
  const version = dv.getUint32(4, true);
  if (version !== 3) throw new Error(`life: unsupported version ${version}`);
  const cellCount = dv.getUint32(8, true);
  const nFrames = dv.getUint32(12, true);

  const bytes = new Uint8Array(arrayBuffer);
  const bufLen = bytes.length;
  const stride = (cellCount + 7) >> 3;
  let pos = HEADER_BYTES;

  const frames = [];
  const modes = [];
  for (let f = 0; f < nFrames; f++) {
    if (pos + stride > bufLen) {
      throw new Error(`life: truncated buffer: expected ${pos + stride} bytes for bitset, got ${bufLen}`);
    }
    const state = new Uint8Array(cellCount);
    // liveCells[k] = index of the k-th live cell, in ascending order -- the
    // k-th mode entry belongs to it (the alive bitset is self-describing).
    const liveCells = [];
    for (let i = 0; i < cellCount; i++) {
      const bit = (bytes[pos + (i >> 3)] >> (i & 7)) & 1;
      state[i] = bit;
      if (bit) liveCells.push(i);
    }
    pos += stride;

    const modeSize = ((liveCells.length * 2 + 7) >> 3);
    if (pos + modeSize > bufLen) {
      throw new Error(`life: truncated buffer: expected ${pos + modeSize} bytes for mode section, got ${bufLen}`);
    }
    const mode = new Uint8Array(cellCount).fill(255);
    for (let k = 0; k < liveCells.length; k++) {
      // 2-bit entries pack 4 per byte and never straddle a byte boundary
      // (the bit offset k*2 is always even, so a 2-bit read never crosses).
      const bitOffset = k * 2;
      const byteIdx = pos + (bitOffset >> 3);
      const shift = bitOffset & 7;
      mode[liveCells[k]] = (bytes[byteIdx] >> shift) & 0b11;
    }
    pos += modeSize;

    frames.push(state);
    modes.push(mode);
  }
  return { cellCount, nFrames, frames, modes };
}

// Fetch is RELATIVE (Pages-safe) and the filename is percent-encoded, matching
// data.js: subarea names are non-ASCII for some cities (life_Zürich.bin).
export async function loadLife(dir, city) {
  const r = await fetch(`${dir}/${encodeURIComponent(`life_${city}`)}.bin`);
  if (!r.ok) throw new Error(`Failed to fetch life_${city}.bin: ${r.status} ${r.statusText}`);
  return decodeLife(await r.arrayBuffer());
}
