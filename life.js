// life.js — decode the baked Life stream. The browser NEVER runs a generation;
// the CA ran in the bake and this only replays it.
//
// Format is produced by worldripples/lifepack.py and must agree byte-for-byte;
// web/tests/life.test.mjs asserts that against a Python-generated fixture.
const MAGIC = 0x464c5257; // "WRLF" read as little-endian u32
const HEADER_BYTES = 16;

export function decodeLife(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error("life: bad magic");
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`life: unsupported version ${version}`);
  const cellCount = dv.getUint32(8, true);
  const nFrames = dv.getUint32(12, true);

  const bytes = new Uint8Array(arrayBuffer);
  const stride = (cellCount + 7) >> 3;
  const expectedLen = HEADER_BYTES + nFrames * stride;
  if (bytes.length !== expectedLen) {
    throw new Error(`life: truncated buffer: expected ${expectedLen} bytes, got ${bytes.length}`);
  }
  let pos = HEADER_BYTES;

  const frames = [];
  for (let f = 0; f < nFrames; f++) {
    const state = new Uint8Array(cellCount);
    for (let i = 0; i < cellCount; i++) {
      state[i] = (bytes[pos + (i >> 3)] >> (i & 7)) & 1;
    }
    pos += stride;
    frames.push(state);
  }
  return { cellCount, nFrames, frames };
}

// Fetch is RELATIVE (Pages-safe) and the filename is percent-encoded, matching
// data.js: subarea names are non-ASCII for some cities (life_Zürich.bin).
export async function loadLife(dir, city) {
  const r = await fetch(`${dir}/${encodeURIComponent(`life_${city}`)}.bin`);
  if (!r.ok) throw new Error(`Failed to fetch life_${city}.bin: ${r.status} ${r.statusText}`);
  return decodeLife(await r.arrayBuffer());
}
