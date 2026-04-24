"use client";

import { useCallback, useRef, useState, type CSSProperties } from "react";
import { I } from "./Icons";

type DoodleStyle = CSSProperties & { "--r"?: string };

function Doodle({
  className,
  style,
  children,
}: {
  className: string;
  style?: DoodleStyle;
  children: React.ReactNode;
}) {
  return (
    <div className={`doodle ${className}`} style={style as CSSProperties}>
      {children}
    </div>
  );
}

export default function Landing({
  onFile,
  onToast,
}: {
  onFile: (f: File) => void;
  onToast: (msg: string, kind?: "info" | "success" | "error") => void;
}) {
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const pick = useCallback(
    (file?: File | null) => {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        onToast("Please choose an image file", "error");
        return;
      }
      onFile(file);
    },
    [onFile, onToast]
  );

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    pick(e.dataTransfer.files?.[0]);
  };

  return (
    <div className="landing">
      <div className="hero">
        <Doodle className="d1" style={{ "--r": "-8deg" }}>
          <svg width={44} height={44} viewBox="0 0 44 44" fill="none">
            <circle cx={22} cy={22} r={14} fill="#FFE066" stroke="#1A1527" strokeWidth={2.5} />
            <circle cx={18} cy={20} r={2} fill="#1A1527" />
            <circle cx={26} cy={20} r={2} fill="#1A1527" />
            <path d="M17 26c1.5 2 3 3 5 3s3.5-1 5-3" stroke="#1A1527" strokeWidth={2.5} strokeLinecap="round" />
          </svg>
        </Doodle>
        <Doodle className="d2" style={{ "--r": "12deg" }}>
          <svg width={52} height={52} viewBox="0 0 52 52" fill="none">
            <path
              d="M26 6 L32 20 L46 22 L36 32 L38 46 L26 40 L14 46 L16 32 L6 22 L20 20 Z"
              fill="#FF8FB1"
              stroke="#1A1527"
              strokeWidth={2.5}
              strokeLinejoin="round"
            />
          </svg>
        </Doodle>
        <Doodle className="d3" style={{ "--r": "-15deg" }}>
          <svg width={48} height={48} viewBox="0 0 48 48" fill="none">
            <rect x={8} y={8} width={32} height={32} rx={8} fill="#4ECDC4" stroke="#1A1527" strokeWidth={2.5} />
            <path d="M16 24l6 6 12-14" stroke="#1A1527" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </Doodle>
        <Doodle className="d4" style={{ "--r": "10deg" }}>
          <svg width={56} height={56} viewBox="0 0 56 56" fill="none">
            <circle cx={28} cy={28} r={18} fill="#A78BFA" stroke="#1A1527" strokeWidth={2.5} />
            <circle cx={28} cy={28} r={9} fill="#FFF8F0" stroke="#1A1527" strokeWidth={2.5} />
            <circle cx={28} cy={28} r={3} fill="#1A1527" />
          </svg>
        </Doodle>

        <div className="hero-kicker">
          <span className="dot" />
          100% private · works offline · no uploads
        </div>

        <h1>
          Remove anything<br />
          <span className="swash">pesky</span> from your pics.
        </h1>
        <p>
          Brush over watermarks, logos, timestamps, tourists — easyfixup fills them in,
          keeps every pixel, and never touches your original resolution.
        </p>

        <div
          className={`dropzone ${drag ? "drag" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          onClick={() => fileInput.current?.click()}
          style={{ cursor: "pointer" }}
        >
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={(e) => pick(e.target.files?.[0])}
          />
          <div className="dropzone-inner">
            <div className="dz-icon">
              <I.upload />
            </div>
            <div>
              <div className="dz-title">Drop an image or click to browse</div>
              <div className="dz-sub" style={{ marginTop: 6 }}>
                Works with every resolution — 4K, 8K, huge scans. Nothing ever leaves your device.
              </div>
            </div>
            <div className="dz-formats">
              <span>PNG</span>
              <span>JPG</span>
              <span>WebP</span>
              <span>GIF</span>
              <span>BMP</span>
            </div>
          </div>
        </div>

        <div className="features">
          <div className="feature">
            <div
              className="feature-ic"
              style={{ background: "color-mix(in oklab, var(--coral) 15%, transparent)", color: "var(--coral-ink)" }}
            >
              <I.bolt />
            </div>
            <h3>Full resolution</h3>
            <p>No downscaling. Ever. 4K stays 4K. 8K stays 8K.</p>
          </div>
          <div className="feature">
            <div
              className="feature-ic"
              style={{ background: "color-mix(in oklab, var(--mint) 18%, transparent)", color: "var(--mint-ink)" }}
            >
              <I.shield />
            </div>
            <h3>Private by design</h3>
            <p>Everything runs in your browser. Zero uploads.</p>
          </div>
          <div className="feature">
            <div
              className="feature-ic"
              style={{ background: "color-mix(in oklab, var(--mango) 25%, transparent)", color: "var(--mango-ink)" }}
            >
              <I.sparkle />
            </div>
            <h3>Brush, don&apos;t guess</h3>
            <p>Paint over what you don&apos;t want. It fills in the rest.</p>
          </div>
          <div className="feature">
            <div
              className="feature-ic"
              style={{ background: "color-mix(in oklab, var(--grape) 20%, transparent)", color: "var(--grape-ink)" }}
            >
              <I.heart />
            </div>
            <h3>Actually free</h3>
            <p>No watermarks on output. No sign-up. No limits.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
