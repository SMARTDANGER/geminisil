// Heuristic detector for Gemini's sparkle watermark.
// Gemini renders a small colorful 4-point star near a corner (usually bottom-right)
// on a light/neutral background strip. We scan the four corners and score the
// region that contains the most saturated blue→purple→pink pixels — Gemini's palette.

export type Box = { x: number; y: number; w: number; h: number };

export function detectWatermark(img: HTMLCanvasElement): Box {
  const W = img.width;
  const H = img.height;
  // probe region ~18% of the shorter edge, clamped to reasonable bounds
  const s = Math.max(60, Math.min(320, Math.round(Math.min(W, H) * 0.18)));
  const ctx = img.getContext("2d", { willReadFrequently: true })!;

  const corners: Box[] = [
    { x: W - s, y: H - s, w: s, h: s }, // bottom-right (most common)
    { x: 0,     y: H - s, w: s, h: s }, // bottom-left
    { x: W - s, y: 0,     w: s, h: s }, // top-right
    { x: 0,     y: 0,     w: s, h: s }, // top-left
  ];

  let best = corners[0];
  let bestScore = -1;
  let bestTight: Box | null = null;

  for (const c of corners) {
    const data = ctx.getImageData(c.x, c.y, c.w, c.h).data;
    let score = 0;
    let minX = c.w, minY = c.h, maxX = 0, maxY = 0, count = 0;
    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w; x++) {
        const i = (y * c.w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        // Gemini palette: violet/blue/pink. High B or (R & B) with low G.
        const isGemini =
          (b > 140 && b > g + 25 && r > 90) || // purple/pink
          (b > 170 && r < b && g < b);         // blue
        if (isGemini) {
          score++;
          count++;
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
      if (count > 20) {
        const pad = Math.round(s * 0.12);
        bestTight = {
          x: c.x + Math.max(0, minX - pad),
          y: c.y + Math.max(0, minY - pad),
          w: Math.min(c.w, maxX - minX + pad * 2),
          h: Math.min(c.h, maxY - minY + pad * 2),
        };
      }
    }
  }

  if (bestTight && bestScore > 30) return bestTight;

  // Fallback: bottom-right strip sized by image.
  const fw = Math.round(W * 0.14);
  const fh = Math.round(H * 0.08);
  return {
    x: W - fw - Math.round(W * 0.01),
    y: H - fh - Math.round(H * 0.01),
    w: fw,
    h: fh,
  };
}
