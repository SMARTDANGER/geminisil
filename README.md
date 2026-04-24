# geminisil

Browser-only Gemini watermark remover. No uploads, no resolution downscale, no API keys.

## How it works

- Drop an image. Full-resolution copy held on a hidden canvas.
- Auto-detect scans the four corners for Gemini's violet/blue/pink sparkle palette and seeds a mask.
- Refine the mask by brushing over anything the detector missed.
- [OpenCV.js](https://docs.opencv.org/) runs Telea inpainting on the original-resolution pixels.
- Result exported as full-res PNG.

## Run

```bash
npm install
npm run dev
```

## Deploy

Push to a repo, import into Vercel. Framework auto-detects as Next.js. No env vars needed.

## Notes

- OpenCV.js (~8 MB) loads from the official CDN on first use.
- Paste from clipboard works (Ctrl/Cmd + V).
- Output is always PNG to preserve the original pixels in untouched regions.
