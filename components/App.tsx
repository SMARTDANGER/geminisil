"use client";

import { useCallback, useEffect, useState } from "react";
import { I } from "./Icons";
import Landing from "./Landing";
import Editor from "./Editor";

type Theme = "light" | "dark";
type Toast = { id: string; msg: string; kind: "info" | "success" | "error" };

const THEME_KEY = "easyfixup:theme";

export default function App() {
  const [theme, setTheme] = useState<Theme>("dark");
  const [file, setFile] = useState<File | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // hydrate theme from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY) as Theme | null;
      if (saved === "light" || saved === "dark") setTheme(saved);
    } catch {}
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {}
  }, [theme]);

  const pushToast = useCallback(
    (msg: string, kind: "info" | "success" | "error" = "info") => {
      const id = Math.random().toString(36).slice(2);
      setToasts((t) => [...t, { id, msg, kind }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2800);
    },
    []
  );

  const step = file ? 2 : 1;

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">
          <div className="logo-mark">
            <svg
              width={14}
              height={14}
              viewBox="0 0 24 24"
              fill="none"
              stroke="#1A1527"
              strokeWidth={2.8}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
            </svg>
          </div>
          easy<em>fixup</em>
        </div>

        <div className="topbar-center">
          <div className={`tb-crumb ${step === 1 ? "active" : "done"}`}>
            <span className="n">{step > 1 ? <I.check /> : 1}</span>
            Upload
          </div>
          <div className={`tb-crumb ${step === 2 ? "active" : ""}`}>
            <span className="n">2</span>
            Clean up
          </div>
          <div className="tb-crumb">
            <span className="n">3</span>
            Export
          </div>
        </div>

        <div className="topbar-right">
          <button
            className="btn ghost icon-only"
            title={theme === "light" ? "Switch to dark" : "Switch to light"}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            {theme === "light" ? <I.moon /> : <I.sun />}
          </button>
          {file && (
            <button className="btn" onClick={() => setFile(null)}>
              <I.image /> New image
            </button>
          )}
        </div>
      </header>

      {!file && <Landing onFile={setFile} onToast={pushToast} />}
      {file && (
        <Editor
          key={file.name + file.size + file.lastModified}
          file={file}
          defaultTool="brush"
          defaultBrushSize={51}
          onExit={() => setFile(null)}
          pushToast={pushToast}
        />
      )}

      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === "success" && <I.check />}
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
