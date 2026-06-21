import * as ort from 'onnxruntime-web';
import type { RGB } from '@/lib/inpaint/maskFill';

// comic-text-detector（dmMaze，manga-image-translator/mokuro 同款）：漫画专用文字检测。
// 模型同时输出 blk（文字块检测框）与 seg（逐像素文字概率图，[1,1,1024,1024]）。
// blk 给出按气泡分好的块级框；seg 用于精准取色（只在笔画像素上采样）与精准擦除（按笔画蒙版）。
// 算法已在 Node 原型验证（scripts/test-detector.mjs、scripts/test-seg-color.mjs）。
const getPublicUrl = browser.runtime.getURL as (path: string) => string;
ort.env.wasm.wasmPaths = getPublicUrl('/ort/');
ort.env.wasm.numThreads = 1;

const SIZE = 1024;
const CONF = 0.4; // 块置信度阈值
const IOU = 0.35; // NMS 阈值
const ANCHORS = 64512;
const STRIDE = 7; // blk 每行 [cx,cy,w,h,obj,cls0,cls1]

const SEG_TH_MASK = 0.3; // 文字区域阈值：用于擦除蒙版与取色圈定文字区域（含底+笔画）
const INK_DIST = 55; // 笔画与区域底色的最小色距
const MASK_DILATE = 2; // 擦除蒙版膨胀半径，覆盖笔画边缘的反锯齿

export interface DetBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 源图坐标 → 概率图坐标的映射：segX = round(ox*ratioX + padX)，segY 同理。
 *  日语 comic seg 是 1024 等比 letterbox；英/韩 PaddleOCR det 用动态尺寸（ratioX≠ratioY、无 pad）。 */
export interface Letterbox {
  ratioX: number;
  ratioY: number;
  padX: number;
  padY: number;
  segW: number;
  segH: number;
}

export interface DetResult {
  boxes: DetBox[];
  /** 逐像素文字概率图（letterbox 1024×1024），模型无此输出时为 null。 */
  seg: Float32Array | null;
  lb: Letterbox;
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const res = await fetch(getPublicUrl('/manga-ocr/detector.onnx'));
      if (!res.ok) throw new Error(`加载漫画检测模型失败（${res.status}）`);
      const buf = await res.arrayBuffer();
      return ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
    })().catch((error: unknown) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

/** 跑检测模型，返回块级文字框 + seg 概率图 + letterbox 映射。 */
export async function detect(src: HTMLCanvasElement): Promise<DetResult> {
  const session = await getSession();
  const w = src.width;
  const h = src.height;
  const ratio = Math.min(SIZE / w, SIZE / h);
  const nw = Math.round(w * ratio);
  const nh = Math.round(h * ratio);
  const padX = Math.floor((SIZE - nw) / 2);
  const padY = Math.floor((SIZE - nh) / 2);
  const lb: Letterbox = { ratioX: ratio, ratioY: ratio, padX, padY, segW: SIZE, segH: SIZE };

  // letterbox 到 1024（灰边 114），与训练/导出一致
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建画布上下文');
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(src, 0, 0, w, h, padX, padY, nw, nh);
  const data = ctx.getImageData(0, 0, SIZE, SIZE).data;

  const plane = SIZE * SIZE;
  const inp = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    inp[i] = (data[i * 4] ?? 0) / 255;
    inp[plane + i] = (data[i * 4 + 1] ?? 0) / 255;
    inp[2 * plane + i] = (data[i * 4 + 2] ?? 0) / 255;
  }

  const out = await session.run({ images: new ort.Tensor('float32', inp, [1, 3, SIZE, SIZE]) });
  const seg = (out.seg?.data as Float32Array | undefined) ?? null;
  const blk = out.blk?.data as Float32Array | undefined;
  if (!blk) return { boxes: [], seg, lb };

  const candidates: Cand[] = [];
  for (let i = 0; i < ANCHORS; i++) {
    const obj = blk[i * STRIDE + 4]!;
    if (obj <= CONF) continue;
    const cx = blk[i * STRIDE]!;
    const cy = blk[i * STRIDE + 1]!;
    const bw = blk[i * STRIDE + 2]!;
    const bh = blk[i * STRIDE + 3]!;
    candidates.push({
      x1: cx - bw / 2,
      y1: cy - bh / 2,
      x2: cx + bw / 2,
      y2: cy + bh / 2,
      score: obj,
    });
  }

  const boxes = nms(candidates).map((b) => {
    const x = Math.max(0, Math.round((b.x1 - padX) / ratio));
    const y = Math.max(0, Math.round((b.y1 - padY) / ratio));
    return {
      x,
      y,
      w: Math.min(Math.round((b.x2 - b.x1) / ratio), w - x),
      h: Math.min(Math.round((b.y2 - b.y1) / ratio), h - y),
    };
  });
  return { boxes, seg, lb };
}

/** 源图坐标 (ox,oy) 处的 seg 文字概率。 */
function segAt(seg: Float32Array, lb: Letterbox, ox: number, oy: number): number {
  const lx = Math.round(ox * lb.ratioX + lb.padX);
  const ly = Math.round(oy * lb.ratioY + lb.padY);
  if (lx < 0 || ly < 0 || lx >= lb.segW || ly >= lb.segH) return 0;
  return seg[ly * lb.segW + lx] ?? 0;
}

/**
 * 用 seg 蒙版精准取原文笔画色（seg 是「文字区域 mask」，含底色+笔画）：
 * 底色 = 区域内众数(面积最大)；笔画 = 偏离底色的像素里「最偏离的一端」的众数。
 * 白底→底白→取最黑、深底→底深→取最亮，永远与背景对比、不取反（杜绝白底白字/黑底黑字）；
 * 取「最偏离端」而非全体众数，避免半透明字的中间调把颜色拉灰。
 * 见 scripts/test-seg-color.mjs 在 5 张图验证（白底黑字纯黑、粉字保留）。
 */
export function inkColorFromSeg(
  img: Uint8ClampedArray,
  imgW: number,
  box: DetBox,
  seg: Float32Array,
  lb: Letterbox,
): RGB | null {
  const px: Array<[number, number, number]> = [];
  const x2 = box.x + box.w;
  const y2 = box.y + box.h;
  for (let oy = box.y; oy < y2; oy++) {
    for (let ox = box.x; ox < x2; ox++) {
      if (segAt(seg, lb, ox, oy) <= SEG_TH_MASK) continue; // 文字区域（低阈值，含底+笔画）
      const i = (oy * imgW + ox) * 4;
      px.push([img[i] ?? 0, img[i + 1] ?? 0, img[i + 2] ?? 0]);
    }
  }
  if (px.length < 12) return null;
  const base = mode(px);
  if (!base) return null;
  const cand = px
    .map((p): [number, number, number, number] => [
      p[0],
      p[1],
      p[2],
      Math.hypot(p[0] - base[0], p[1] - base[1], p[2] - base[2]),
    ])
    .filter((p) => p[3] > INK_DIST)
    .sort((a, b) => b[3] - a[3]);
  if (cand.length < 8) return null;
  const top = cand.slice(0, Math.max(8, Math.floor(cand.length * 0.4)));
  const c = mode(top.map((p): [number, number, number] => [p[0], p[1], p[2]]));
  return c ? { r: Math.round(c[0]), g: Math.round(c[1]), b: Math.round(c[2]) } : null;
}

/** 量化众数主色（每通道 16 级），返回该桶均值。 */
function mode(px: Array<[number, number, number]>): [number, number, number] | null {
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (const [r, g, b] of px) {
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const a = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    a.r += r;
    a.g += g;
    a.b += b;
    a.n++;
    buckets.set(key, a);
  }
  let best = { r: 0, g: 0, b: 0, n: 0 };
  for (const a of buckets.values()) if (a.n > best.n) best = a;
  return best.n ? [best.r / best.n, best.g / best.n, best.b / best.n] : null;
}

/**
 * 生成整图文字蒙版（PNG dataURL，白=文字笔画）：仅在检测框内、seg>阈值的像素标白并轻膨胀，
 * 供回填时精准擦除原文笔画（不动笔画外的画面）。无 seg 时返回 null。
 */
export function buildTextMaskDataUrl(
  imgW: number,
  imgH: number,
  boxes: DetBox[],
  seg: Float32Array,
  lb: Letterbox,
): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = imgW;
  canvas.height = imgH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const out = ctx.createImageData(imgW, imgH);
  const d = out.data;
  for (const box of boxes) {
    const x2 = box.x + box.w;
    const y2 = box.y + box.h;
    for (let oy = box.y; oy < y2; oy++) {
      for (let ox = box.x; ox < x2; ox++) {
        if (segAt(seg, lb, ox, oy) <= SEG_TH_MASK) continue;
        for (let dy = -MASK_DILATE; dy <= MASK_DILATE; dy++) {
          const py = oy + dy;
          if (py < 0 || py >= imgH) continue;
          for (let dx = -MASK_DILATE; dx <= MASK_DILATE; dx++) {
            const pxx = ox + dx;
            if (pxx < 0 || pxx >= imgW) continue;
            const j = (py * imgW + pxx) * 4;
            d[j] = 255;
            d[j + 1] = 255;
            d[j + 2] = 255;
            d[j + 3] = 255;
          }
        }
      }
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas.toDataURL('image/png');
}

interface Cand {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
}

function nms(boxes: Cand[]): Cand[] {
  boxes.sort((a, b) => b.score - a.score);
  const keep: Cand[] = [];
  for (const b of boxes) {
    if (!keep.some((k) => iou(b, k) > IOU)) keep.push(b);
  }
  return keep;
}

function iou(a: Cand, b: Cand): number {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return inter / (union || 1);
}
