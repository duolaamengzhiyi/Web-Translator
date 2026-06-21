import { sendMessage } from '@/lib/messaging';
import { getSettings } from '@/lib/settings';
import { showToast } from '@/lib/ui/toast';
import { showImageOverlay } from '@/lib/ui/imageOverlay';
import { applyTranslatedImage, renderTranslatedImage, restoreImage } from './render';
import { mergeOcrLines } from './mergeBoxes';
import type { OcrLine } from '@/lib/providers/types';

// OCR 前若图片过大则等比缩小，减少上传与识别耗时（坐标归一化，回填仍用原图）。
// 仅对常规比例的大图生效，避免压坏超长条 webtoon。
const OCR_MAX_SIDE = 2048;
const MAX_ASPECT = 3;

/**
 * 单张图片/漫画翻译链路：取图 → 视觉 OCR → DeepSeek 翻译 → 擦除 → 排版回填。
 * 对已翻译的图片再次触发则还原；翻译进行中再次触发会提示稍候。
 */
export async function translateImageElement(img: HTMLImageElement): Promise<void> {
  if (img.getAttribute('data-wt-img-busy') === '1') {
    showToast('正在翻译中，请稍候…');
    return;
  }
  if (img.hasAttribute('data-wt-img-translated')) {
    restoreImage(img);
    return;
  }

  const src = img.currentSrc || img.src;
  if (!src) {
    showToast('无法获取图片地址', 'error');
    return;
  }

  const settings = await getSettings();
  // 按所选视觉服务商校验对应的 key；本地 OCR 无需 key。
  if (settings.visionProviderId === 'gemini' && !settings.geminiApiKey) {
    showToast('未配置 Gemini API Key', 'error');
    return;
  }
  if (settings.visionProviderId === 'qwen-vl' && !settings.qwenApiKey) {
    showToast('未配置通义千问 API Key（图片 OCR 所需）', 'error');
    return;
  }
  if (!settings.deepseekApiKey) {
    showToast('未配置 DeepSeek API Key（翻译所需）', 'error');
    return;
  }

  img.setAttribute('data-wt-img-busy', '1');
  const progress = showImageOverlay(img);
  try {
    progress.set(8, '下载图片…');
    const { dataUrl } = await sendMessage('fetchImage', { url: src });

    progress.set(30, '识别文字…');
    const { url: ocrUrl, scale } = await downscaleForOcr(dataUrl);
    const { lines: detected, maskDataUrl } = await sendMessage('ocrImage', {
      imageDataUrl: ocrUrl,
    });
    const scaled = scale === 1 ? detected : detected.map((line) => scaleLine(line, scale));
    // 本地视觉用 comic-text-detector 出块级框（已按气泡分好），无需再合并碎行；
    // 云模型返回的多为碎框，仍合并修复"一句话拆多块"。
    const isLocal = settings.visionProviderId === 'local';
    const lines = isLocal ? scaled : mergeOcrLines(scaled);
    if (lines.length === 0) {
      progress.error('未检测到文字');
      return;
    }

    progress.set(65, `翻译 ${lines.length} 处…`);
    const translations = await sendMessage('translateBatch', {
      texts: lines.map((line) => line.text),
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
    });

    progress.set(90, '排版回填…');
    const resultUrl = await renderTranslatedImage(
      dataUrl,
      lines,
      translations,
      settings.inpaintMode,
      maskDataUrl,
    );
    applyTranslatedImage(img, resultUrl);
    progress.success(`已翻译 ${lines.length} 处`);
  } catch (error) {
    progress.error(error instanceof Error ? error.message : '翻译失败');
  } finally {
    img.removeAttribute('data-wt-img-busy');
  }
}

function scaleLine(line: OcrLine, scale: number): OcrLine {
  return {
    text: line.text,
    bbox: [
      Math.round(line.bbox[0] * scale),
      Math.round(line.bbox[1] * scale),
      Math.round(line.bbox[2] * scale),
      Math.round(line.bbox[3] * scale),
    ],
    color: line.color,
  };
}

/** 大图等比缩小用于 OCR，返回缩图 data URL 与「原图/缩图」放大系数。 */
async function downscaleForOcr(dataUrl: string): Promise<{ url: string; scale: number }> {
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const longest = Math.max(w, h);
  const aspect = longest / Math.max(1, Math.min(w, h));
  if (longest <= OCR_MAX_SIDE || aspect > MAX_ASPECT) return { url: dataUrl, scale: 1 };

  const ratio = OCR_MAX_SIDE / longest;
  const cw = Math.round(w * ratio);
  const ch = Math.round(h * ratio);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { url: dataUrl, scale: 1 };
  ctx.drawImage(img, 0, 0, cw, ch);
  return { url: canvas.toDataURL('image/jpeg', 0.85), scale: w / cw };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = src;
  });
}
