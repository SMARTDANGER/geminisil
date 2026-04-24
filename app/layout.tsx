import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "geminisil — Gemini watermark remover",
  description: "Remove Gemini's logo from images at full resolution. No upload, no quality loss.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
