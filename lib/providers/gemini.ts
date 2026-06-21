import type { OcrLine, VisionOcrProvider } from './types';
import { imageSize } from './imageSize';
import { postWithRetry } from './http';

// 默认视觉模型。Gemini Flash 档：质量高、有免费额度。
const DEFAULT_MODEL = 'gemini-3.5-flash';

/** 设置页可切换的 Gemini 视觉模型清单（均已用真实 key 实测 OCR + 定框可用）。 */
export const GEMINI_VISION_MODELS: { value: string; label: string }[] = [
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash（最新 · 推荐）' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
];

// 用具名字段 x1/y1/x2/y2 而非数组，彻底避免 Gemini 原生 [ymin,xmin,...] 的顺序歧义。
const PROMPT =
  '识别图片中所有可见文字（含对话气泡、旁白框、音效字 SFX）。' +
  '输出 JSON：{"lines":[{"text":"原文","x1":int,"y1":int,"x2":int,"y2":int}]}，' +
  '其中 (x1,y1) 为文字块左上角、(x2,y2) 为右下角，坐标归一化到 0~1000 整数，x 向右、y 向下。' +
  '每个气泡或独立文本块作为一行。不要翻译、不要解释，只输出 JSON。';

// 全部安全类目设为 BLOCK_NONE：避免正常漫画被内容过滤拦截。
const SAFETY_SETTINGS = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_NONE' }));

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

interface RawLine {
  text: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) throw new Error('图片数据格式异常（需 base64 data URL）');
  return { mimeType: match[1]!, data: match[2]! };
}

/** Google Gemini 视觉 OCR：safetySettings 全 BLOCK_NONE，识别文字并返回像素包围盒。 */
export const geminiProvider: VisionOcrProvider = {
  id: 'gemini',
  label: 'Google Gemini',

  async detectText(imageDataUrl, apiKey, options) {
    if (!apiKey) throw new Error('未配置 Gemini API Key');
    const model = options?.model || DEFAULT_MODEL;
    const { mimeType, data } = parseDataUrl(imageDataUrl);

    const res = await postWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ inline_data: { mime_type: mimeType, data } }, { text: PROMPT }] }],
          safetySettings: SAFETY_SETTINGS,
          // OCR 不需要推理；关闭 thinking 可显著提速（实测约快 1 倍）。
          generationConfig: {
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      },
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Gemini 接口错误 ${res.status}：${detail.slice(0, 200)}`);
    }

    const body = (await res.json()) as GeminiResponse;
    const content = body.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!content) {
      // 区分「模型拒绝/拦截」与「真的没文字」，避免误报"未检测到文字"。
      const reason = body.promptFeedback?.blockReason ?? body.candidates?.[0]?.finishReason;
      if (reason && reason !== 'STOP' && reason !== 'MAX_TOKENS') {
        throw new Error(
          `Gemini 拒绝处理该图片（${reason}）：露骨等内容云端模型会硬性拦截，BLOCK_NONE 也无法关闭。`,
        );
      }
    }
    const lines = parseLines(content);
    const size = await imageSize(imageDataUrl);
    return toPixels(lines, size);
  },
};

/** 解析模型输出，兼容 {lines:[...]} 与裸数组两种返回。 */
function parseLines(content: string): RawLine[] {
  const text = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const items = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { lines?: unknown }).lines)
      ? (parsed as { lines: unknown[] }).lines
      : null;
  if (!items) return [];

  const result: RawLine[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const value = record.text;
    const x1 = Number(record.x1);
    const y1 = Number(record.y1);
    const x2 = Number(record.x2);
    const y2 = Number(record.y2);
    if (typeof value !== 'string' || !value.trim()) continue;
    if ([x1, y1, x2, y2].some((n) => Number.isNaN(n))) continue;
    result.push({ text: value, x1, y1, x2, y2 });
  }
  return result;
}

/** 0~1000 归一化坐标转源图像素，并用 min/max 兜底坐标顺序。 */
function toPixels(lines: RawLine[], size: { width: number; height: number }): OcrLine[] {
  return lines.map((line) => ({
    text: line.text,
    bbox: [
      Math.round((Math.min(line.x1, line.x2) / 1000) * size.width),
      Math.round((Math.min(line.y1, line.y2) / 1000) * size.height),
      Math.round((Math.max(line.x1, line.x2) / 1000) * size.width),
      Math.round((Math.max(line.y1, line.y2) / 1000) * size.height),
    ],
  }));
}
