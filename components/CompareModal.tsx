"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { I } from "./Icons";
import { clamp } from "@/lib/utils";

export default function CompareModal({
  before,
  after,
  onClose,
}: {
  before: HTMLCanvasElement | null;
  after: HTMLCanvasElement | null;
  onClose: () => void;
}) {
  const [pct, setPct] = useState(50);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(false);

  const beforeUrl = useMemo(() => (before ? before.toDataURL("image/png") : ""), [before]);
  const afterUrl = useMemo(() => (after ? after.toDataURL("image/png") : ""), [after]);

  const onMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!dragRef.current || !wrapRef.current) return;
    const r = wrapRef.current.getBoundingClientRect();
    const clientX =
      (e as MouseEvent).clientX ?? (e as TouchEvent).touches?.[0]?.clientX ?? 0;
    setPct(clamp(((clientX - r.left) / r.width) * 100, 0, 100));
  }, []);
  const onUp = useCallback(() => {
    dragRef.current = false;
  }, []);

  useEffect(() => {
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("touchmove", onMove);
    window.addEventListener("touchend", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
    };
  }, [onMove, onUp]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 880 }}>
        <div className="modal-head">
          <h3>Before &amp; after</h3>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <I.x />
          </button>
        </div>
        <div className="modal-body">
          <div className="compare" ref={wrapRef}>
            {beforeUrl && <img src={beforeUrl} alt="before" />}
            {afterUrl && (
              <img
                src={afterUrl}
                alt="after"
                className="compare-after-img"
                style={{ clipPath: `inset(0 ${100 - pct}% 0 0)` }}
              />
            )}
            <div
              className="compare-handle"
              style={{ left: `${pct}%` }}
              onMouseDown={() => (dragRef.current = true)}
              onTouchStart={() => (dragRef.current = true)}
            />
            <div className="compare-tag before">Before</div>
            <div className="compare-tag after">After</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13, color: "var(--ink-2)" }}>
            <span>Drag the handle to compare</span>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
