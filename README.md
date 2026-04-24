# easyfixup

Browser-only image cleanup. Brush over watermarks, logos, timestamps, tourists — they get filled in at the original resolution. No uploads. No sign-up. No watermarks on output.

## How it works

- Drop an image. Full-resolution copy held on a hidden canvas.
- Paint a mask over what you want gone.
- A chamfer-ordered FMM-lite inpainter fills the masked pixels using weighted neighborhoods, followed by a short smoothing pass.
- Export as PNG / JPG / WebP at the original resolution.

Everything runs client-side. Nothing ever leaves the device.

## Run

```bash
npm install
npm run dev
```

## Deploy

Push the repo to GitHub and import it into Vercel. Framework auto-detects as Next.js. No env vars.

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `B` / `E` / `H` | Brush / Eraser / Pan |
| `[` / `]` | Shrink / Grow brush |
| `0` | Fit image to stage |
| `Enter` | Run cleanup |
| `⌘Z` / `⌘⇧Z` | Undo / Redo |
| Space or Alt + drag | Pan |
| Wheel | Zoom to cursor |
