import * as ort from 'onnxruntime-web/webgpu';
import type {
  Bbox,
  LamaInpaintRequest,
  LamaInpaintResponse,
  PaddleOcrRequest,
  PaddleOcrResponse,
} from '@/lib/offscreen/protocol';
import { runPaddleOcr } from '@/lib/offscreen/paddleOcr';

// LaMa 修复模型（512x512 固定输入）。首次使用下载并缓存到 Cache Storage。
const MODEL_URL = 'https://huggingface.co/g-ronimo/lama/resolve/main/lama_fp32.onnx';
const MODEL_CACHE = 'wt-lama-model';
const SIZE = 512;

// getURL 的类型限定为已知 public 路径，这里指向运行时 wasm 目录，做一次安全转换。
const getPublicUrl = browser.runtime.getURL as (path: string) => string;
ort.env.wasm.wasmPaths = getPublicUrl('/ort/');
ort.env.wasm.numThreads = 1; // 避免依赖 SharedArrayBuffer（扩展页非跨源隔离）

let sessionPromise: Promise<ort.InferenceSession> | null = null;

// 复用的 512 画布，避免每个文字块重复创建。
const tileCanvas = makeCanvas();
const outCanvas = makeCanvas();
const tileCtx = get2d(tileCanvas);
const outCtx = get2d(outCanvas);

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const request = message as Partial<LamaInpaintRequest>;
  if (request?.target !== 'offscreen' || request.type !== 'lama-inpaint') return false;
  inpaintAll(request.imageDataUrl ?? '', request.boxes ?? [])
    .then((dataUrl) => sendResponse({ ok: true, dataUrl } satisfies LamaInpaintResponse))
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies LamaInpaintResponse);
    });
  return true;
});

// 本地 PaddleOCR 识别请求
browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const request = message as Partial<PaddleOcrRequest>;
  if (request?.target !== 'offscreen' || request.type !== 'paddle-ocr') return false;
  runPaddleOcr(request.imageDataUrl ?? '', request.lang ?? 'multi')
    .then(({ lines, maskDataUrl }) =>
      sendResponse({ ok: true, lines, maskDataUrl } satisfies PaddleOcrResponse),
    )
    .catch((error: unknown) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies PaddleOcrResponse);
    });
  return true;
});

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) sessionPromise = createSession();
  return sessionPromise;
}

async function createSession(): Promise<ort.InferenceSession> {
  const buffer = await loadModel();
  // 优先 WebGPU，失败回退 wasm(CPU)
  try {
    return await ort.InferenceSession.create(buffer, { executionProviders: ['webgpu'] });
  } catch {
    return await ort.InferenceSession.create(buffer, { executionProviders: ['wasm'] });
  }
}

async function loadModel(): Promise<ArrayBuffer> {
  const cache = await caches.open(MODEL_CACHE);
  let response = await cache.match(MODEL_URL);
  if (!response) {
    response = await fetch(MODEL_URL);
    if (!response.ok) throw new Error(`下载 LaMa 模型失败 ${response.status}`);
    await cache.put(MODEL_URL, response.clone());
  }
  return response.arrayBuffer();
}

/** 在整图上逐文字块做局部修复，返回擦除后的图片 data URL。 */
async function inpaintAll(imageDataUrl: string, boxes: Bbox[]): Promise<string> {
  if (!imageDataUrl) throw new Error('缺少图片数据');
  const session = await getSession();
  const image = await loadImage(imageDataUrl);
  const canvas = makeCanvas(image.naturalWidth, image.naturalHeight);
  const ctx = get2d(canvas);
  ctx.drawImage(image, 0, 0);

  for (const box of boxes) {
    await inpaintRegion(ctx, box, session);
  }
  return canvas.toDataURL('image/png');
}

async function inpaintRegion(
  ctx: CanvasRenderingContext2D,
  box: Bbox,
  session: ort.InferenceSession,
): Promise<void> {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const bw = box[2] - box[0];
  const bh = box[3] - box[1];
  if (bw <= 0 || bh <= 0) return;

  // 取包含文字块、带余量的裁剪区域，缩放到 512 做修复
  const margin = Math.round(Math.max(bw, bh) * 0.5) + 8;
  const cx1 = clamp(Math.round(box[0] - margin), 0, W);
  const cy1 = clamp(Math.round(box[1] - margin), 0, H);
  const cx2 = clamp(Math.round(box[2] + margin), 0, W);
  const cy2 = clamp(Math.round(box[3] + margin), 0, H);
  const cw = cx2 - cx1;
  const ch = cy2 - cy1;
  if (cw <= 0 || ch <= 0) return;

  tileCtx.clearRect(0, 0, SIZE, SIZE);
  tileCtx.drawImage(ctx.canvas, cx1, cy1, cw, ch, 0, 0, SIZE, SIZE);
  const tile = tileCtx.getImageData(0, 0, SIZE, SIZE).data;

  // 文字框在 512 tile 中的范围 → mask
  const mx1 = clamp(Math.round(((box[0] - cx1) / cw) * SIZE), 0, SIZE);
  const my1 = clamp(Math.round(((box[1] - cy1) / ch) * SIZE), 0, SIZE);
  const mx2 = clamp(Math.round(((box[2] - cx1) / cw) * SIZE), 0, SIZE);
  const my2 = clamp(Math.round(((box[3] - cy1) / ch) * SIZE), 0, SIZE);

  const plane = SIZE * SIZE;
  const imageData = new Float32Array(3 * plane);
  const maskData = new Float32Array(plane);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x;
      const p = i * 4;
      imageData[i] = (tile[p] ?? 0) / 255;
      imageData[plane + i] = (tile[p + 1] ?? 0) / 255;
      imageData[2 * plane + i] = (tile[p + 2] ?? 0) / 255;
      maskData[i] = x >= mx1 && x < mx2 && y >= my1 && y < my2 ? 1 : 0;
    }
  }

  const feeds: Record<string, ort.Tensor> = {
    image: new ort.Tensor('float32', imageData, [1, 3, SIZE, SIZE]),
    mask: new ort.Tensor('float32', maskData, [1, 1, SIZE, SIZE]),
  };
  const results = await session.run(feeds);
  const outputName = session.outputNames[0];
  if (!outputName) throw new Error('LaMa 无输出');
  const out = results[outputName]?.data as Float32Array | undefined;
  if (!out) throw new Error('LaMa 输出为空');

  // 兼容 0~1 与 0~255 两种输出范围
  let maxValue = 0;
  for (let i = 0; i < out.length; i++) maxValue = Math.max(maxValue, out[i] ?? 0);
  const scale = maxValue > 1.5 ? 1 : 255;

  const result = outCtx.createImageData(SIZE, SIZE);
  for (let i = 0; i < plane; i++) {
    result.data[i * 4] = toByte((out[i] ?? 0) * scale);
    result.data[i * 4 + 1] = toByte((out[plane + i] ?? 0) * scale);
    result.data[i * 4 + 2] = toByte((out[2 * plane + i] ?? 0) * scale);
    result.data[i * 4 + 3] = 255;
  }
  outCtx.putImageData(result, 0, 0);

  // 仅把文字框区域贴回原图（全分辨率），不动周围像素
  ctx.drawImage(outCanvas, mx1, my1, mx2 - mx1, my2 - my1, box[0], box[1], bw, bh);
}

function makeCanvas(width = SIZE, height = SIZE): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function get2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建画布上下文');
  return ctx;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = src;
  });
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

function toByte(v: number): number {
  return Math.min(255, Math.max(0, Math.round(v)));
}
