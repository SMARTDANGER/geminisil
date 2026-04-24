// Exemplar patch-based inpainting. For each boundary pixel (masked with at
// least one known neighbor) we search a local window for the 9x9 patch that
// best matches the known portion of the target patch, then copy that patch
// into the masked positions. This gives real texture instead of radial smear.
//
// Inspired by Criminisi et al. (2003), simplified:
//   - confidence-ordered boundary processing
//   - fully-known source patches only (expanding search radius)
//   - greedy SSD match with early termination
//   - averaging fallback for patches with no valid source

export interface InpaintOptions {
  srcCanvas: HTMLCanvasElement;
  maskCanvas: HTMLCanvasElement;
  onProgress?: (p: number) => void;
}

function buildMaskFlags(
  maskCtx: CanvasRenderingContext2D,
  w: number,
  h: number
): Uint8Array {
  const mData = maskCtx.getImageData(0, 0, w, h).data;
  const flags = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < mData.length; i += 4, p++) {
    flags[p] = mData[i + 3] > 32 ? 1 : 0;
  }
  return flags;
}

function findBoundary(flags: Uint8Array, w: number, h: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!flags[i]) continue;
      const hasKnownNb =
        (x > 0 && !flags[i - 1]) ||
        (x < w - 1 && !flags[i + 1]) ||
        (y > 0 && !flags[i - w]) ||
        (y < h - 1 && !flags[i + w]);
      if (hasKnownNb) out.push(i);
    }
  }
  return out;
}

function patchConfidence(
  flags: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  R: number
): number {
  let known = 0;
  let total = 0;
  for (let dy = -R; dy <= R; dy++) {
    const yy = cy + dy;
    if (yy < 0 || yy >= h) continue;
    for (let dx = -R; dx <= R; dx++) {
      const xx = cx + dx;
      if (xx < 0 || xx >= w) continue;
      total++;
      if (!flags[yy * w + xx]) known++;
    }
  }
  return total > 0 ? known / total : 0;
}

function searchBestPatch(
  px: Uint8ClampedArray,
  flags: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  R: number,
  SR: number,
  stride: number
): { bx: number; by: number; err: number } | null {
  let bestErr = Infinity;
  let bestX = -1;
  let bestY = -1;

  const xmin = Math.max(R, cx - SR);
  const xmax = Math.min(w - R - 1, cx + SR);
  const ymin = Math.max(R, cy - SR);
  const ymax = Math.min(h - R - 1, cy + SR);

  for (let sy = ymin; sy <= ymax; sy += stride) {
    for (let sx = xmin; sx <= xmax; sx += stride) {
      if (sx === cx && sy === cy) continue;

      // require source patch fully in known region
      let sourceValid = true;
      for (let dy = -R; dy <= R && sourceValid; dy++) {
        const row = (sy + dy) * w;
        for (let dx = -R; dx <= R; dx++) {
          if (flags[row + sx + dx]) {
            sourceValid = false;
            break;
          }
        }
      }
      if (!sourceValid) continue;

      // SSD over target's KNOWN positions only
      let err = 0;
      let overlap = 0;
      let aborted = false;
      for (let dy = -R; dy <= R && !aborted; dy++) {
        const ty = cy + dy;
        if (ty < 0 || ty >= h) continue;
        const srcRow = (sy + dy) * w;
        const tgtRow = ty * w;
        for (let dx = -R; dx <= R; dx++) {
          const tx = cx + dx;
          if (tx < 0 || tx >= w) continue;
          const ti = tgtRow + tx;
          if (flags[ti]) continue;
          const si = srcRow + sx + dx;
          const tp = ti << 2;
          const sp = si << 2;
          const rd = px[tp] - px[sp];
          const gd = px[tp + 1] - px[sp + 1];
          const bd = px[tp + 2] - px[sp + 2];
          err += rd * rd + gd * gd + bd * bd;
          overlap++;
          if (err >= bestErr) {
            aborted = true;
            break;
          }
        }
      }
      if (!aborted && overlap > 0 && err < bestErr) {
        bestErr = err;
        bestX = sx;
        bestY = sy;
      }
    }
  }

  if (bestX < 0) return null;
  return { bx: bestX, by: bestY, err: bestErr };
}

function findBestPatch(
  px: Uint8ClampedArray,
  flags: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  R: number
): { bx: number; by: number } | null {
  // expanding search: local first (cheap + preserves texture locality),
  // then wider if no fully-known patch nearby.
  const schedule: Array<[number, number]> = [
    [48, 2],
    [128, 3],
    [320, 4],
    [Math.max(w, h), 6],
  ];
  for (const [SR, stride] of schedule) {
    const r = searchBestPatch(px, flags, w, h, cx, cy, R, SR, stride);
    if (r) return r;
  }
  return null;
}

function copyPatch(
  px: Uint8ClampedArray,
  flags: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  sx: number,
  sy: number,
  R: number
): number {
  let filled = 0;
  for (let dy = -R; dy <= R; dy++) {
    const ty = cy + dy;
    if (ty < 0 || ty >= h) continue;
    const srcRow = (sy + dy) * w;
    const tgtRow = ty * w;
    for (let dx = -R; dx <= R; dx++) {
      const tx = cx + dx;
      if (tx < 0 || tx >= w) continue;
      const ti = tgtRow + tx;
      if (!flags[ti]) continue; // preserve known pixels
      const si = srcRow + sx + dx;
      const tp = ti << 2;
      const sp = si << 2;
      px[tp] = px[sp];
      px[tp + 1] = px[sp + 1];
      px[tp + 2] = px[sp + 2];
      px[tp + 3] = 255;
      flags[ti] = 0;
      filled++;
    }
  }
  return filled;
}

function fillAvg(
  px: Uint8ClampedArray,
  flags: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
  R: number
): number {
  // weighted average of known neighbors. Used only when no valid source patch
  // exists (rare, only for patches wedged inside very large masked regions).
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
      const RR = 4;
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
          rSum += px[np] * weight;
          gSum += px[np + 1] * weight;
          bSum += px[np + 2] * weight;
          wSum += weight;
        }
      }
      if (wSum > 0) {
        const tp = ti << 2;
        px[tp] = rSum / wSum;
        px[tp + 1] = gSum / wSum;
        px[tp + 2] = bSum / wSum;
        px[tp + 3] = 255;
        flags[ti] = 0;
        filled++;
      }
    }
  }
  return filled;
}

function edgeBlend(
  px: Uint8ClampedArray,
  origFlags: Uint8Array,
  w: number,
  h: number
): void {
  // one-pass 3x3 Gaussian-ish blur confined to masked region to soften seams
  // between copied patches. Only runs on pixels that were originally masked.
  const tmp = new Uint8ClampedArray(px.length);
  tmp.set(px);
  const kernel = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!origFlags[i]) continue;
      let r = 0, g = 0, b = 0, wSum = 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const q = ((y + dy) * w + (x + dx)) << 2;
          const kv = kernel[k++];
          r += tmp[q] * kv;
          g += tmp[q + 1] * kv;
          b += tmp[q + 2] * kv;
          wSum += kv;
        }
      }
      const p = i << 2;
      px[p] = r / wSum;
      px[p + 1] = g / wSum;
      px[p + 2] = b / wSum;
    }
  }
}

export async function runInpaint(
  opts: InpaintOptions
): Promise<HTMLCanvasElement> {
  const { srcCanvas, maskCanvas, onProgress } = opts;
  const w = srcCanvas.width;
  const h = srcCanvas.height;

  const result = document.createElement("canvas");
  result.width = w;
  result.height = h;
  const rctx = result.getContext("2d", { willReadFrequently: true })!;
  rctx.drawImage(srcCanvas, 0, 0);

  const mctx = maskCanvas.getContext("2d", { willReadFrequently: true })!;
  const flags = buildMaskFlags(mctx, w, h);

  let remaining = 0;
  for (let i = 0; i < flags.length; i++) if (flags[i]) remaining++;
  if (!remaining) return result;
  const initialRemaining = remaining;

  const origFlags = new Uint8Array(flags);

  const imgData = rctx.getImageData(0, 0, w, h);
  const px = imgData.data;

  const R = 4;

  let stuckWaves = 0;
  let wave = 0;
  while (remaining > 0 && stuckWaves < 3 && wave < 50) {
    wave++;
    const boundary = findBoundary(flags, w, h);
    if (!boundary.length) break;

    const scored: Array<{ idx: number; c: number }> = boundary.map((idx) => ({
      idx,
      c: patchConfidence(flags, w, h, idx % w, (idx / w) | 0, R),
    }));
    scored.sort((a, b) => b.c - a.c);

    const before = remaining;
    let processed = 0;
    for (const s of scored) {
      if (!flags[s.idx]) continue;
      const cx = s.idx % w;
      const cy = (s.idx / w) | 0;
      const best = findBestPatch(px, flags, w, h, cx, cy, R);
      if (best) {
        remaining -= copyPatch(px, flags, w, h, cx, cy, best.bx, best.by, R);
      } else {
        remaining -= fillAvg(px, flags, w, h, cx, cy, R);
      }
      processed++;
      if (processed % 48 === 0) {
        onProgress?.(1 - remaining / initialRemaining);
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    if (remaining >= before) stuckWaves++;
    else stuckWaves = 0;

    onProgress?.(1 - remaining / initialRemaining);
    await new Promise((r) => setTimeout(r, 0));
  }

  edgeBlend(px, origFlags, w, h);
  rctx.putImageData(imgData, 0, 0);
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
