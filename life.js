// life.js — decode the baked Life stream. The browser NEVER runs a generation;
// the CA ran in the bake and this only replays it.
//
// Format is produced by worldripples/lifepack.py and must agree byte-for-byte;
// web/tests/life.test.mjs asserts that against a Python-generated fixture.
const MAGIC = 0x464c5257; // "WRLF" read as little-endian u32
const TAG_KEYFRAME = 0;
const HEADER_BYTES = 20;

export function decodeLife(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error("life: bad magic");
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error(`life: unsupported version ${version}`);
  const cellCount = dv.getUint32(8, true);
  const nFrames = dv.getUint32(12, true);
  const keyframeInterval = dv.getUint32(16, true);

  const bytes = new Uint8Array(arrayBuffer);
  const stride = (cellCount + 7) >> 3;
  let pos = HEADER_BYTES;

  const frames = [];
  let state = new Uint8Array(cellCount);
  for (let f = 0; f < nFrames; f++) {
    const tag = bytes[pos]; pos += 1;
    if (tag === TAG_KEYFRAME) {
      state = new Uint8Array(cellCount);
      for (let i = 0; i < cellCount; i++) {
        state[i] = (bytes[pos + (i >> 3)] >> (i & 7)) & 1;
      }
      pos += stride;
    } else {
      const nBorn = dv.getUint32(pos, true);
      const nDied = dv.getUint32(pos + 4, true);
      pos += 8;
      state = state.slice();
      for (let i = 0; i < nBorn; i++) state[dv.getUint32(pos + 4 * i, true)] = 1;
      pos += 4 * nBorn;
      for (let i = 0; i < nDied; i++) state[dv.getUint32(pos + 4 * i, true)] = 0;
      pos += 4 * nDied;
    }
    frames.push(state);
  }
  return { cellCount, nFrames, keyframeInterval, frames };
}

// Fetch is RELATIVE (Pages-safe) and the filename is percent-encoded, matching
// data.js: subarea names are non-ASCII for some cities (life_Zürich.bin).
export async function loadLife(dir, city) {
  const r = await fetch(`${dir}/${encodeURIComponent(`life_${city}`)}.bin`);
  if (!r.ok) throw new Error(`Failed to fetch life_${city}.bin: ${r.status} ${r.statusText}`);
  return decodeLife(await r.arrayBuffer());
}
