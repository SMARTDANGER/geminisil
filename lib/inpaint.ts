// Self-contained inpainting. Chamfer-ordered FMM-lite fill with weighted
// neighborhood average, then a small smoothing pass. Runs fully client-side
// at the source resolution.

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

function chamferDistance(
  flags: Uint8Array,
  w: number,
  h: number
): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = flags[i] ? INF : 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!flags[i]) continue;
      let m = d[i];
      if (x > 0) m = Math.min(m, d[i - 1] + 3);
      if (y > 0) m = Math.min(m, d[i - w] + 3);
      if (x > 0 && y > 0) m = Math.min(m, d[i - w - 1] + 4);
      if (x < w - 1 && y > 0) m = Math.min(m, d[i - w + 1] + 4);
      d[i] = m;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!flags[i]) continue;
      let m = d[i];
      if (x < w - 1) m = Math.min(m, d[i + 1] + 3);
      if (y < h - 1) m = Math.min(m, d[i + w] + 3);
      if (x < w - 1 && y < h - 1) m = Math.min(m, d[i + w + 1] + 4);
      if (x > 0 && y < h - 1) m = Math.min(m, d[i + w - 1] + 4);
      d[i] = m;
    }
  }
  return d;
}

async function fmmFill(
  pixels: Uint8ClampedArray,
  flags: Uint8Array,
  w: number,
  h: number,
  onProgress?: (p: number) => void
): Promise<void> {
  const d = chamferDistance(flags, w, h);

  const maskedIndices: number[] = [];
  for (let i = 0; i < flags.length; i++) if (flags[i]) maskedIndices.push(i);
  maskedIndices.sort((a, b) => d[a] - d[b]);

  const known = new Uint8Array(flags.length);
  for (let i = 0; i < flags.length; i++) known[i] = flags[i] ? 0 : 1;

  const R = 4;
  const total = maskedIndices.length || 1;
  const chunk = Math.max(2000, Math.floor(total / 40));

  for (let k = 0; k < maskedIndices.length; k++) {
    const idx = maskedIndices[k];
    const x = idx % w;
    const y = (idx / w) | 0;

    let rSum = 0, gSum = 0, bSum = 0, wSum = 0;

    for (let dy = -R; dy <= R; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -R; dx <= R; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        if (dx === 0 && dy === 0) continue;
        const j = yy * w + xx;
        if (!known[j]) continue;
        const dist2 = dx * dx + dy * dy;
        if (dist2 > R * R) continue;
        const weight = 1 / (dist2 + 0.5);
        const p = j * 4;
        rSum += pixels[p] * weight;
        gSum += pixels[p + 1] * weight;
        bSum += pixels[p + 2] * weight;
        wSum += weight;
      }
    }

    const p = idx * 4;
    if (wSum > 0) {
      pixels[p] = rSum / wSum;
      pixels[p + 1] = gSum / wSum;
      pixels[p + 2] = bSum / wSum;
      pixels[p + 3] = 255;
    } else {
      pixels[p + 3] = 255;
    }
    known[idx] = 1;

    if (onProgress && k % chunk === 0) {
      onProgress(k / total);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  if (onProgress) onProgress(1);
}

function smoothFilled(
  pixels: Uint8ClampedArray,
  flags: Uint8Array,
  w: number,
  h: number,
  iterations: number
): void {
  const tmp = new Uint8ClampedArray(pixels.length);
  for (let it = 0; it < iterations; it++) {
    tmp.set(pixels);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!flags[i]) continue;
        const p = i * 4;
        let r = 0, g = 0, b = 0, c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const q = ((y + dy) * w + (x + dx)) * 4;
            r += tmp[q]; g += tmp[q + 1]; b += tmp[q + 2]; c++;
          }
        }
        pixels[p] = r / c;
        pixels[p + 1] = g / c;
        pixels[p + 2] = b / c;
      }
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

  let count = 0;
  for (let i = 0; i < flags.length; i++) if (flags[i]) count++;
  if (count === 0) return result;

  const imgData = rctx.getImageData(0, 0, w, h);
  await fmmFill(imgData.data, flags, w, h, onProgress);
  smoothFilled(imgData.data, flags, w, h, 2);
  rctx.putImageData(imgData, 0, 0);
  return result;
}

export function maskHasPixels(maskCanvas: HTMLCanvasElement): boolean {
  const ctx = maskCanvas.getContext("2d");
  if (!ctx) return false;
  const data = ctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 32) return true;
  return false;
}
