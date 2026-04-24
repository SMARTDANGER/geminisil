"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as RPE,
  type MouseEvent as RME,
  type WheelEvent as RWE,
} from "react";
import { I } from "./Icons";
import {
  clamp,
  cloneCanvas,
  fileToImage,
  imgToCanvas,
} from "@/lib/utils";
import { runInpaint, maskHasPixels } from "@/lib/inpaint";
import CompareModal from "./CompareModal";
import ExportModal from "./ExportModal";

type Tool = "brush" | "eraser" | "hand";
type HistoryEntry = { snapshot: HTMLCanvasElement; label: string; time: number };

const HISTORY_MAX = 30;

export default function Editor({
  file,
  defaultTool,
  defaultBrushSize,
  onExit,
  pushToast,
}: {
  file: File;
  defaultTool: Tool;
  defaultBrushSize: number;
  onExit: () => void;
  pushToast: (msg: string, kind?: "info" | "success" | "error") => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const stageElRef = useRef<HTMLDivElement>(null);

  const imgCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cursorCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const [meta, setMeta] = useState({ w: 0, h: 0, name: "" });
  const [loaded, setLoaded] = useState(false);

  const [tool, setTool] = useState<Tool>(defaultTool);
  const [brushSize, setBrushSize] = useState(defaultBrushSize);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const [processing, setProcessing] = useState<{ progress: number; label: string } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);

  const [compareOpen, setCompareOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  // refs mirror live zoom/pan/tool/brush for drawing handlers
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const toolRef = useRef(tool);
  const brushSizeRef = useRef(brushSize);
  zoomRef.current = zoom;
  panRef.current = pan;
  toolRef.current = tool;
  brushSizeRef.current = brushSize;

  const fitToStage = useCallback(() => {
    const stage = stageElRef.current;
    if (!stage || !meta.w) return;
    const pad = 60;
    const sw = stage.clientWidth - pad;
    const sh = stage.clientHeight - pad;
    const z = Math.min(sw / meta.w, sh / meta.h, 1);
    setZoom(z);
    setPan({ x: 0, y: 0 });
  }, [meta.w, meta.h]);

  // --- load the file ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { img, url } = await fileToImage(file);
      if (cancelled) {
        URL.revokeObjectURL(url);
        return;
      }
      objectUrlRef.current = url;
      const base = imgToCanvas(img);

      const display = document.createElement("canvas");
      display.width = base.width;
      display.height = base.height;
      display.className = "img-canvas";
      display.getContext("2d")!.drawImage(base, 0, 0);
      imgCanvasRef.current = display;

      const mask = document.createElement("canvas");
      mask.width = base.width;
      mask.height = base.height;
      mask.className = "mask-canvas";
      maskCanvasRef.current = mask;

      const cur = document.createElement("canvas");
      cur.width = base.width;
      cur.height = base.height;
      cur.className = "cursor-canvas";
      cursorCanvasRef.current = cur;

      setMeta({ w: base.width, h: base.height, name: file.name });
      setHistory([{ snapshot: cloneCanvas(base), label: "Original", time: Date.now() }]);
      setHistoryIdx(0);
      setLoaded(true);

      requestAnimationFrame(() => {
        const frame = frameRef.current;
        if (!frame) return;
        frame.innerHTML = "";
        frame.style.width = base.width + "px";
        frame.style.height = base.height + "px";
        frame.appendChild(display);
        frame.appendChild(mask);
        frame.appendChild(cur);

        // fit to stage
        const stage = stageElRef.current;
        if (stage) {
          const pad = 60;
          const z = Math.min(
            (stage.clientWidth - pad) / base.width,
            (stage.clientHeight - pad) / base.height,
            1
          );
          setZoom(z);
          setPan({ x: 0, y: 0 });
        }
      });
    })();
    return () => {
      cancelled = true;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [file]);

  // --- drawing coords ---
  function clientToImageCoords(clientX: number, clientY: number) {
    const frame = frameRef.current!;
    const rect = frame.getBoundingClientRect();
    const z = zoomRef.current;
    return { x: (clientX - rect.left) / z, y: (clientY - rect.top) / z };
  }

  const drawing = useRef(false);
  const lastPt = useRef<{ x: number; y: number } | null>(null);
  const panning = useRef<{ startX: number; startY: number; startPan: { x: number; y: number } } | null>(null);

  function drawBrushStroke(
    ctx: CanvasRenderingContext2D,
    from: { x: number; y: number },
    to: { x: number; y: number },
    radius: number,
    erase: boolean
  ) {
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = radius * 2;
    if (erase) {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(255, 107, 107, 1)";
    }
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  function drawBrushCursor(clientX: number, clientY: number) {
    const c = cursorCanvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    const t = toolRef.current;
    if (t !== "brush" && t !== "eraser") return;
    const pt = clientToImageCoords(clientX, clientY);
    ctx.save();
    ctx.lineWidth = 1.5 / zoomRef.current;
    ctx.strokeStyle = t === "eraser" ? "rgba(78, 205, 196, 1)" : "rgba(255, 107, 107, 1)";
    ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, brushSizeRef.current / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function onStageDown(e: RME<HTMLDivElement>) {
    if (!loaded) return;
    const t = toolRef.current;
    if (e.button === 1 || t === "hand" || e.altKey) {
      panning.current = {
        startX: e.clientX,
        startY: e.clientY,
        startPan: { ...panRef.current },
      };
      e.preventDefault();
      return;
    }
    if (t === "brush" || t === "eraser") {
      const mc = maskCanvasRef.current;
      if (!mc) return;
      drawing.current = true;
      const pt = clientToImageCoords(e.clientX, e.clientY);
      lastPt.current = pt;
      const ctx = mc.getContext("2d")!;
      const r = brushSizeRef.current / 2;
      ctx.globalCompositeOperation = t === "eraser" ? "destination-out" : "source-over";
      ctx.fillStyle = "rgba(255, 107, 107, 1)";
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function onStageMove(e: RME<HTMLDivElement>) {
    if (panning.current) {
      const dx = e.clientX - panning.current.startX;
      const dy = e.clientY - panning.current.startY;
      setPan({
        x: panning.current.startPan.x + dx,
        y: panning.current.startPan.y + dy,
      });
      return;
    }
    drawBrushCursor(e.clientX, e.clientY);
    if (!drawing.current) return;
    const mc = maskCanvasRef.current;
    if (!mc) return;
    const pt = clientToImageCoords(e.clientX, e.clientY);
    const ctx = mc.getContext("2d")!;
    drawBrushStroke(ctx, lastPt.current!, pt, brushSizeRef.current / 2, toolRef.current === "eraser");
    lastPt.current = pt;
  }

  function onStageUp() {
    drawing.current = false;
    panning.current = null;
  }

  // global mouseup safety (for release outside stage)
  useEffect(() => {
    const up = () => onStageUp();
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  function onWheel(e: RWE<HTMLDivElement>) {
    if (!loaded) return;
    const delta = -e.deltaY;
    const factor = Math.exp(delta * 0.0015);
    const cur = zoomRef.current;
    const newZoom = clamp(cur * factor, 0.05, 16);

    const stage = stageElRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const cx = e.clientX - rect.left - rect.width / 2;
    const cy = e.clientY - rect.top - rect.height / 2;
    const scaleRatio = newZoom / cur;
    setPan((prev) => ({
      x: cx - (cx - prev.x) * scaleRatio,
      y: cy - (cy - prev.y) * scaleRatio,
    }));
    setZoom(newZoom);
  }

  // prevent page scroll during wheel-zoom over the stage
  useEffect(() => {
    const el = stageElRef.current;
    if (!el) return;
    const prevent = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", prevent, { passive: false });
    return () => el.removeEventListener("wheel", prevent);
  }, []);

  // --- undo / redo ---
  const pushHistory = useCallback(
    (label: string) => {
      const img = imgCanvasRef.current;
      if (!img) return;
      const snap = cloneCanvas(img);
      setHistory((h) => {
        const trimmed = h.slice(0, historyIdx + 1);
        trimmed.push({ snapshot: snap, label, time: Date.now() });
        return trimmed.slice(-HISTORY_MAX);
      });
      setHistoryIdx((i) => Math.min(i + 1, HISTORY_MAX - 1));
    },
    [historyIdx]
  );

  const jumpTo = useCallback(
    (idx: number) => {
      if (idx < 0 || idx >= history.length) return;
      const snap = history[idx].snapshot;
      const img = imgCanvasRef.current;
      if (!img) return;
      const ctx = img.getContext("2d")!;
      ctx.clearRect(0, 0, snap.width, snap.height);
      ctx.drawImage(snap, 0, 0);
      const mc = maskCanvasRef.current;
      if (mc) mc.getContext("2d")!.clearRect(0, 0, mc.width, mc.height);
      setHistoryIdx(idx);
    },
    [history]
  );

  const undo = useCallback(() => {
    if (historyIdx > 0) jumpTo(historyIdx - 1);
  }, [historyIdx, jumpTo]);
  const redo = useCallback(() => {
    if (historyIdx < history.length - 1) jumpTo(historyIdx + 1);
  }, [history.length, historyIdx, jumpTo]);

  const clearMask = useCallback(() => {
    const mc = maskCanvasRef.current;
    if (mc) mc.getContext("2d")!.clearRect(0, 0, mc.width, mc.height);
  }, []);

  // --- run inpaint ---
  const runFix = useCallback(async () => {
    const img = imgCanvasRef.current;
    const mc = maskCanvasRef.current;
    if (!loaded || !img || !mc) return;
    if (!maskHasPixels(mc)) {
      pushToast("Brush over what you want to remove first", "error");
      return;
    }
    setProcessing({ progress: 0, label: "Analyzing pixels…" });
    try {
      const result = await runInpaint({
        srcCanvas: img,
        maskCanvas: mc,
        onProgress: (p) => {
          const label =
            p < 0.3 ? "Analyzing pixels…" : p < 0.75 ? "Reconstructing texture…" : "Smoothing edges…";
          setProcessing({ progress: p, label });
        },
      });
      const ctx = img.getContext("2d")!;
      ctx.clearRect(0, 0, img.width, img.height);
      ctx.drawImage(result, 0, 0);
      pushHistory("Cleanup");
      clearMask();
      pushToast("Cleaned up!", "success");
    } catch (err) {
      console.error(err);
      pushToast("Something went wrong", "error");
    } finally {
      setProcessing(null);
    }
  }, [loaded, pushHistory, clearMask, pushToast]);

  // --- hotkeys ---
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as Element | null;
      if (target && target.matches("input, textarea, select")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }
      if (e.key === "b") setTool("brush");
      if (e.key === "e") setTool("eraser");
      if (e.key === "h" || e.key === " ") {
        if (!e.repeat) setTool("hand");
      }
      if (e.key === "[") setBrushSize((s) => Math.max(2, Math.round(s * 0.8)));
      if (e.key === "]") setBrushSize((s) => Math.min(400, Math.round(s / 0.8)));
      if (e.key === "0") fitToStage();
      if (e.key === "Enter") runFix();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, fitToStage, runFix]);

  // `-50%` is applied BEFORE scale so the centering offset scales with the zoom.
  // (`translate(-50%)` uses the element's *unscaled* size; if it's outermost, a
  // zoom < 1 overshoots and shoves the image to the top-left.)
  const frameTransform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) translate(-50%, -50%)`;

  const wrapCursor =
    tool === "hand" ? (panning.current ? "grabbing" : "grab") : "none";

  return (
    <div className="editor">
      {/* Tool rail */}
      <div className="toolrail">
        <button
          className={`tool ${tool === "brush" ? "active" : ""}`}
          onClick={() => setTool("brush")}
          title="Brush (B)"
        >
          <I.brush />
          <span className="kbd">B</span>
        </button>
        <button
          className={`tool ${tool === "eraser" ? "active" : ""}`}
          onClick={() => setTool("eraser")}
          title="Eraser (E)"
        >
          <I.eraser />
          <span className="kbd">E</span>
        </button>
        <button
          className={`tool ${tool === "hand" ? "active" : ""}`}
          onClick={() => setTool("hand")}
          title="Pan (H / Space)"
        >
          <I.hand />
          <span className="kbd">H</span>
        </button>
        <div className="divider" />
        <button className="tool" onClick={undo} disabled={historyIdx <= 0} title="Undo (⌘Z)">
          <I.undo />
        </button>
        <button
          className="tool"
          onClick={redo}
          disabled={historyIdx >= history.length - 1}
          title="Redo (⌘⇧Z)"
        >
          <I.redo />
        </button>
        <div className="divider" />
        <button className="tool" onClick={fitToStage} title="Fit (0)">
          <I.fit />
        </button>
        <div style={{ flex: 1 }} />
        <button className="tool" onClick={onExit} title="New image">
          <I.home />
        </button>
      </div>

      {/* Canvas stage */}
      <div
        className="canvas-wrap"
        ref={stageElRef}
        onWheel={onWheel}
        onMouseDown={onStageDown}
        onMouseMove={onStageMove}
        onMouseUp={onStageUp}
        onMouseLeave={() => {
          onStageUp();
          const c = cursorCanvasRef.current;
          if (c) c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
        }}
        style={{ cursor: wrapCursor }}
      >
        {loaded && (
          <div className="canvas-status">
            <span className="fn">
              {meta.w} × {meta.h}
            </span>
            <span>·</span>
            <span>{meta.name.length > 32 ? meta.name.slice(0, 29) + "…" : meta.name}</span>
          </div>
        )}

        {loaded && (
          <div className="canvas-action">
            <button className="btn" onClick={() => setCompareOpen(true)} disabled={historyIdx <= 0}>
              <I.eye /> Compare
            </button>
            <button className="btn accent" onClick={runFix}>
              <I.sparkle /> Clean up
            </button>
            <button className="btn primary" onClick={() => setExportOpen(true)}>
              <I.download /> Export
            </button>
          </div>
        )}

        <div
          className="canvas-stage"
          style={{ left: "50%", top: "50%", width: 0, height: 0, position: "absolute" }}
        >
          <div
            ref={frameRef}
            className="canvas-frame"
            style={{ transform: frameTransform, position: "absolute" }}
          />
        </div>

        {loaded && (
          <div className="canvas-hud">
            <button
              className="hud-btn"
              onClick={() => setZoom((z) => clamp(z / 1.25, 0.05, 16))}
            >
              <I.minus />
            </button>
            <div className="hud-zoom">{Math.round(zoom * 100)}%</div>
            <button
              className="hud-btn"
              onClick={() => setZoom((z) => clamp(z * 1.25, 0.05, 16))}
            >
              <I.plus />
            </button>
            <div style={{ width: 1, height: 20, background: "var(--line)", margin: "0 4px" }} />
            <button className="hud-btn" onClick={fitToStage}>
              <I.fit /> Fit
            </button>
            <button
              className="hud-btn"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
            >
              100%
            </button>
          </div>
        )}

        {processing && (
          <div className="processing">
            <div className="processing-card">
              <div className="spinner" />
              <h4>Working magic</h4>
              <p>{processing.label}</p>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.round(processing.progress * 100)}%` }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Inspector */}
      <div className="inspector">
        <div className="insp-section">
          <div className="insp-head">
            <h3>
              Brush <span className="chip">{tool}</span>
            </h3>
          </div>

          <div className="brush-preview">
            <div
              className="brush-dot"
              style={{
                width: clamp(brushSize / 2, 10, 46),
                height: clamp(brushSize / 2, 10, 46),
              }}
            />
            <div className="brush-info">
              <strong>{brushSize} px</strong>
              Paint over the thing you want gone.
            </div>
          </div>

          <div className="field">
            <label>
              Size <span className="val">{brushSize}px</span>
            </label>
            <div className="slider-row">
              <input
                type="range"
                min={2}
                max={300}
                value={brushSize}
                onChange={(e) => setBrushSize(parseInt(e.target.value, 10))}
              />
            </div>
          </div>

          <div className="field">
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" style={{ flex: 1 }} onClick={clearMask}>
                Clear mask
              </button>
              <button className="btn accent" style={{ flex: 1 }} onClick={runFix}>
                <I.sparkle /> Clean
              </button>
            </div>
          </div>

          <div className="tip">
            <div className="ico">💡</div>
            <div>
              Use <b>[</b> and <b>]</b> to resize fast. Hold <b>Alt</b> or press <b>H</b> to pan.
            </div>
          </div>
        </div>

        <div className="insp-section">
          <div className="insp-head">
            <h3>History</h3>
            <div style={{ display: "flex", gap: 4 }}>
              <button className="iconbtn" onClick={undo} disabled={historyIdx <= 0}>
                <I.undo />
              </button>
              <button
                className="iconbtn"
                onClick={redo}
                disabled={historyIdx >= history.length - 1}
              >
                <I.redo />
              </button>
            </div>
          </div>
          <div className="history-list">
            {history.map((h, idx) => (
              <div
                key={idx}
                className={`history-item ${idx === historyIdx ? "current" : ""} ${
                  idx > historyIdx ? "future" : ""
                }`}
                onClick={() => jumpTo(idx)}
              >
                <span className="history-dot" />
                <span>{h.label}</span>
                <span className="history-time">{idx === 0 ? "start" : `step ${idx}`}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="insp-section">
          <div className="insp-head">
            <h3>Image</h3>
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--ink-3)",
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: "6px 12px",
            }}
          >
            <span>Dimensions</span>
            <span
              style={{
                fontFamily: "var(--fs-mono)",
                color: "var(--ink)",
                fontWeight: 700,
              }}
            >
              {meta.w} × {meta.h}
            </span>
            <span>File name</span>
            <span
              style={{
                color: "var(--ink)",
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {meta.name}
            </span>
            <span>Steps</span>
            <span style={{ color: "var(--ink)", fontWeight: 600 }}>
              {historyIdx} / {history.length - 1}
            </span>
          </div>
        </div>
      </div>

      {compareOpen && (
        <CompareModal
          before={history[0]?.snapshot ?? null}
          after={imgCanvasRef.current}
          onClose={() => setCompareOpen(false)}
        />
      )}
      {exportOpen && imgCanvasRef.current && (
        <ExportModal
          canvas={imgCanvasRef.current}
          baseName={meta.name}
          onClose={() => setExportOpen(false)}
          pushToast={pushToast}
        />
      )}
    </div>
  );
}
