// OpenCV.js loader — singleton promise, loaded from CDN on demand.
declare global {
  interface Window {
    cv: any;
    Module: any;
  }
}

let cvPromise: Promise<any> | null = null;

export function loadCV(): Promise<any> {
  if (typeof window === "undefined") return Promise.reject(new Error("SSR"));
  if (window.cv && window.cv.Mat) return Promise.resolve(window.cv);
  if (cvPromise) return cvPromise;

  cvPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById("opencv-js") as HTMLScriptElement | null;
    const onReady = () => {
      const tryInit = () => {
        if (window.cv && window.cv.Mat) return resolve(window.cv);
        if (window.cv && typeof window.cv.then === "function") {
          window.cv.then((cv: any) => resolve(cv));
          return;
        }
        if (window.cv) {
          window.cv["onRuntimeInitialized"] = () => resolve(window.cv);
          return;
        }
        setTimeout(tryInit, 50);
      };
      tryInit();
    };
    if (existing) {
      onReady();
      return;
    }
    const s = document.createElement("script");
    s.id = "opencv-js";
    s.src = "https://docs.opencv.org/4.10.0/opencv.js";
    s.async = true;
    s.onload = onReady;
    s.onerror = () => reject(new Error("Failed to load OpenCV.js"));
    document.body.appendChild(s);
  });
  return cvPromise;
}

export async function inpaintTelea(
  imgCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  radius = 5
): Promise<HTMLCanvasElement> {
  const cv = await loadCV();

  const src = cv.imread(imgCanvas);
  const maskRGBA = cv.imread(maskCanvas);
  const mask = new cv.Mat();
  cv.cvtColor(maskRGBA, mask, cv.COLOR_RGBA2GRAY);
  cv.threshold(mask, mask, 10, 255, cv.THRESH_BINARY);

  const srcRGB = new cv.Mat();
  cv.cvtColor(src, srcRGB, cv.COLOR_RGBA2RGB);

  const dst = new cv.Mat();
  cv.inpaint(srcRGB, mask, dst, radius, cv.INPAINT_TELEA);

  const out = new cv.Mat();
  cv.cvtColor(dst, out, cv.COLOR_RGB2RGBA);

  const outCanvas = document.createElement("canvas");
  outCanvas.width = imgCanvas.width;
  outCanvas.height = imgCanvas.height;
  cv.imshow(outCanvas, out);

  src.delete();
  maskRGBA.delete();
  mask.delete();
  srcRGB.delete();
  dst.delete();
  out.delete();

  return outCanvas;
}
