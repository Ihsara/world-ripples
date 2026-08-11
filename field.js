// field.js — pure playback helpers (Task 6) + WebGL field (Task 7).
import { DEFAULT_RGB } from "./sunlight.js?v=4564b7c5c6";
export function makeProjection(bbox, w, h, margin) {
  const m = margin || 10;
  const latMid = (bbox.minY + bbox.maxY) / 2;
  const kx = Math.cos((latMid * Math.PI) / 180);
  const dataW = (bbox.maxX - bbox.minX) * kx, dataH = bbox.maxY - bbox.minY;
  const aW = w - 2 * m, aH = h - 2 * m;
  const s = Math.min(aW / dataW, aH / dataH);
  const offX = m + (aW - dataW * s) / 2, offY = m + (aH - dataH * s) / 2;
  return { s, kx, fn: (x, y) => [offX + (x - bbox.minX) * kx * s, offY + (bbox.maxY - y) * s] };
}
export function decayFactor(halfLifeSec, dtSimSec) {
  return Math.pow(0.5, dtSimSec / halfLifeSec);
}
export function stampContribution(delay, intensity, ageSec) {
  return ageSec >= delay ? intensity : 0;
}
export function eventsInWindow(eventTime, ptr, tNow) {
  let hi = ptr;
  while (hi < eventTime.length && eventTime[hi] <= tNow) hi++;
  return { events: [ptr, hi], nextPtr: hi };
}
// realAge — the v2.1 "watchable at every speed" conversion. Ripple animation
// runs on REAL seconds: an event's sim-age is divided by playback speed at
// use time, so a droplet's visual life is ~7s at 1x, 60x and 300x alike.
// (v2.0 fed sim-age straight to the band shader, so at 60x a whole ripple
// lived 3 real-seconds — the "blinking lights" bug.) Sim-time still drives
// WHEN events fire; only the animation clock is real-time. Pause/scrub
// correctness is inherited from sim-time (it freezes/resyncs already).
export function realAge(simAge, speed) {
  return simAge / speed;
}
// clampSkip — the ±15min transport skip idiom: apply a delta-sec jump to t,
// clamped to the data window (same clamp shape the scrubber's frac already
// enforces via min(1,max(0,...)), just in raw sim-seconds here).
export function clampSkip(t, deltaSec, dataMin, dataMax) {
  return Math.min(dataMax, Math.max(dataMin, t + deltaSec));
}
// inBbox — inclusive lon/lat containment test against a [w,s,e,n] bbox array
// (the districts.json shape). Used both for event-admission filtering (Task 6)
// and could double for dot culls; boundary-inclusive by design (bbox tests
// admit edge spill-over — see Task 6 brief).
export function inBbox(x, y, bbox) {
  return x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3];
}
// rippleLifeHorizon — v2.2 1x liveliness (spec §4): at real-time speed a
// droplet the viewer waited for should linger long enough to savor (14s);
// every other speed keeps the tuned 8s ceiling.
export function rippleLifeHorizon(speed) {
  return speed === 1 ? 14.0 : 8.0;
}
// nextEventInView — the "next ripple · Ns" whisper's lookup: scan forward
// from the event cursor for the first event whose stop lies in the viewport
// bbox. Bounded (maxScan) so a viewport with no service can't scan the whole
// stream every status tick.
export function nextEventInView(eventTime, eventStop, stops, fromPtr, bbox, maxScan = 5000) {
  const end = Math.min(eventTime.length, fromPtr + maxScan);
  for (let i = fromPtr; i < end; i++) {
    const stop = eventStop[i];
    if (inBbox(stops[2 * stop], stops[2 * stop + 1], bbox)) {
      return { simSec: eventTime[i], stop };
    }
  }
  return null;
}
export function whisperText(dsec) {
  if (dsec <= 1) return "ripple…";
  if (dsec <= 120) return `next ripple · ${dsec}s`;
  return "";
}
// normalizeStampIntensity — inverts BOTH steps of bake_ripples.py's
// stamp_intensity quantization (projects/helsinki-ripples/src/bake_ripples.py,
// a DIFFERENT project from this shader):
//   w = weight_for(mode, override) / maxModeWeight        # bake_ripples.py:213
//   stamp_intensity = round(clamp(inten * w * 65535, 0, 65535))  # :217 (_quant_u16)
// Step 1 (`_quant_u16`) scaled a 0..1 float up by 65535 before storing as a
// uint16 -- undo with `/ 65535`. Step 2 (`weight_for(mode) / maxModeWeight`)
// renormalized the capacity weight DOWN by the heaviest mode's weight so
// nothing clipped at bake time -- undo by multiplying back UP by that same
// maxModeWeight. Skipping step 2 (dividing by 65535 alone) leaves every
// vertex at `weight_for(mode)/maxModeWeight` instead of `weight_for(mode)` --
// the whole scene dims by maxModeWeight, because even the reference mode
// (weight 1.0) is left at `1/maxModeWeight` instead of 1.0. This was Task 3's
// original bug (review round 1): ratios were right, absolute scale was not.
// `maxModeWeight` must come from the bake's manifest (`manifest.capacity.
// max_mode_weight`), never a hardcoded literal -- a per-city capacity
// override can change the effective divisor the bake actually used.
export function normalizeStampIntensity(rawU16, maxModeWeight) {
  return (rawU16 / 65535) * maxModeWeight;
}
// bandBrightness mirrors ripplesim.ripple.edge_brightness (the Python reference):
// a moving BAND — bright crest at the wavefront (front = age*frontSpeed) + a faint
// trailing wake — NOT a filled disc. This is the fix for the "whole street brightens"
// wash. The fragment shader below computes the identical formula per fragment.
export function bandBrightness(T, age, p) {
  if (age <= 0) return 0;
  const front = age * p.frontSpeed;
  if (T > front) return 0;
  let crest = 1 - Math.abs(T - front) / p.thickness;
  if (crest < 0) crest = 0;
  const wake = Math.exp(-(front - T) / p.wakeTau);
  return (crest + p.wakeLevel * wake) * Math.exp(-age / p.lifeTau);
}

// --- WebGL2 decay-accumulate field (Task 7) ------------------------------
const QUAD_VS = `#version 300 es
in vec2 p; out vec2 uv; void main(){ uv=(p+1.0)*0.5; gl_Position=vec4(p,0.,1.); }`;
const DECAY_FS = `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D tex; uniform float k;
out vec4 o; void main(){ o = texture(tex, uv) * k; }`;
// GLOW_STRENGTH tunes the present shader's soft-tonemap rolloff: how quickly
// accumulated intensity saturates. Higher = brighter hubs, but still capped
// below 1.0 (exponential tonemap), so overlapping ripples never clip to a
// blown-out white blob — they read as a brighter, more saturated mode color.
// Tune here (single source of truth for the present shader).
const GLOW_STRENGTH = 2.2;
const PRESENT_FS = `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D tex; uniform float glowStrength;
uniform vec3 uBase;
out vec4 o;
void main(){
  vec4 s = texture(tex, uv);
  vec3 base = uBase;
  // log1p compression on the ACCUMULATED sum (Task 3 fix round 1, the
  // review's ruling): restoring stampIntensity's reference mode (bus) to
  // its true weight of 1.0 (see normalizeStampIntensity in this file, and
  // pushEdge's comment in app.js) necessarily lets metro reach 10x that,
  // which pushes the accumulated per-pixel sum at a hub well past what the
  // existing exponential tonemap alone was tuned for. GLSL has no built-in
  // log1p, so log(1.0+x) is the direct equivalent -- defined and finite for
  // every x>=0 (additive accumulation is never negative), and, crucially,
  // log1p(0)=0 so an unlit pixel is untouched. This compresses the wide
  // dynamic range BEFORE the existing 1-exp(-x*k) tonemap runs, rather than
  // replacing it: log1p tames how fast large sums grow, exp still supplies
  // the "asymptotes to 1.0, never clips to white" ceiling. Composing the two
  // (log1p then exp-tonemap) is the plan's explicit split -- "linear where
  // capacity is a real physical ratio [the per-vertex inten multiply],
  // log1p where saturation is the real risk [here, at the accumulated sum]"
  // -- not a replacement for either existing mechanism.
  vec3 compressed = log(1.0 + s.rgb);
  vec3 glow = 1.0 - exp(-compressed * glowStrength);
  o = vec4(base + glow, 1.0);
}`;
// stamp: draw colored line segments, additive; intensity in a per-vertex attr.
// STAMP_BRIGHTNESS boosts the per-stamp intensity so thin (~1px) WebGL lines
// still read as a legible glow once accumulated and tonemapped, without
// resorting to a multi-tap blur (kept cheap for the Task-12 perf gate).
const STAMP_BRIGHTNESS = 1.6;
const STAMP_VS = `#version 300 es
in vec2 p; in float delay; in float age; in float inten; uniform vec2 res;
out float vDelay; out float vAge; out float vInten;
void main(){ vDelay=delay; vAge=age; vInten=inten;
  vec2 c=(p/res)*2.0-1.0; gl_Position=vec4(c.x,-c.y,0.,1.); }`;
const STAMP_FS = `#version 300 es
precision highp float;
in float vDelay; in float vAge; in float vInten;
uniform vec3 color; uniform float brightness;
uniform float frontSpeed, thickness, wakeTau, wakeLevel, lifeTau;
out vec4 o;
void main(){
  float T = vDelay; float age = vAge;
  float front = age * frontSpeed;
  float b = 0.0;
  if (age > 0.0 && T <= front) {
    float crest = max(1.0 - abs(T - front) / thickness, 0.0);
    float wake = exp(-(front - T) / wakeTau);
    b = (crest + wakeLevel * wake) * exp(-age / lifeTau);
  }
  b *= brightness;
  b *= vInten;
  o = vec4(color * b, b);   // additive; overlapping ripples ADD
}`;

const POINT_VS = `#version 300 es
in vec2 p; in vec4 col; uniform vec2 res; uniform float size;
out vec4 vCol;
void main(){ vCol=col; vec2 c=(p/res)*2.0-1.0; gl_Position=vec4(c.x,-c.y,0.,1.); gl_PointSize=size; }`;
const POINT_FS = `#version 300 es
precision highp float; in vec4 vCol; out vec4 o;
void main(){ vec2 d = gl_PointCoord - vec2(0.5); float r = length(d);
  float a = smoothstep(0.5, 0.0, r); o = vec4(vCol.rgb * a * vCol.a, a * vCol.a); }`;

const CORRIDOR_VS = `#version 300 es
in vec2 a; in vec2 b;
uniform vec2 projScale, projOffset, res; uniform float width;
void main(){
  const vec2 corners[6] = vec2[6](
    vec2(0.0,-1.0), vec2(0.0,1.0), vec2(1.0,-1.0),
    vec2(1.0,-1.0), vec2(0.0,1.0), vec2(1.0,1.0));
  vec2 corner=corners[gl_VertexID];
  vec2 pa=a*projScale+projOffset, pb=b*projScale+projOffset;
  vec2 d=pb-pa; float len=max(length(d),0.0001);
  vec2 normal=vec2(-d.y,d.x)/len;
  vec2 p=mix(pa,pb,corner.x)+normal*corner.y*width*0.5;
  vec2 c=(p/res)*2.0-1.0; gl_Position=vec4(c.x,-c.y,0.0,1.0);
}`;
const CORRIDOR_FS = `#version 300 es
precision highp float; uniform vec3 color; uniform float brightness; out vec4 o;
void main(){ o=vec4(color*brightness,brightness); }`;

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [t, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

export class RippleField {
  constructor(gl, { width, height }) {
    this.gl = gl; this.w = width; this.h = height;
    const ext = gl.getExtension("EXT_color_buffer_float");
    if (!ext) throw new Error("RippleField: EXT_color_buffer_float unavailable (no RGBA16F render target)");
    this.decayP = compile(gl, QUAD_VS, DECAY_FS);
    this.presentP = compile(gl, QUAD_VS, PRESENT_FS);
    this.stampP = compile(gl, STAMP_VS, STAMP_FS);
    this.pointP = compile(gl, POINT_VS, POINT_FS);
    this.corridorP = compile(gl, CORRIDOR_VS, CORRIDOR_FS);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    this._alloc(width, height);
    this.segBuf = gl.createBuffer(); this.intBuf = gl.createBuffer();
    this.delayBuf = gl.createBuffer(); this.ageBuf = gl.createBuffer();
    this.intenBuf = gl.createBuffer();
    this.ptBuf = gl.createBuffer(); this.ptColBuf = gl.createBuffer();
    this.corridorBuf = gl.createBuffer(); this.corridorBatches = [];
    this._segCap = 0; this._delayCap = 0; this._ageCap = 0; this._intenCap = 0;

    // Task 12 perf gate: cache all uniform/attribute locations ONCE per
    // program right after linking, instead of calling getUniformLocation /
    // getAttribLocation every frame inside decay()/stamp()/present()/
    // _drawQuad(). Each program's locations are independent (a location is
    // only valid for the program it was queried from), so these are kept in
    // per-program objects, not shared.
    this.quadLoc = {
      decay:   { p: gl.getAttribLocation(this.decayP, "p") },
      present: { p: gl.getAttribLocation(this.presentP, "p") },
    };
    this.decayLoc = {
      tex: gl.getUniformLocation(this.decayP, "tex"),
      k:   gl.getUniformLocation(this.decayP, "k"),
    };
    this.stampLoc = {
      res:        gl.getUniformLocation(this.stampP, "res"),
      color:      gl.getUniformLocation(this.stampP, "color"),
      brightness: gl.getUniformLocation(this.stampP, "brightness"),
      frontSpeed: gl.getUniformLocation(this.stampP, "frontSpeed"),
      thickness:  gl.getUniformLocation(this.stampP, "thickness"),
      wakeTau:    gl.getUniformLocation(this.stampP, "wakeTau"),
      wakeLevel:  gl.getUniformLocation(this.stampP, "wakeLevel"),
      lifeTau:    gl.getUniformLocation(this.stampP, "lifeTau"),
      p:          gl.getAttribLocation(this.stampP, "p"),
      delay:      gl.getAttribLocation(this.stampP, "delay"),
      age:        gl.getAttribLocation(this.stampP, "age"),
      inten:      gl.getAttribLocation(this.stampP, "inten"),
    };
    this.presentLoc = {
      tex:          gl.getUniformLocation(this.presentP, "tex"),
      glowStrength: gl.getUniformLocation(this.presentP, "glowStrength"),
      uBase:        gl.getUniformLocation(this.presentP, "uBase"),
    };
    this.pointLoc = {
      res:  gl.getUniformLocation(this.pointP, "res"),
      size: gl.getUniformLocation(this.pointP, "size"),
      p:    gl.getAttribLocation(this.pointP, "p"),
      col:  gl.getAttribLocation(this.pointP, "col"),
    };
    this.corridorLoc = {
      projScale: gl.getUniformLocation(this.corridorP, "projScale"),
      projOffset: gl.getUniformLocation(this.corridorP, "projOffset"),
      res: gl.getUniformLocation(this.corridorP, "res"),
      width: gl.getUniformLocation(this.corridorP, "width"),
      color: gl.getUniformLocation(this.corridorP, "color"),
      brightness: gl.getUniformLocation(this.corridorP, "brightness"),
      a: gl.getAttribLocation(this.corridorP, "a"),
      b: gl.getAttribLocation(this.corridorP, "b"),
    };
  }
  _alloc(w, h) {
    const gl = this.gl;
    if (this.tex) for (const t of this.tex) gl.deleteTexture(t);
    if (this.fbo) for (const f of this.fbo) gl.deleteFramebuffer(f);
    this.tex = []; this.fbo = [];
    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      this.tex.push(t); this.fbo.push(f);
    }
    this.cur = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[0]); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[1]); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  resize(w, h) { this.w = w; this.h = h; this._alloc(w, h); }
  _drawQuad(prog, loc) {
    const gl = this.gl; gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(loc.p); gl.vertexAttribPointer(loc.p, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  decay(k) {
    const gl = this.gl, src = this.cur, dst = 1 - this.cur, loc = this.decayLoc;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[dst]); gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.BLEND); gl.useProgram(this.decayP);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex[src]);
    gl.uniform1i(loc.tex, 0);
    gl.uniform1f(loc.k, k);
    this._drawQuad(this.decayP, this.quadLoc.decay); this.cur = dst;
  }
  // intensities: optional per-vertex 0..1 Float32Array, same footing as
  // delays/ages (pre-sized scratch buffer, first `vertexCount` valid). Omit
  // it (undefined/null) to get a full-intensity (1.0) draw everywhere --
  // that is the Life caller's contract: Life's CA has no per-vertex capacity
  // signal (Task 4), so it must render byte-for-byte unchanged from before
  // this attribute existed. `_uploadConst` fills the GPU buffer with a
  // repeated 1.0 without requiring the caller to allocate/fill a real array.
  stamp(segVertices, delays, ages, color, params, vertexCount, intensities) {
    const gl = this.gl, loc = this.stampLoc;
    // Callers may pass pre-sized scratch buffers with only the first
    // `vertexCount` vertices valid. Older callers pass exact-sized arrays and
    // omit the count.
    const n = vertexCount === undefined ? segVertices.length / 2 : vertexCount;
    if (n === 0) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]); gl.viewport(0, 0, this.w, this.h);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.stampP);
    gl.uniform2f(loc.res, this.w, this.h);
    gl.uniform3fv(loc.color, color);
    gl.uniform1f(loc.brightness, STAMP_BRIGHTNESS);
    gl.uniform1f(loc.frontSpeed, params.frontSpeed);
    gl.uniform1f(loc.thickness, params.thickness);
    gl.uniform1f(loc.wakeTau, params.wakeTau);
    gl.uniform1f(loc.wakeLevel, params.wakeLevel);
    gl.uniform1f(loc.lifeTau, params.lifeTau);
    this._upload(this.segBuf, segVertices, n * 2, loc.p, 2, "_segCap");
    this._upload(this.delayBuf, delays, n, loc.delay, 1, "_delayCap");
    this._upload(this.ageBuf, ages, n, loc.age, 1, "_ageCap");
    if (intensities === undefined || intensities === null) {
      this._uploadConst(loc.inten, 1.0);
    } else {
      this._upload(this.intenBuf, intensities, n, loc.inten, 1, "_intenCap");
    }
    gl.drawArrays(gl.LINES, 0, n);
  }

  // Upload the first `count` floats of `src` into `buf` without re-specifying
  // the whole buffer every frame. gl.bufferData reallocates GPU storage on
  // each call; bufferSubData writes into storage allocated once. The buffer is
  // grown (never shrunk) when a frame needs more than it currently holds.
  _upload(buf, src, count, attribLoc, size, capKey) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const need = count * 4; // bytes (Float32)
    if ((this[capKey] || 0) < need) {
      let cap = Math.max(this[capKey] || 0, 4096);
      while (cap < need) cap *= 2;
      gl.bufferData(gl.ARRAY_BUFFER, cap, gl.DYNAMIC_DRAW);
      this[capKey] = cap;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, src, 0, count);
    gl.enableVertexAttribArray(attribLoc);
    gl.vertexAttribPointer(attribLoc, size, gl.FLOAT, false, 0, 0);
  }
  // Bind `attribLoc` to a constant value for every vertex in the draw call,
  // without uploading a filled per-vertex buffer. Used for the Life caller's
  // intensity attribute (always 1.0) -- disableVertexAttribArray + the
  // vertexAttrib1f constant is the standard WebGL2 way to give an `in float`
  // attribute a uniform-like value: no allocation, no upload needed.
  _uploadConst(attribLoc, value) {
    const gl = this.gl;
    gl.disableVertexAttribArray(attribLoc);
    gl.vertexAttrib1f(attribLoc, value);
  }
  stampDots(pointsXY, colorsRGBA, sizePx) {
    const gl = this.gl, loc = this.pointLoc;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]); gl.viewport(0, 0, this.w, this.h);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.pointP);
    gl.uniform2f(loc.res, this.w, this.h);
    gl.uniform1f(loc.size, sizePx);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ptBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pointsXY, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.p); gl.vertexAttribPointer(loc.p, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ptColBuf);
    gl.bufferData(gl.ARRAY_BUFFER, colorsRGBA, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.col); gl.vertexAttribPointer(loc.col, 4, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, pointsXY.length / 2);
  }
  setCorridors(vertices, batches) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corridorBuf);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    this.corridorBatches = batches;
  }
  drawCorridors(projection, colors, widthForWeight, brightnessForWeight) {
    if (!this.corridorBatches.length) return;
    const gl = this.gl, loc = this.corridorLoc;
    const p0 = projection.fn(0, 0), p1 = projection.fn(1, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]); gl.viewport(0, 0, this.w, this.h);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.useProgram(this.corridorP);
    gl.uniform2f(loc.projScale, p1[0]-p0[0], p1[1]-p0[1]);
    gl.uniform2f(loc.projOffset, p0[0], p0[1]); gl.uniform2f(loc.res, this.w, this.h);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corridorBuf);
    const stride = 4 * 4;
    for (const attr of [loc.a, loc.b]) {
      gl.enableVertexAttribArray(attr);
      gl.vertexAttribDivisor(attr, 1);
    }
    for (const batch of this.corridorBatches) {
      const color = colors[batch.mode]; if (!color) continue;
      const offset = batch.first * stride;
      gl.vertexAttribPointer(loc.a,2,gl.FLOAT,false,stride,offset);
      gl.vertexAttribPointer(loc.b,2,gl.FLOAT,false,stride,offset + 8);
      gl.uniform3fv(loc.color,color); gl.uniform1f(loc.width,widthForWeight(batch.weight));
      gl.uniform1f(loc.brightness,brightnessForWeight(batch.weight));
      gl.drawArraysInstanced(gl.TRIANGLES,0,6,batch.count);
    }
    // Attribute divisors are global WebGL state; later ripple programs reuse
    // these numeric slots for ordinary per-vertex attributes.
    gl.vertexAttribDivisor(loc.a, 0); gl.vertexAttribDivisor(loc.b, 0);
  }
  clearField() {
    const gl = this.gl;
    for (const f of this.fbo) { gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.clear(gl.COLOR_BUFFER_BIT); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  // dispose — release every GL object this field allocated, so a city switch
  // (world-ripples Phase B re-entrant boot) doesn't leak a full set of
  // programs/buffers/textures per switch. Frees EXACTLY what is created here:
  //   - 5 programs (decayP, presentP, stampP, pointP, corridorP), compiled in the ctor
  //   - 8 buffers (quad + segBuf/intBuf/delayBuf/ageBuf + ptBuf/ptColBuf + corridorBuf)
  //   - 2 textures + 2 framebuffers, allocated by _alloc (re-run on resize)
  // Shader objects themselves are not tracked: compile() attaches them and
  // never keeps a handle, so they are already flagged for deletion by the
  // driver once their program is deleted.
  //
  // Idempotent: nulls the handles it frees, so a double dispose() is a no-op
  // rather than a deleteBuffer(null) storm. After dispose the instance is
  // dead — callers must construct a new RippleField, not reuse this one.
  dispose() {
    const gl = this.gl;
    if (!gl) return;
    for (const p of [this.decayP, this.presentP, this.stampP, this.pointP, this.corridorP]) {
      if (p) gl.deleteProgram(p);
    }
    this.decayP = this.presentP = this.stampP = this.pointP = this.corridorP = null;
    for (const b of [this.quad, this.segBuf, this.intBuf, this.delayBuf,
                     this.ageBuf, this.ptBuf, this.ptColBuf, this.corridorBuf]) {
      if (b) gl.deleteBuffer(b);
    }
    this.quad = this.segBuf = this.intBuf = this.delayBuf =
      this.ageBuf = this.ptBuf = this.ptColBuf = this.corridorBuf = null;
    this._segCap = 0; this._delayCap = 0; this._ageCap = 0;
    if (this.tex) for (const t of this.tex) gl.deleteTexture(t);
    if (this.fbo) for (const f of this.fbo) gl.deleteFramebuffer(f);
    this.tex = null; this.fbo = null;
    this.gl = null;
  }
  present(baseRgb) {
    const gl = this.gl, loc = this.presentLoc;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex[this.cur]);
    gl.useProgram(this.presentP);
    gl.uniform1i(loc.tex, 0);
    gl.uniform1f(loc.glowStrength, GLOW_STRENGTH);
    // Omitted base == today's exact literal, so sun-off renders byte-identically.
    gl.uniform3fv(loc.uBase, baseRgb || DEFAULT_RGB);
    this._drawQuad(this.presentP, this.quadLoc.present);
  }
}
