"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { inpaintTelea, loadCV } from "@/lib/cv";
import { detectWatermark, type Box } from "@/lib/detect";

type Status = "idle" | "loading-cv" | "ready" | "processing" | "done";

export default function Editor() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef<HTMLCanvasElement>(null);   // what user sees (scaled)
  const maskRef = useRef<HTMLCanvasElement>(null);      // mask overlay (display scale)
  const sourceRef = useRef<HTMLCanvasElement | null>(null); // full-res source
  const fullMaskRef = useRef<HTMLCanvasElement | null>(null); // full-res mask
  const resultRef = useRef<HTMLCanvasElement | null>(null);

  const [status, setStatus] = useState<Status>("idle");
  const [err, setErr] = useState<string | null>(null);
  const [brush, setBrush] = useState(30);
  const [scale, setScale] = useState(1);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [fileName, setFileName] = useState<string>("image");
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  useEffect(() => {
    // warm up OpenCV in background once UI mounts
    loadCV().catch(() => { /* ignore; surfaced on use */ });
  }, []);

  const mount = useCallback(async (file: File) => {
    setErr(null);
    setResultUrl(null);
    setStatus("loading-cv");
    setFileName(file.name.replace(/\.[^.]+$/, ""));

    const bmp = await createImageBitmap(file);
    const full = document.createElement("canvas");
    full.width = bmp.width;
    full.height = bmp.height;
    full.getContext("2d")!.drawImage(bmp, 0, 0);
    sourceRef.current = full;

    const fullMask = document.createElement("canvas");
    fullMask.width = bmp.width;
    fullMask.height = bmp.height;
    fullMaskRef.current = fullMask;

    const wrap = wrapRef.current!;
    const maxW = Math.min(wrap.clientWidth, 1100);
    const maxH = 640;
    const s = Math.min(1, maxW / bmp.width, maxH / bmp.height);
    setScale(s);
    setDims({ w: bmp.width, h: bmp.height });

    const display = displayRef.current!;
    display.width = Math.round(bmp.width * s);
    display.height = Math.round(bmp.height * s);
    display.getContext("2d")!.drawImage(bmp, 0, 0, display.width, display.height);

    const mask = maskRef.current!;
    mask.width = display.width;
    mask.height = display.height;
    mask.getContext("2d")!.clearRect(0, 0, mask.width, mask.height);

    // auto-seed mask with detected watermark box
    try {
      const box = detectWatermark(full);
      paintBox(box);
    } catch {}

    setStatus("ready");
  }, []);

  const paintBox = (box: Box) => {
    const fullMask = fullMaskRef.current!;
    const fctx = fullMask.getContext("2d")!;
    fctx.fillStyle = "white";
    fctx.fillRect(box.x, box.y, box.w, box.h);

    const mask = maskRef.current!;
    const mctx = mask.getContext("2d")!;
    const s = mask.width / fullMask.width;
    mctx.fillStyle = "rgba(139, 92, 246, 0.55)";
    mctx.fillRect(box.x * s, box.y * s, box.w * s, box.h * s);
  };

  const clearMask = () => {
    const mask = maskRef.current;
    const fullMask = fullMaskRef.current;
    if (mask) mask.getContext("2d")!.clearRect(0, 0, mask.width, mask.height);
    if (fullMask) fullMask.getContext("2d")!.clearRect(0, 0, fullMask.width, fullMask.height);
  };

  const paintAt = (clientX: number, clientY: number) => {
    const mask = maskRef.current!;
    const fullMask = fullMaskRef.current!;
    const rect = mask.getBoundingClientRect();
    const x = (clientX - rect.left) * (mask.width / rect.width);
    const y = (clientY - rect.top) * (mask.height / rect.height);
    const r = brush;

    const mctx = mask.getContext("2d")!;
    mctx.fillStyle = "rgba(139, 92, 246, 0.55)";
    mctx.beginPath();
    mctx.arc(x, y, r, 0, Math.PI * 2);
    mctx.fill();

    const fctx = fullMask.getContext("2d")!;
    const inv = fullMask.width / mask.width;
    fctx.fillStyle = "white";
    fctx.beginPath();
    fctx.arc(x * inv, y * inv, r * inv, 0, Math.PI * 2);
    fctx.fill();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrawing(true);
    paintAt(e.clientX, e.clientY);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawing) return;
    paintAt(e.clientX, e.clientY);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    setDrawing(false);
    try { (e.target as Element).releasePointerCapture(e.pointerId); } catch {}
  };

  const run = async () => {
    if (!sourceRef.current || !fullMaskRef.current) return;
    setStatus("processing");
    setErr(null);
    try {
      // dilate mask a touch by drawing brush radius equivalent — already handled by brush.
      const out = await inpaintTelea(sourceRef.current, fullMaskRef.current, 6);
      resultRef.current = out;
      const url = out.toDataURL("image/png");
      setResultUrl(url);
      setStatus("done");
    } catch (e: any) {
      setErr(e?.message || String(e));
      setStatus("ready");
    }
  };

  const reset = () => {
    setResultUrl(null);
    setStatus(sourceRef.current ? "ready" : "idle");
    clearMask();
  };

  const download = () => {
    if (!resultRef.current) return;
    resultRef.current.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${fileName}-clean.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }, "image/png");
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f && f.type.startsWith("image/")) mount(f);
  };

  const onPaste = useCallback((e: ClipboardEvent) => {
    const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith("image/"));
    if (item) {
      const f = item.getAsFile();
      if (f) mount(f);
    }
  }, [mount]);
  useEffect(() => {
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [onPaste]);

  return (
    <div className="space-y-4">
      {status === "idle" && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`border-2 border-dashed rounded-2xl p-16 text-center transition-colors ${
            dragOver ? "border-violet-500 bg-violet-500/5" : "border-neutral-800 bg-panel"
          }`}
        >
          <div className="text-lg mb-2">Drop an image, paste, or pick a file</div>
          <div className="text-sm text-neutral-400 mb-6">
            PNG · JPG · WebP. Original resolution preserved.
          </div>
          <label className="btn btn-primary cursor-pointer">
            Choose image
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) mount(f);
              }}
            />
          </label>
        </div>
      )}

      {status !== "idle" && (
        <div className="bg-panel border border-border rounded-2xl p-4">
          <div className="flex flex-wrap items-center gap-3 mb-4">
            <label className="btn cursor-pointer">
              New image
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) mount(f);
                }}
              />
            </label>

            <div className="flex items-center gap-2 text-sm text-neutral-300">
              <span className="text-neutral-400">Brush</span>
              <input
                type="range"
                min={4}
                max={120}
                value={brush}
                onChange={(e) => setBrush(Number(e.target.value))}
                className="w-32"
              />
              <span className="w-8 text-right tabular-nums">{brush}</span>
            </div>

            <button className="btn" onClick={clearMask} disabled={status === "processing"}>
              Clear mask
            </button>

            <button
              className="btn"
              onClick={() => {
                if (!sourceRef.current) return;
                try {
                  const box = detectWatermark(sourceRef.current);
                  paintBox(box);
                } catch {}
              }}
              disabled={status === "processing"}
            >
              Auto-detect
            </button>

            <div className="grow" />

            <button
              className="btn btn-primary"
              onClick={run}
              disabled={status === "processing" || status === "loading-cv"}
            >
              {status === "loading-cv" && "Loading engine…"}
              {status === "processing" && "Removing…"}
              {(status === "ready" || status === "done") && "Remove watermark"}
            </button>

            {status === "done" && (
              <>
                <button className="btn" onClick={reset}>Edit again</button>
                <button className="btn btn-primary" onClick={download}>Download PNG</button>
              </>
            )}
          </div>

          {err && (
            <div className="mb-3 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              {err}
            </div>
          )}

          <div
            ref={wrapRef}
            className="relative mx-auto rounded-xl overflow-hidden border border-border bg-black/40 flex items-center justify-center"
            style={{ minHeight: 320 }}
          >
            {!resultUrl ? (
              <div className="relative" style={dims ? { width: Math.round(dims.w * scale), height: Math.round(dims.h * scale) } : {}}>
                <canvas ref={displayRef} className="block" />
                <canvas
                  ref={maskRef}
                  className="absolute inset-0 cursor-crosshair touch-none"
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                />
              </div>
            ) : (
              <img
                src={resultUrl}
                alt="result"
                className="max-w-full max-h-[70vh] object-contain"
              />
            )}
          </div>

          <div className="flex justify-between items-center mt-3 text-xs text-neutral-500">
            <span>
              {dims && `${dims.w} × ${dims.h}px`}
              {dims && scale < 1 && `  ·  preview ${Math.round(scale * 100)}%`}
            </span>
            <span>
              {resultUrl ? "Output at full resolution" : "Paint over the logo — tighter mask = cleaner result"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
