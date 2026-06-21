import type { PaddleOcrLang, PaddleOcrLineDto } from './protocol';
import { recognizeManga } from './mangaOcr';
import { detect, inkColorFromSeg, buildTextMaskDataUrl, type DetBox } from './comicDetector';
import { detLines, recLine, type RecLang } from './paddleEngine';

// 本地视觉链路（按语言分流，都用 onnxruntime-web 在 offscreen 跑）：
// - 日语(manga)：comic-text-detector 块级框 + manga-ocr 识别。
// - 英/韩(multi/korean)：comic-text-detector 块级框 + 块内 PaddleOCR det 分行 + rec 识别。
// 两条路的检测/取色/擦除统一用 comic-text-detector 的 seg（漫画专用、不误检背景），
// 故笔画级精准擦除只动原文、不留矩形遮挡（PaddleOCR det 整图会误检漫画背景→涂抹，故只用它识别）。
// 见 comicDetector.inkColorFromSeg/buildTextMaskDataUrl；算法在 scripts/render-tests.mjs 验证。

export interface LocalOcrResult {
  lines: PaddleOcrLineDto[];
  maskDataUrl?: string;
}

/** 在 offscreen 文档里跑本地视觉链路，返回文字行（含原文色）+ 整图擦除蒙版。 */
export async function runPaddleOcr(
  imageDataUrl: string,
  lang: PaddleOcrLang,
): Promise<LocalOcrResult> {
  if (!imageDataUrl) throw new Error('缺少图片数据');
  const canvas = await toCanvas(imageDataUrl);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建画布上下文');
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return lang === 'manga' ? runManga(canvas, imgData) : runPaddle(canvas, imgData, lang);
}

/** 日语：comic-text-detector 块级框 + manga-ocr 识别 + seg 精准取色/擦除。 */
async function runManga(
  canvas: HTMLCanvasElement,
  imgData: Uint8ClampedArray,
): Promise<LocalOcrResult> {
  const { boxes, seg, lb } = await detect(canvas);
  const lines: PaddleOcrLineDto[] = [];
  const keptBoxes: DetBox[] = [];
  for (const box of boxes) {
    if (box.w < 6 || box.h < 6) continue;
    const text = (await recognizeManga(cropCanvas(canvas, box))).trim();
    if (!text) continue;
    const color = seg
      ? (inkColorFromSeg(imgData, canvas.width, box, seg, lb) ?? undefined)
      : undefined;
    lines.push({ text, bbox: [box.x, box.y, box.x + box.w, box.y + box.h], color });
    keptBoxes.push(box);
  }
  const maskDataUrl =
    seg && keptBoxes.length
      ? (buildTextMaskDataUrl(canvas.width, canvas.height, keptBoxes, seg, lb) ?? undefined)
      : undefined;
  return { lines, maskDataUrl };
}

/** 英/韩：comic 检测块 + seg（干净不误检）；块内用 PaddleOCR det 分行 + rec 识别。 */
async function runPaddle(
  canvas: HTMLCanvasElement,
  imgData: Uint8ClampedArray,
  lang: RecLang,
): Promise<LocalOcrResult> {
  const { boxes, seg, lb } = await detect(canvas);
  const sep = lang === 'korean' ? '' : ' ';
  const lines: PaddleOcrLineDto[] = [];
  const keptBoxes: DetBox[] = [];
  for (const box of boxes) {
    if (box.w < 6 || box.h < 6) continue;
    // 块内再用 PaddleOCR det 分行、逐行 rec，拼成该块文字（comic 块可能含多行）。
    const crop = cropCanvas(canvas, box);
    const lineBoxes = await detLines(crop);
    const parts: string[] = [];
    for (const lineBox of lineBoxes) {
      const t = await recLine(cropCanvas(crop, lineBox), lang);
      if (t) parts.push(t);
    }
    const text = parts.join(sep).trim();
    if (!text) continue;
    const color = seg
      ? (inkColorFromSeg(imgData, canvas.width, box, seg, lb) ?? undefined)
      : undefined;
    lines.push({ text, bbox: [box.x, box.y, box.x + box.w, box.y + box.h], color });
    keptBoxes.push(box);
  }
  const maskDataUrl =
    seg && keptBoxes.length
      ? (buildTextMaskDataUrl(canvas.width, canvas.height, keptBoxes, seg, lb) ?? undefined)
      : undefined;
  return { lines, maskDataUrl };
}

/** 从大图裁剪一个文字框区域为独立 canvas。 */
function cropCanvas(src: HTMLCanvasElement, box: DetBox): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = Math.max(1, box.w);
  out.height = Math.max(1, box.h);
  const ctx = out.getContext('2d');
  if (ctx) ctx.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return out;
}

function toCanvas(dataUrl: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('无法创建画布上下文'));
        return;
      }
      ctx.drawImage(image, 0, 0);
      resolve(canvas);
    };
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = dataUrl;
  });
}
