import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { groupParagraphs } from './extract';
import { sendMessage } from '@/lib/messaging';
import { getSettings, type Settings } from '@/lib/settings';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const RENDER_SCALE = 1.5;

/** 在容器中渲染 PDF：逐页绘制原图并在其侧/下方填充双语译文。 */
export async function renderPdf(
  container: HTMLElement,
  source: ArrayBuffer | string,
  onStatus: (message: string) => void,
): Promise<void> {
  onStatus('正在加载 PDF…');
  const data = typeof source === 'string' ? await fetchPdf(source) : source;
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const settings = await getSettings();

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    onStatus(`正在处理第 ${pageNumber} / ${doc.numPages} 页…`);
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: RENDER_SCALE });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    canvas.className = 'wt-pdf-canvas';
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建画布上下文');
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    const textContent = await page.getTextContent();
    const paragraphs = groupParagraphs(textContent.items);

    const { pageEl, transSlots } = buildPageElement(canvas, paragraphs);
    container.appendChild(pageEl);

    if (settings.deepseekApiKey && paragraphs.length > 0) {
      await translateParagraphs(paragraphs, transSlots, settings);
    }
  }

  onStatus(`完成，共 ${doc.numPages} 页`);
}

function buildPageElement(
  canvas: HTMLCanvasElement,
  paragraphs: string[],
): { pageEl: HTMLElement; transSlots: HTMLElement[] } {
  const pageEl = document.createElement('section');
  pageEl.className = 'wt-pdf-page';

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'wt-pdf-canvas-wrap';
  canvasWrap.appendChild(canvas);

  const textWrap = document.createElement('div');
  textWrap.className = 'wt-pdf-text';

  const transSlots: HTMLElement[] = [];
  for (const paragraph of paragraphs) {
    const para = document.createElement('div');
    para.className = 'wt-pdf-para';

    const orig = document.createElement('p');
    orig.className = 'wt-pdf-orig';
    orig.textContent = paragraph;

    const trans = document.createElement('p');
    trans.className = 'wt-pdf-trans';
    trans.textContent = '…';

    para.append(orig, trans);
    textWrap.appendChild(para);
    transSlots.push(trans);
  }

  pageEl.append(canvasWrap, textWrap);
  return { pageEl, transSlots };
}

async function translateParagraphs(
  paragraphs: string[],
  slots: HTMLElement[],
  settings: Settings,
): Promise<void> {
  const size = Math.max(1, settings.batchSize);
  for (let i = 0; i < paragraphs.length; i += size) {
    const batch = paragraphs.slice(i, i + size);
    try {
      const results = await sendMessage('translateBatch', {
        texts: batch,
        sourceLang: settings.sourceLang,
        targetLang: settings.targetLang,
      });
      batch.forEach((_, index) => {
        const slot = slots[i + index];
        if (slot) slot.textContent = results[index] ?? '';
      });
    } catch (error) {
      batch.forEach((_, index) => {
        const slot = slots[i + index];
        if (slot) slot.textContent = `翻译失败：${error instanceof Error ? error.message : ''}`;
      });
    }
  }
}

async function fetchPdf(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`加载 PDF 失败 ${res.status}`);
  return res.arrayBuffer();
}
