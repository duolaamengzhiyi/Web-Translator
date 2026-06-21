import * as ort from 'onnxruntime-web';
import type { DetBox } from './comicDetector';

// PaddleOCR det + rec（PP-OCRv5）直接用 onnxruntime-web 跑，绕过 ppu 库。仅用于「识别」：
// detLines 在 comic 块 crop 内做行级检测分行，recLine 逐行 CTC 识别。
// 取色/擦除统一用 comic seg（PaddleOCR det 整图会误检漫画背景→擦除涂抹）。算法见 scripts/render-tests.mjs。
const getPublicUrl = browser.runtime.getURL as (path: string) => string;
ort.env.wasm.wasmPaths = getPublicUrl('/ort/');
ort.env.wasm.numThreads = 1;

const DET_LIMIT = 1536; // det 最长边上限（保持比例、对齐 32）
const DET_TH = 0.3; // det 概率二值化阈值
const PAD_H = 0.6; // 行框横向膨胀（含完整笔画给 rec）
const PAD_V = 0.4; // 行框纵向膨胀
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export type RecLang = 'multi' | 'korean';

let detPromise: Promise<ort.InferenceSession> | null = null;
const recPromises = new Map<RecLang, Promise<ort.InferenceSession>>();
const dictCache = new Map<RecLang, string[]>();

function getDet(): Promise<ort.InferenceSession> {
  if (!detPromise) {
    detPromise = createSession('/paddleocr/det.ort').catch((e: unknown) => {
      detPromise = null;
      throw e;
    });
  }
  return detPromise;
}
function getRec(lang: RecLang): Promise<ort.InferenceSession> {
  let p = recPromises.get(lang);
  if (!p) {
    const path = lang === 'korean' ? '/paddleocr/rec_korean.onnx' : '/paddleocr/rec_multi.onnx';
    p = createSession(path).catch((e: unknown) => {
      recPromises.delete(lang);
      throw e;
    });
    recPromises.set(lang, p);
  }
  return p;
}
async function getDict(lang: RecLang): Promise<string[]> {
  let d = dictCache.get(lang);
  if (!d) {
    const path = lang === 'korean' ? '/paddleocr/dict_korean.txt' : '/paddleocr/dict_multi.txt';
    const res = await fetch(getPublicUrl(path));
    if (!res.ok) throw new Error(`加载 OCR 词表失败 ${path}（${res.status}）`);
    d = (await res.text()).split('\n').map((l) => l.replace(/\r$/, ''));
    dictCache.set(lang, d);
  }
  return d;
}
async function createSession(path: string): Promise<ort.InferenceSession> {
  const res = await fetch(getPublicUrl(path));
  if (!res.ok) throw new Error(`加载 OCR 模型失败 ${path}（${res.status}）`);
  return ort.InferenceSession.create(await res.arrayBuffer(), { executionProviders: ['wasm'] });
}

/** PaddleOCR DBNet 行级检测（动态尺寸）：在 comic 块 crop 内分行，返回行框。 */
export async function detLines(src: HTMLCanvasElement): Promise<DetBox[]> {
  const w = src.width;
  const h = src.height;
  // PP-OCR det 动态尺寸：保持比例缩到 limit、对齐 32（不 letterbox，宽/高图都不损失分辨率）。
  const scale = Math.min(1, DET_LIMIT / Math.max(w, h));
  const rw = Math.max(32, Math.round((w * scale) / 32) * 32);
  const rh = Math.max(32, Math.round((h * scale) / 32) * 32);

  const canvas = document.createElement('canvas');
  canvas.width = rw;
  canvas.height = rh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建画布上下文');
  ctx.drawImage(src, 0, 0, w, h, 0, 0, rw, rh);
  const data = ctx.getImageData(0, 0, rw, rh).data;

  const n = rw * rh;
  const inp = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    inp[i] = ((data[i * 4] ?? 0) / 255 - MEAN[0]!) / STD[0]!;
    inp[n + i] = ((data[i * 4 + 1] ?? 0) / 255 - MEAN[1]!) / STD[1]!;
    inp[2 * n + i] = ((data[i * 4 + 2] ?? 0) / 255 - MEAN[2]!) / STD[2]!;
  }
  const session = await getDet();
  const out = await session.run({ x: new ort.Tensor('float32', inp, [1, 3, rh, rw]) });
  const probName = session.outputNames[0]!;
  const prob = out[probName]?.data as Float32Array;
  if (!prob) throw new Error('PaddleOCR det 无输出');

  const sx = w / rw;
  const sy = h / rh;
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = prob[i]! > DET_TH ? 1 : 0;
  return connectedComponents(bin, rw, rh)
    .filter((c) => c.size >= 20)
    .map((c) => {
      let x = Math.max(0, c.minx * sx);
      let y = Math.max(0, c.miny * sy);
      let bw = (c.maxx - c.minx + 1) * sx;
      let bh = (c.maxy - c.miny + 1) * sy;
      x = Math.max(0, x - (bw * PAD_H) / 2);
      y = Math.max(0, y - (bh * PAD_V) / 2);
      bw = Math.min(w - x, bw * (1 + PAD_H));
      bh = Math.min(h - y, bh * (1 + PAD_V));
      return { x: Math.round(x), y: Math.round(y), w: Math.round(bw), h: Math.round(bh) };
    })
    .filter((b) => b.w >= 6 && b.h >= 6)
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** PaddleOCR rec：单行 crop → CRNN + CTC 贪心解码。 */
export async function recLine(crop: HTMLCanvasElement, lang: RecLang): Promise<string> {
  const session = await getRec(lang);
  const dict = await getDict(lang);
  const H = 48;
  const W = Math.max(16, Math.min(1600, Math.round((H * crop.width) / crop.height)));
  const tmp = document.createElement('canvas');
  tmp.width = W;
  tmp.height = H;
  const tctx = tmp.getContext('2d', { willReadFrequently: true });
  if (!tctx) throw new Error('无法创建画布上下文');
  tctx.drawImage(crop, 0, 0, crop.width, crop.height, 0, 0, W, H);
  const data = tctx.getImageData(0, 0, W, H).data;

  const n = W * H;
  const a = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    a[i] = ((data[i * 4] ?? 0) / 255 - 0.5) / 0.5;
    a[n + i] = ((data[i * 4 + 1] ?? 0) / 255 - 0.5) / 0.5;
    a[2 * n + i] = ((data[i * 4 + 2] ?? 0) / 255 - 0.5) / 0.5;
  }
  const out = await session.run({ x: new ort.Tensor('float32', a, [1, 3, H, W]) });
  const o = out[session.outputNames[0]!];
  if (!o) return '';
  const T = o.dims[1]!;
  const C = o.dims[2]!;
  const d = o.data as Float32Array;
  let last = -1;
  let text = '';
  for (let t = 0; t < T; t++) {
    let bi = 0;
    let bv = -Infinity;
    const off = t * C;
    for (let c = 0; c < C; c++) {
      const v = d[off + c]!;
      if (v > bv) {
        bv = v;
        bi = c;
      }
    }
    if (bi !== 0 && bi !== last) text += dict[bi] ?? ''; // blank=0；class c → dict[c]
    last = bi;
  }
  return text.trim();
}

interface Comp {
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
  size: number;
}
function connectedComponents(bin: Uint8Array, W: number, H: number): Comp[] {
  const labels = new Int32Array(W * H);
  const comps: Comp[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (bin[start] === 0 || labels[start] !== 0) continue;
    const id = comps.length + 1;
    let minx = W,
      miny = H,
      maxx = 0,
      maxy = 0,
      size = 0;
    stack.push(start);
    labels[start] = id;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W;
      const y = (p / W) | 0;
      if (x < minx) minx = x;
      if (x > maxx) maxx = x;
      if (y < miny) miny = y;
      if (y > maxy) maxy = y;
      size++;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (bin[q] === 1 && labels[q] === 0) {
            labels[q] = id;
            stack.push(q);
          }
        }
    }
    comps.push({ minx, miny, maxx, maxy, size });
  }
  return comps;
}
