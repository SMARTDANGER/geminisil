// Multi-scale exemplar inpainting.
//
// Pipeline per call:
//   1. Build Gaussian pyramid (image + mask) at 3 levels (1/4, 1/2, 1/1).
//   2. Fill coarsest level with Criminisi-style priority order + PatchMatch
//      randomized nearest-neighbor search.
//   3. Upsample result, copy known pixels back, refine masked region at next
//      level.
//   4. Final 3x3 edge smooth on originally-masked pixels only.
//
// Per-level fill = Criminisi (Criminisi et al. 2003) with:
//   - priority = confidence * data_term, data = |∇I⊥ · n| / 255 (isophote
//     driven, preserves edges/structures across the hole)
//   - logistic confidence update (Wang et al. 2014) — avoids the rapid
//     confidence decay that biases the original Criminisi priority
//   - PatchMatch (Barnes et al. 2009) randomized search instead of strided
//     window scan: K random candidates, propagate from spatial neighbors'
//     best offsets, shrinking-radius random refinement
//   - cosine-feathered patch blending (no hard seams → no post-blur required)

export interface InpaintOptions {
  srcCanvas: HTMLCanvasElement;
  maskCanvas: HTMLCanvasElement;
  onProgress?: (p: number) => void;
}

interface Level {
  w: number;
  h: number;
  px: Uint8ClampedArray; // RGBA
  flags: Uint8Array;     // 1 = masked
  origFlags: Uint8Array; // snapshot pre-fill
}

// ---------- pyramid construction ----------

function downsample2(
  src: Uint8ClampedArray,
  sw: number,
  sh: number
): { px: Uint8ClampedArray; w: number; h: number } {
  const w = sw >> 1;
  const h = sh >> 1;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x << 1;
      const sy = y << 1;
      const i00 = (sy * sw + sx) << 2;
      const i10 = i00 + 4;
      const i01 = ((sy + 1) * sw + sx) << 2;
      const i11 = i01 + 4;
      const o = (y * w + x) << 2;
      out[o]     = (src[i00]     + src[i10]     + src[i01]     + src[i11])     >> 2;
      out[o + 1] = (src[i00 + 1] + src[i10 + 1] + src[i01 + 1] + src[i11 + 1]) >> 2;
      out[o + 2] = (src[i00 + 2] + src[i10 + 2] + src[i01 + 2] + src[i11 + 2]) >> 2;
      out[o + 3] = 255;
    }
  }
  return { px: out, w, h };
}

function downsampleMask(
  src: Uint8Array,
  sw: number,
  sh: number
): { flags: Uint8Array; w: number; h: number } {
  const w = sw >> 1;
  const h = sh >> 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x << 1;
      const sy = y << 1;
      // dilation under decimation: any masked sub-pixel marks the parent.
      // shrinks in upsampling to roughly preserve the original shape.
      const a =
        src[sy * sw + sx] |
        src[sy * sw + sx + 1] |
        src[(sy + 1) * sw + sx] |
        src[(sy + 1) * sw + sx + 1];
      out[y * w + x] = a;
    }
  }
  return { flags: out, w, h };
}

function upsample2(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const fy = (y * (sh - 1)) / Math.max(1, dh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = (x * (sw - 1)) / Math.max(1, dw - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const i00 = (y0 * sw + x0) << 2;
      const i10 = (y0 * sw + x1) << 2;
      const i01 = (y1 * sw + x0) << 2;
      const i11 = (y1 * sw + x1) << 2;
      const o = (y * dw + x) << 2;
      for (let c = 0; c < 3; c++) {
        const a = src[i00 + c] * (1 - wx) + src[i10 + c] * wx;
        const b = src[i01 + c] * (1 - wx) + src[i11 + c] * wx;
        out[o + c] = a * (1 - wy) + b * wy;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

// ---------- boundary + priority ----------

function findBoundary(flags: Uint8Array, w: number, h: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (!flags[i]) continue;
      if (
        (x > 0 && !flags[i - 1]) ||
        (x < w - 1 && !flags[i + 1]) ||
        (y > 0 && !flags[i - w]) ||
        (y < h - 1 && !flags[i + w])
      ) out.push(i);
    }
  }
  return out;
}

function patchConfidence(
  conf: Float32Array,
  flags: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  R: number
): number {
  let sum = 0;
  let total = 0;
  for (let dy = -R; dy <= R; dy++) {
    const yy = cy + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -R; dx <= R; dx++) {
      const xx = cx + dx;
      if (xx < 0 || xx >= w) continue;
      total++;
      if (!flags[yy * w + xx]) sum += conf[yy * w + xx];
    }
  }
  return total > 0 ? sum / total : 0;
}

// data term = |∇I⊥ · n| / 255. ∇I⊥ = isophote (perpendicular to gradient).
// n = normal to the mask boundary at (cx,cy). High when a strong edge crosses
// the boundary → fill that pixel first to extend structures into the hole.
function dataTerm(
  px: Uint8ClampedArray,
  flags: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number
): number {
  // boundary normal (gradient of the mask indicator)
  const mL = cx > 0 ? flags[cy * w + cx - 1] : 1;
  const mR = cx < w - 1 ? flags[cy * w + cx + 1] : 1;
  const mU = cy > 0 ? flags[(cy - 1) * w + cx] : 1;
  const mD = cy < h - 1 ? flags[(cy + 1) * w + cx] : 1;
  let nx = (mR - mL) * 0.5;
  let ny = (mD - mU) * 0.5;
  const nm = Math.hypot(nx, ny);
  if (nm < 1e-6) return 0.001;
  nx /= nm; ny /= nm;

  // image gradient on the *known* side, sampled by reflecting masked neighbors
  function lum(x: number, y: number): number {
    x = Math.max(0, Math.min(w - 1, x));
    y = Math.max(0, Math.min(h - 1, y));
    let i = y * w + x;
    if (flags[i]) {
      // reflect to opposite known neighbor if available
      const rx = Math.max(0, Math.min(w - 1, cx - (x - cx)));
      const ry = Math.max(0, Math.min(h - 1, cy - (y - cy)));
      if (!flags[ry * w + rx]) i = ry * w + rx;
      else return 0;
    }
    const p = i << 2;
    return 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2];
  }

  const gx = (lum(cx + 1, cy) - lum(cx - 1, cy)) * 0.5;
  const gy = (lum(cx, cy + 1) - lum(cx, cy - 1)) * 0.5;
  // isophote = (-gy, gx). dot with normal:
  const dot = -gy * nx + gx * ny;
  return Math.abs(dot) / 255 + 0.001;
}

// ---------- patch utilities ----------

function isSourceFullyKnown(
  flags: Uint8Array,
  w: number,
  h: number,
  sx: number,
  sy: number,
  R: number
): boolean {
  if (sx - R < 0 || sx + R >= w || sy - R < 0 || sy + R >= h) return false;
  for (let dy = -R; dy <= R; dy++) {
    const row = (sy + dy) * w;
    for (let dx = -R; dx <= R; dx++) {
      if (flags[row + sx + dx]) return false;
    }
  }
  return true;
}

function patchSSD(
  px: Uint8ClampedArray,
  flags: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  sx: number,
  sy: number,
  R: number,
  bestErr: number
): number {
  let err = 0;
  for (let dy = -R; dy <= R; dy++) {
    const ty = cy + dy;
    if (ty < 0 || ty >= h) continue;
    const tgtRow = ty * w;
    const srcRow = (sy + dy) * w;
    for (let dx = -R; dx <= R; dx++) {
      const tx = cx + dx;
      if (tx < 0 || tx >= w) continue;
      const ti = tgtRow + tx;
      if (flags[ti]) continue; // skip masked target pixels
      const tp = ti << 2;
      const sp = (srcRow + sx + dx) << 2;
      const rd = px[tp]     - px[sp];
      const gd = px[tp + 1] - px[sp + 1];
      const bd = px[tp + 2] - px[sp + 2];
      err += rd * rd + gd * gd + bd * bd;
      if (err >= bestErr) return err;
    }
  }
  return err;
}

// PatchMatch-style randomized search for best source patch.
// Uses an offset cache (NN field) for spatial propagation between calls.
function patchMatchFind(
  px: Uint8ClampedArray,
  flags: Uint8Array,
  nnf: Int32Array, // packed (sx<<16 | sy) per pixel; -1 if unset
  w: number,
  h: number,
  cx: number,
  cy: number,
  R: number,
  rng: () => number
): { bx: number; by: number } | null {
  let bestErr = Infinity;
  let bestX = -1;
  let bestY = -1;

  function consider(sx: number, sy: number) {
    if (sx === cx && sy === cy) return;
    if (!isSourceFullyKnown(flags, w, h, sx, sy, R)) return;
    const err = patchSSD(px, flags, w, h, cx, cy, sx, sy, R, bestErr);
    if (err < bestErr) {
      bestErr = err;
      bestX = sx;
      bestY = sy;
    }
  }

  // 1. propagate from spatial neighbors' cached NN
  const ci = cy * w + cx;
  for (const ni of [ci - 1, ci + 1, ci - w, ci + w]) {
    if (ni < 0 || ni >= w * h) continue;
    const packed = nnf[ni];
    if (packed < 0) continue;
    const sx = packed >> 16;
    const sy = packed & 0xffff;
    // shift by neighbor offset to align with current pixel
    const dx = ci % w - ni % w;
    const dy = ((ci / w) | 0) - ((ni / w) | 0);
    consider(sx + dx, sy + dy);
  }

  // 2. K random candidates uniformly across the image
  const K = 12;
  for (let k = 0; k < K; k++) {
    const sx = R + ((rng() * (w - 2 * R)) | 0);
    const sy = R + ((rng() * (h - 2 * R)) | 0);
    consider(sx, sy);
  }

  // 3. random refinement: shrinking-radius search around current best
  if (bestX >= 0) {
    let radius = Math.max(w, h) >> 1;
    while (radius >= 1) {
      const sx = bestX + (((rng() * 2 - 1) * radius) | 0);
      const sy = bestY + (((rng() * 2 - 1) * radius) | 0);
      if (sx >= R && sx < w - R && sy >= R && sy < h - R) {
        consider(sx, sy);
      }
      radius >>= 1;
    }
  }

  // 4. local fallback if still nothing (very large hole, few sources nearby)
  if (bestX < 0) {
    for (let SR = 16; SR <= Math.max(w, h); SR <<= 1) {
      const xmin = Math.max(R, cx - SR);
      const xmax = Math.min(w - R - 1, cx + SR);
      const ymin = Math.max(R, cy - SR);
      const ymax = Math.min(h - R - 1, cy + SR);
      const stride = Math.max(2, (SR / 16) | 0);
      for (let sy = ymin; sy <= ymax; sy += stride) {
        for (let sx = xmin; sx <= xmax; sx += stride) {
          consider(sx, sy);
        }
      }
      if (bestX >= 0) break;
    }
  }

  if (bestX < 0) return null;
  nnf[ci] = (bestX << 16) | bestY;
  return { bx: bestX, by: bestY };
}

// cosine-weighted patch copy. Weight = cos(πr/2R)^2 inside R, 0 outside.
// Blends new content with whatever is already in place (from prior overlapping
// patches), eliminating the hard seams that the brute-copy version produced.
function featherCopy(
  px: Uint8ClampedArray,
  flags: Uint8Array,
  origFlags: Uint8Array,
  conf: Float32Array,
  blendW: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  sx: number,
  sy: number,
  R: number
): number {
  let filled = 0;
  const srcConf = patchConfidence(conf, flags, w, h, cx, cy, R);
  for (let dy = -R; dy <= R; dy++) {
    const ty = cy + dy;
    if (ty < 0 || ty >= h) continue;
    for (let dx = -R; dx <= R; dx++) {
      const tx = cx + dx;
      if (tx < 0 || tx >= w) continue;
      const ti = ty * w + tx;
      if (!origFlags[ti]) continue; // never touch originally-known pixels

      const r = Math.hypot(dx, dy) / R;
      if (r > 1) continue;
      const wgt = Math.cos((Math.PI * r) / 2);
      const wgt2 = wgt * wgt;

      const tp = ti << 2;
      const sp = ((sy + dy) * w + sx + dx) << 2;

      const prevW = blendW[ti];
      const newW = prevW + wgt2;
      if (prevW === 0) {
        px[tp]     = px[sp];
        px[tp + 1] = px[sp + 1];
        px[tp + 2] = px[sp + 2];
      } else {
        px[tp]     = (px[tp]     * prevW + px[sp]     * wgt2) / newW;
        px[tp + 1] = (px[tp + 1] * prevW + px[sp + 1] * wgt2) / newW;
        px[tp + 2] = (px[tp + 2] * prevW + px[sp + 2] * wgt2) / newW;
      }
      px[tp + 3] = 255;
      blendW[ti] = newW;

      if (flags[ti]) {
        flags[ti] = 0;
        // logistic confidence: f(c) = 1 / (1 + exp(-α(c-0.5))). avoids the
        // rapid product-of-fractions decay of the original Criminisi update.
        const c = 1 / (1 + Math.exp(-6 * (srcConf - 0.5)));
        conf[ti] = c;
        filled++;
      }
    }
  }
  return filled;
}

function fillAvg(
  px: Uint8ClampedArray,
  flags: Uint8Array,
  conf: Float32Array,
  blendW: Float32Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  R: number
): number {
  // weighted average of known neighbors. Used only when no source patch found.
  let filled = 0;
  for (let dy = -R; dy <= R; dy++) {
    const ty = cy + dy;
    if (ty < 0 || ty >= h) continue;
    for (let dx = -R; dx <= R; dx++) {
      const tx = cx + dx;
      if (tx < 0 || tx >= w) continue;
      const ti = ty * w + tx;
      if (!flags[ti]) continue;

      let rSum = 0, gSum = 0, bSum = 0, wSum = 0;
      const RR = 5;
      for (let ny = -RR; ny <= RR; ny++) {
        const yy = ty + ny;
        if (yy < 0 || yy >= h) continue;
        for (let nx = -RR; nx <= RR; nx++) {
          const xx = tx + nx;
          if (xx < 0 || xx >= w) continue;
          const ni = yy * w + xx;
          if (flags[ni]) continue;
          const d2 = nx * nx + ny * ny;
          if (d2 > RR * RR) continue;
          const weight = 1 / (d2 + 0.5);
          const np = ni << 2;
          rSum += px[np]     * weight;
          gSum += px[np + 1] * weight;
          bSum += px[np + 2] * weight;
          wSum += weight;
        }
      }
      if (wSum > 0) {
        const tp = ti << 2;
        px[tp]     = rSum / wSum;
        px[tp + 1] = gSum / wSum;
        px[tp + 2] = bSum / wSum;
        px[tp + 3] = 255;
        flags[ti] = 0;
        conf[ti] = 0.1;
        blendW[ti] = 1;
        filled++;
      }
    }
  }
  return filled;
}

// ---------- per-level fill ----------

async function fillLevel(
  L: Level,
  R: number,
  rng: () => number,
  onProgress?: (p: number) => void,
  progBase = 0,
  progSpan = 1
): Promise<void> {
  const { w, h, px, flags } = L;
  const conf = new Float32Array(w * h);
  for (let i = 0; i < flags.length; i++) conf[i] = flags[i] ? 0 : 1;
  const blendW = new Float32Array(w * h);
  for (let i = 0; i < flags.length; i++) blendW[i] = flags[i] ? 0 : 1;
  const nnf = new Int32Array(w * h).fill(-1);

  let remaining = 0;
  for (let i = 0; i < flags.length; i++) if (flags[i]) remaining++;
  if (!remaining) return;
  const initial = remaining;

  let stuck = 0;
  let wave = 0;
  while (remaining > 0 && stuck < 3 && wave < 60) {
    wave++;
    const boundary = findBoundary(flags, w, h);
    if (!boundary.length) break;

    const scored: Array<{ idx: number; pri: number }> = boundary.map((idx) => {
      const cx = idx % w;
      const cy = (idx / w) | 0;
      const c = patchConfidence(conf, flags, w, h, cx, cy, R);
      const d = dataTerm(px, flags, w, h, cx, cy);
      return { idx, pri: c * d };
    });
    scored.sort((a, b) => b.pri - a.pri);

    const before = remaining;
    let processed = 0;
    for (const s of scored) {
      if (!flags[s.idx]) continue;
      const cx = s.idx % w;
      const cy = (s.idx / w) | 0;
      const best = patchMatchFind(px, flags, nnf, w, h, cx, cy, R, rng);
      if (best) {
        remaining -= featherCopy(
          px, flags, L.origFlags, conf, blendW, w, h, cx, cy, best.bx, best.by, R
        );
      } else {
        remaining -= fillAvg(px, flags, conf, blendW, w, h, cx, cy, R);
      }
      processed++;
      if (processed % 64 === 0) {
        const p = progBase + progSpan * (1 - remaining / initial);
        onProgress?.(p);
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (remaining >= before) stuck++;
    else stuck = 0;
    onProgress?.(progBase + progSpan * (1 - remaining / initial));
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ---------- top level ----------

function buildLevel(px: Uint8ClampedArray, flags: Uint8Array, w: number, h: number): Level {
  return { w, h, px, flags, origFlags: new Uint8Array(flags) };
}

function readSource(canvas: HTMLCanvasElement): { px: Uint8ClampedArray; w: number; h: number } {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const data = ctx.getImageData(0, 0, w, h).data;
  return { px: new Uint8ClampedArray(data), w, h };
}

function readMaskFlags(canvas: HTMLCanvasElement): Uint8Array {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) out[p] = d[i + 3] > 32 ? 1 : 0;
  return out;
}

// ---------- watermark / reverse-alpha-blend pre-pass ----------
//
// For semi-transparent overlays (Gemini logo, AI watermarks):
//   I = α·W + (1-α)·B     (alpha-composited observation)
//   B = (I - α·W) / (1-α) (mathematical inverse — preserves underlying texture)
//
// Pipeline:
//   1. estimateBackground() — propagate boundary colors inward via diffusion.
//      Gives a low-frequency B estimate per masked pixel.
//   2. estimateWatermarkColor() — sample mask interior away from boundary;
//      defaults to white if no clear chromatic preference.
//   3. estimateAlpha() — per-pixel α = projection of (I - B) onto (W - B).
//   4. Detect: if α is mostly in [0.1, 0.9] and coherent → watermark.
//   5. Apply reverse blend; pixels with α > 0.92 stay masked for exemplar fill.

function estimateBackground(
  px: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number,
  iters = 24
): Float32Array {
  // initialize: known pixels = their RGB, unknown = 0
  const bg = new Float32Array(w * h * 3);
  for (let i = 0, p = 0; i < mask.length; i++, p += 3) {
    if (!mask[i]) {
      const q = i << 2;
      bg[p]     = px[q];
      bg[p + 1] = px[q + 1];
      bg[p + 2] = px[q + 2];
    }
  }
  // jacobi-style diffusion: each masked pixel = average of neighbors.
  // Boundary (known) pixels stay fixed → guides smooth bg into the hole.
  const tmp = new Float32Array(bg.length);
  for (let it = 0; it < iters; it++) {
    tmp.set(bg);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        if (x > 0)     { const q = (i - 1) * 3; r += tmp[q]; g += tmp[q+1]; b += tmp[q+2]; n++; }
        if (x < w - 1) { const q = (i + 1) * 3; r += tmp[q]; g += tmp[q+1]; b += tmp[q+2]; n++; }
        if (y > 0)     { const q = (i - w) * 3; r += tmp[q]; g += tmp[q+1]; b += tmp[q+2]; n++; }
        if (y < h - 1) { const q = (i + w) * 3; r += tmp[q]; g += tmp[q+1]; b += tmp[q+2]; n++; }
        if (n > 0) {
          const p = i * 3;
          bg[p]     = r / n;
          bg[p + 1] = g / n;
          bg[p + 2] = b / n;
        }
      }
    }
  }
  return bg;
}

function estimateWatermarkColor(
  px: Uint8ClampedArray,
  mask: Uint8Array,
  bg: Float32Array,
  w: number,
  h: number
): [number, number, number] {
  // pixels deepest inside mask (max distance from boundary) are dominated by W.
  // compute distance transform via simple BFS-style two-pass.
  const dist = new Float32Array(mask.length);
  for (let i = 0; i < mask.length; i++) dist[i] = mask[i] ? Infinity : 0;
  // forward
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let d = dist[i];
      if (x > 0)     d = Math.min(d, dist[i - 1] + 1);
      if (y > 0)     d = Math.min(d, dist[i - w] + 1);
      dist[i] = d;
    }
  }
  // backward
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let d = dist[i];
      if (x < w - 1) d = Math.min(d, dist[i + 1] + 1);
      if (y < h - 1) d = Math.min(d, dist[i + w] + 1);
      dist[i] = d;
    }
  }

  let maxDist = 0;
  for (let i = 0; i < dist.length; i++) if (mask[i] && dist[i] > maxDist) maxDist = dist[i];
  const thresh = Math.max(1, maxDist * 0.6);

  // average shifted color among deep-interior pixels: extrapolated W candidate.
  // I = α·W + (1-α)·B → with high α, I ≈ W.
  let rs = 0, gs = 0, bs = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || dist[i] < thresh) continue;
    const q = i << 2;
    rs += px[q]; gs += px[q + 1]; bs += px[q + 2];
    n++;
  }
  if (n === 0) return [255, 255, 255];
  const Wr = rs / n, Wg = gs / n, Wb = bs / n;

  // if mean is near-white, snap to white (logos are usually white).
  // Also clamps low-confidence estimates from tiny masks.
  const lum = 0.299 * Wr + 0.587 * Wg + 0.114 * Wb;
  if (lum > 200) return [255, 255, 255];
  return [Wr, Wg, Wb];
}

function tryWatermarkRemoval(
  src: Uint8ClampedArray,
  mask: Uint8Array,
  w: number,
  h: number
): { applied: boolean; recovered: Uint8ClampedArray; residualMask: Uint8Array } {
  const recovered = new Uint8ClampedArray(src);
  const residualMask = new Uint8Array(w * h);

  let maskedCount = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) maskedCount++;
  // too small or too large to be a watermark
  if (maskedCount < 32 || maskedCount > mask.length * 0.5) {
    return { applied: false, recovered, residualMask: new Uint8Array(mask) };
  }

  const bg = estimateBackground(src, mask, w, h, 32);
  const [Wr, Wg, Wb] = estimateWatermarkColor(src, mask, bg, w, h);

  // per-pixel alpha + recovered B'
  const alphas: number[] = [];
  let coherentVotes = 0;
  let totalVotes = 0;

  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const q = i << 2;
    const Ir = src[q], Ig = src[q + 1], Ib = src[q + 2];
    const p = i * 3;
    const Br = bg[p], Bg = bg[p + 1], Bb = bg[p + 2];

    // I - B = α(W - B)  →  α = ((I-B)·(W-B)) / ||W-B||²
    const dWr = Wr - Br, dWg = Wg - Bg, dWb = Wb - Bb;
    const dIr = Ir - Br, dIg = Ig - Bg, dIb = Ib - Bb;
    const denom = dWr * dWr + dWg * dWg + dWb * dWb;
    if (denom < 1e-3) continue;
    let alpha = (dIr * dWr + dIg * dWg + dIb * dWb) / denom;
    alpha = Math.max(0, Math.min(1, alpha));
    alphas.push(alpha);

    // coherence test: how well does I-B align with W-B direction?
    const magI = Math.hypot(dIr, dIg, dIb);
    const magW = Math.sqrt(denom);
    if (magI > 6 && magW > 6) {
      totalVotes++;
      const cos = (dIr * dWr + dIg * dWg + dIb * dWb) / (magI * magW);
      if (cos > 0.7) coherentVotes++;
    }
  }

  if (alphas.length === 0) {
    return { applied: false, recovered, residualMask: new Uint8Array(mask) };
  }

  // detection criteria:
  //   - majority of strong-shift pixels point in W's direction (coherent overlay)
  //   - mean α in semi-transparent range (not opaque object)
  const meanAlpha = alphas.reduce((s, v) => s + v, 0) / alphas.length;
  const coherentFrac = totalVotes > 0 ? coherentVotes / totalVotes : 0;

  const isWatermark = coherentFrac > 0.6 && meanAlpha > 0.1 && meanAlpha < 0.92;

  if (!isWatermark) {
    return { applied: false, recovered, residualMask: new Uint8Array(mask) };
  }

  // light box-smooth alpha map (3x3) to suppress per-pixel estimation noise
  const alphaMap = new Float32Array(w * h);
  let aIdx = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    alphaMap[i] = alphas[aIdx++];
  }
  const alphaSmooth = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!mask[j]) continue;
          s += alphaMap[j]; n++;
        }
      }
      alphaSmooth[i] = n > 0 ? s / n : alphaMap[i];
    }
  }

  // apply reverse alpha blend
  const ALPHA_OPAQUE = 0.92;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const a = alphaSmooth[i];
    if (a >= ALPHA_OPAQUE) {
      // too opaque to recover — leave for exemplar inpaint
      residualMask[i] = 1;
      continue;
    }
    const q = i << 2;
    const inv = 1 / (1 - a);
    const Br = (src[q]     - a * Wr) * inv;
    const Bg = (src[q + 1] - a * Wg) * inv;
    const Bb = (src[q + 2] - a * Wb) * inv;
    recovered[q]     = Math.max(0, Math.min(255, Br));
    recovered[q + 1] = Math.max(0, Math.min(255, Bg));
    recovered[q + 2] = Math.max(0, Math.min(255, Bb));
    recovered[q + 3] = 255;
  }

  return { applied: true, recovered, residualMask };
}

// deterministic xorshift32 — same input → same output, important for replays
function makeRng(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 0xffffff) / 0xffffff;
  };
}

export async function runInpaint(opts: InpaintOptions): Promise<HTMLCanvasElement> {
  const { srcCanvas, maskCanvas, onProgress } = opts;
  const W = srcCanvas.width;
  const H = srcCanvas.height;

  const result = document.createElement("canvas");
  result.width = W;
  result.height = H;
  const rctx = result.getContext("2d", { willReadFrequently: true })!;
  rctx.drawImage(srcCanvas, 0, 0);

  const src = readSource(srcCanvas);
  const originalMask = readMaskFlags(maskCanvas);

  // any masked at all?
  let anyMasked = false;
  for (let i = 0; i < originalMask.length; i++) if (originalMask[i]) { anyMasked = true; break; }
  if (!anyMasked) {
    onProgress?.(1);
    return result;
  }

  // ---------- Pass 1: try reverse-alpha-blend (semi-transparent overlay) ----------
  // If detected as a watermark, the underlying texture is recovered exactly via
  // the alpha-compositing inverse. Pixels too opaque to recover (α > 0.92)
  // remain in residualMask and get exemplar-inpainted in Pass 2.
  onProgress?.(0.05);
  const wm = tryWatermarkRemoval(src.px, originalMask, W, H);
  let workPx = src.px;
  let mask = originalMask;
  if (wm.applied) {
    workPx = wm.recovered;
    mask = wm.residualMask;
    let residualCount = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) residualCount++;
    if (residualCount === 0) {
      // pure watermark — done
      const out = rctx.getImageData(0, 0, W, H);
      out.data.set(workPx);
      rctx.putImageData(out, 0, 0);
      onProgress?.(1);
      return result;
    }
  }

  // decide pyramid depth from min dimension and hole size
  let masked = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) masked++;
  const holeFrac = masked / mask.length;
  // bigger hole or bigger image → more levels (max 3)
  const minDim = Math.min(W, H);
  let levels = 1;
  if (minDim >= 256 && holeFrac > 0.005) levels = 2;
  if (minDim >= 512 && holeFrac > 0.02) levels = 3;

  // build pyramid
  const pyramid: Level[] = [];
  pyramid.push(buildLevel(workPx, mask, W, H));
  for (let l = 1; l < levels; l++) {
    const prev = pyramid[l - 1];
    const ds = downsample2(prev.px, prev.w, prev.h);
    const dm = downsampleMask(prev.flags, prev.w, prev.h);
    pyramid.push(buildLevel(ds.px, dm.flags, ds.w, ds.h));
  }

  const rng = makeRng(0xC0FFEE);
  const R = 4;

  // fill coarse → fine
  for (let l = pyramid.length - 1; l >= 0; l--) {
    const L = pyramid[l];

    if (l < pyramid.length - 1) {
      // initialize masked region from upsampled coarser result
      const coarse = pyramid[l + 1];
      const up = upsample2(coarse.px, coarse.w, coarse.h, L.w, L.h);
      for (let i = 0, p = 0; i < L.flags.length; i++, p += 4) {
        if (L.origFlags[i]) {
          L.px[p]     = up[p];
          L.px[p + 1] = up[p + 1];
          L.px[p + 2] = up[p + 2];
          L.px[p + 3] = 255;
        }
      }
      // re-flag everything originally masked so the fine level refines it
      L.flags.set(L.origFlags);
    }

    const span = 1 / pyramid.length;
    const base = (pyramid.length - 1 - l) * span;
    await fillLevel(L, R, rng, onProgress, base, span);
  }

  // write back
  const finest = pyramid[0];
  const out = rctx.getImageData(0, 0, W, H);
  out.data.set(finest.px);
  rctx.putImageData(out, 0, 0);
  onProgress?.(1);
  return result;
}

export function maskHasPixels(maskCanvas: HTMLCanvasElement): boolean {
  const ctx = maskCanvas.getContext("2d");
  if (!ctx) return false;
  const data = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 32) return true;
  return false;
}
