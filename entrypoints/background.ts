import { registerHandlers } from '@/lib/messaging';
import { getSettings } from '@/lib/settings';
import { getTranslationProvider, getVisionProvider } from '@/lib/providers/registry';
import type { OcrLine } from '@/lib/providers/types';
import type {
  LamaInpaintRequest,
  LamaInpaintResponse,
  PaddleOcrRequest,
  PaddleOcrResponse,
} from '@/lib/offscreen/protocol';

const MENU_TRANSLATE_IMAGE = 'wt-translate-image';

// background service worker：网络中枢。
// 集中持有 API key、统一跨域请求，content/popup 通过消息调用。
export default defineBackground(() => {
  setupContextMenu();

  registerHandlers({
    async translateBatch({ texts, sourceLang, targetLang }) {
      const settings = await getSettings();
      const provider = getTranslationProvider(settings.translationProviderId);
      return provider.translateBatch(
        texts,
        sourceLang,
        targetLang,
        settings.deepseekApiKey,
        settings.translationModel,
      );
    },

    async ocrImage({ imageDataUrl }) {
      const settings = await getSettings();
      // 本地 OCR 走 offscreen（onnxruntime-web 需文档上下文，service worker 跑不了）。
      // 识别模型跟随原文语言：韩语→韩语模型；日语→manga-ocr(竖排强)；其余→通用(中/英/日)。
      if (settings.visionProviderId === 'local') {
        const lang =
          settings.sourceLang === 'ko'
            ? 'korean'
            : settings.sourceLang === 'ja'
              ? 'manga'
              : 'multi';
        return runLocalOcr(imageDataUrl, lang);
      }
      const provider = getVisionProvider(settings.visionProviderId);
      const apiKey =
        settings.visionProviderId === 'gemini' ? settings.geminiApiKey : settings.qwenApiKey;
      const lines = await provider.detectText(imageDataUrl, apiKey, {
        region: settings.qwenRegion,
        model: settings.visionModel,
        disableInspection: settings.disableQwenInspection,
      });
      return { lines };
    },

    async fetchImage({ url }) {
      return { dataUrl: await fetchAsDataUrl(url) };
    },

    async lamaInpaint({ imageDataUrl, boxes }) {
      await ensureOffscreen();
      const request: LamaInpaintRequest = {
        target: 'offscreen',
        type: 'lama-inpaint',
        imageDataUrl,
        boxes,
      };
      const response = (await browser.runtime.sendMessage(request)) as
        | LamaInpaintResponse
        | undefined;
      if (!response?.ok || !response.dataUrl) {
        throw new Error(response?.error ?? 'LaMa 推理失败');
      }
      return { dataUrl: response.dataUrl };
    },
  });

  console.log('[Web Translator] background 已启动');
});

/** 经 offscreen 文档运行本地视觉链路，返回文字行（含原文色）+ 擦除蒙版。 */
async function runLocalOcr(
  imageDataUrl: string,
  lang: PaddleOcrRequest['lang'],
): Promise<{ lines: OcrLine[]; maskDataUrl?: string }> {
  await ensureOffscreen();
  const request: PaddleOcrRequest = { target: 'offscreen', type: 'paddle-ocr', imageDataUrl, lang };
  const response = (await browser.runtime.sendMessage(request)) as PaddleOcrResponse | undefined;
  if (!response?.ok || !response.lines) {
    throw new Error(response?.error ?? '本地 OCR 失败');
  }
  return { lines: response.lines, maskDataUrl: response.maskDataUrl };
}

let offscreenCreating: Promise<void> | null = null;

/** 确保 offscreen 文档已创建（用于运行 LaMa）。 */
async function ensureOffscreen(): Promise<void> {
  if (await browser.offscreen.hasDocument()) return;
  if (!offscreenCreating) {
    const params = {
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: '运行本地 OCR（PaddleOCR）与图像修复模型（LaMa）',
    } as Parameters<typeof browser.offscreen.createDocument>[0];
    offscreenCreating = browser.offscreen.createDocument(params).finally(() => {
      offscreenCreating = null;
    });
  }
  await offscreenCreating;
}

/** 右键图片菜单：翻译此图片/漫画。 */
function setupContextMenu(): void {
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.removeAll(() => {
      browser.contextMenus.create({
        id: MENU_TRANSLATE_IMAGE,
        title: '翻译此图片 / 漫画',
        contexts: ['image'],
      });
    });
  });

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_TRANSLATE_IMAGE && tab?.id != null) {
      browser.tabs.sendMessage(tab.id, { cmd: 'translate-image' }).catch(() => {
        // 页面无法注入 content script 时忽略
      });
    }
  });
}

/** 跨域拉取图片并转 data URL（service worker 无 FileReader，用 btoa 编码）。 */
async function fetchAsDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`拉取图片失败 ${res.status}`);
  const blob = await res.blob();
  const buffer = await blob.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  const mime = blob.type || 'image/png';
  return `data:${mime};base64,${base64}`;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
