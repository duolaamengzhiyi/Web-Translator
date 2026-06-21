import { analyzeColors, eraseRegion, erasePreciseMask, softVeil } from '@/lib/inpaint/maskFill';
import { drawTexts, type TextItem } from './typeset';
import { sendMessage } from '@/lib/messaging';
import type { OcrLine } from '@/lib/providers/types';
import type { InpaintMode } from '@/lib/settings';

/**
 * 在源图上擦除原文并写入译文，返回结果图 data URL。
 * mode='lama' 时优先用 LaMa 高质量擦除，失败自动回退智能遮罩。
 * maskDataUrl 存在（本地视觉）时走 seg 蒙版精准擦除 + 精准取色；否则盲采兜底（云模型）。
 */
export async function renderTranslatedImage(
  dataUrl: string,
  lines: OcrLine[],
  translations: string[],
  mode: InpaintMode,
  maskDataUrl?: string,
): Promise<string> {
  if (mode === 'lama') {
    try {
      return await renderWithLama(dataUrl, lines, translations);
    } catch (error) {
      console.warn('[Web Translator] LaMa 擦除失败，回退智能遮罩：', error);
    }
  }
  return renderWithMask(dataUrl, lines, translations, maskDataUrl);
}

/**
 * 智能遮罩擦除 + 排版。
 * 本地视觉（有 seg 蒙版）：按笔画蒙版精准擦除原文、保留画面，用精准取色回填；
 * 云模型（无蒙版）：逐框盲采底色 + 浅灰半透明面板。
 */
async function renderWithMask(
  dataUrl: string,
  lines: OcrLine[],
  translations: string[],
  maskDataUrl?: string,
): Promise<string> {
  const { canvas, ctx } = await drawBase(dataUrl);

  if (maskDataUrl) {
    // 擦除会改像素，故先取色：本地精准色优先，缺失则擦除前盲采兜底。
    const colors = lines.map((line) => line.color ?? analyzeColors(ctx, line.bbox).text);
    // ① 按笔画蒙版精准抹除原文 → ② 逐框叠很透明模糊蒙层（豆包式衬底）→ ③ 原文色写译文
    await erasePreciseMask(
      ctx,
      lines.map((line) => line.bbox),
      maskDataUrl,
    );
    for (const line of lines) softVeil(ctx, line.bbox);
    const items: TextItem[] = lines.map((line, i) => ({
      text: translations[i] ?? '',
      bbox: line.bbox,
      color: colors[i]!,
    }));
    drawTexts(ctx, items);
    return canvas.toDataURL('image/png');
  }

  // 云模型：逐框擦除（纯色底无缝填充 / 纹理底浅灰面板）并取原文颜色，再统一排版。
  const items: TextItem[] = lines.map((line, i) => ({
    text: translations[i] ?? '',
    bbox: line.bbox,
    color: line.color ?? eraseRegion(ctx, line.bbox).text,
  }));
  drawTexts(ctx, items);
  return canvas.toDataURL('image/png');
}

/** LaMa：先由 offscreen 文档把整图擦干净，再在擦除图上写字。 */
async function renderWithLama(
  dataUrl: string,
  lines: OcrLine[],
  translations: string[],
): Promise<string> {
  // LaMa 会擦掉原文，故先取每个框的原文颜色：本地精准色优先，缺失则盲采兜底。
  const original = await drawBase(dataUrl);
  const colors = lines.map((line) => line.color ?? analyzeColors(original.ctx, line.bbox).text);

  const { dataUrl: erasedUrl } = await sendMessage('lamaInpaint', {
    imageDataUrl: dataUrl,
    boxes: lines.map((line) => line.bbox),
  });
  const { canvas, ctx } = await drawBase(erasedUrl);
  const items: TextItem[] = lines.map((line, i) => ({
    text: translations[i] ?? '',
    bbox: line.bbox,
    color: colors[i] ?? { r: 20, g: 20, b: 20 },
  }));
  drawTexts(ctx, items);
  return canvas.toDataURL('image/png');
}

async function drawBase(
  dataUrl: string,
): Promise<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建画布上下文');
  ctx.drawImage(image, 0, 0);
  return { canvas, ctx };
}

/** 用结果图替换原 <img>，保存原始 src 以便还原。 */
export function applyTranslatedImage(img: HTMLImageElement, resultUrl: string): void {
  if (!img.hasAttribute('data-wt-img-translated')) {
    img.setAttribute('data-wt-orig-src', img.getAttribute('src') ?? '');
    img.setAttribute('data-wt-orig-srcset', img.getAttribute('srcset') ?? '');
  }
  img.removeAttribute('srcset');
  img.src = resultUrl;
  img.setAttribute('data-wt-img-translated', '1');
}

/** 还原被翻译的图片。 */
export function restoreImage(img: HTMLImageElement): void {
  const origSrc = img.getAttribute('data-wt-orig-src');
  const origSrcset = img.getAttribute('data-wt-orig-srcset');
  if (origSrc) img.src = origSrc;
  if (origSrcset) img.setAttribute('srcset', origSrcset);
  img.removeAttribute('data-wt-img-translated');
  img.removeAttribute('data-wt-orig-src');
  img.removeAttribute('data-wt-orig-srcset');
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = src;
  });
}
