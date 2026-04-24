"use client";

import { useEffect, useState } from "react";
import { I } from "./Icons";
import { formatBytes } from "@/lib/utils";

type Fmt = "png" | "jpg" | "webp";

export default function ExportModal({
  canvas,
  baseName,
  onClose,
  pushToast,
}: {
  canvas: HTMLCanvasElement;
  baseName: string;
  onClose: () => void;
  pushToast: (msg: string, kind?: "info" | "success" | "error") => void;
}) {
  const [format, setFormat] = useState<Fmt>("png");
  const [quality, setQuality] = useState(92);
  const [estimatedSize, setEstimatedSize] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const mime =
      format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
    canvas.toBlob(
      (blob) => {
        if (cancelled) return;
        setEstimatedSize(blob ? blob.size : 0);
      },
      mime,
      quality / 100
    );
    return () => {
      cancelled = true;
    };
  }, [format, quality, canvas]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function doDownload() {
    const mime =
      format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
    const blob: Blob | null = await new Promise((res) =>
      canvas.toBlob(res, mime, quality / 100)
    );
    if (!blob) {
      pushToast("Export failed", "error");
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const cleanName = (baseName || "image").replace(/\.[^.]+$/, "");
    a.download = `${cleanName}-fixed.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    pushToast("Downloaded!", "success");
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="modal-head">
          <h3>Export your fix</h3>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <I.x />
          </button>
        </div>
        <div className="modal-body">
          <div className="export-grid">
            <div className="export-field">
              <label>Format</label>
              <div className="segmented">
                <button className={format === "png" ? "active" : ""} onClick={() => setFormat("png")}>
                  PNG
                </button>
                <button className={format === "jpg" ? "active" : ""} onClick={() => setFormat("jpg")}>
                  JPG
                </button>
                <button className={format === "webp" ? "active" : ""} onClick={() => setFormat("webp")}>
                  WebP
                </button>
              </div>
            </div>
            <div className="export-field">
              <label>
                Quality{" "}
                {format === "png" && (
                  <span style={{ color: "var(--ink-3)", fontWeight: 500 }}>(lossless)</span>
                )}
              </label>
              <div
                className="slider-row"
                style={{
                  pointerEvents: format === "png" ? "none" : "auto",
                  opacity: format === "png" ? 0.45 : 1,
                }}
              >
                <input
                  type="range"
                  min={30}
                  max={100}
                  value={quality}
                  onChange={(e) => setQuality(parseInt(e.target.value, 10))}
                />
              </div>
              <div
                style={{
                  fontFamily: "var(--fs-mono)",
                  fontSize: 11,
                  color: "var(--ink-3)",
                  textAlign: "right",
                }}
              >
                {quality}%
              </div>
            </div>
          </div>

          <div className="export-info">
            <span className="label">Dimensions</span>
            <span className="value">
              {canvas.width} × {canvas.height}
            </span>
          </div>
          <div className="export-info" style={{ marginTop: 6 }}>
            <span className="label">Estimated size</span>
            <span className="value">{estimatedSize != null ? formatBytes(estimatedSize) : "…"}</span>
          </div>

          <div className="tip" style={{ marginTop: 16 }}>
            <div className="ico">✨</div>
            <div>Full resolution. No watermark. Saved straight to your computer.</div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn accent" onClick={doDownload}>
            <I.download /> Download
          </button>
        </div>
      </div>
    </div>
  );
}
