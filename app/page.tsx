import Editor from "@/components/Editor";

export default function Page() {
  return (
    <main className="min-h-screen glow">
      <div className="max-w-6xl mx-auto px-6 py-10">
        <header className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 flex items-center justify-center font-bold">g</div>
            <div>
              <h1 className="text-xl font-semibold">geminisil</h1>
              <p className="text-xs text-neutral-400">Gemini watermark remover · full res · no upload</p>
            </div>
          </div>
          <a
            href="https://github.com"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-neutral-400 hover:text-white"
          >
            source
          </a>
        </header>
        <Editor />
        <footer className="mt-12 text-center text-xs text-neutral-500">
          All processing runs in your browser. Images never leave your device.
        </footer>
      </div>
    </main>
  );
}
