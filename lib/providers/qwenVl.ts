import type { OcrLine, VisionOcrProvider } from './types';
import { imageSize } from './imageSize';
import { postWithRetry } from './http';

// 默认 OCR 模型。Qwen3.6 原生视觉系列，物体定位/目标检测能力强，坐标归一化到 0~1000。
const DEFAULT_MODEL = 'qwen3.6-flash';

/**
 * 设置页可切换的 Qwen 视觉模型清单。
 * 均已用真实 key 实测视觉 OCR 可用、能返回 {text, bbox}（坐标 0~1000）。
 * 同代质量大体：flash < plus；max 为经典强模型。
 */
export const QWEN_VISION_MODELS: { value: string; label: string }[] = [
  { value: 'qwen3.6-flash', label: 'Qwen3.6-Flash（最新视觉系列 · 快/省 · 默认）' },
  { value: 'qwen3.6-plus', label: 'Qwen3.6-Plus（最新视觉系列 · 更强）' },
  { value: 'qwen-vl-max', label: 'Qwen-VL-Max（经典 · 最强）' },
  { value: 'qwen3-vl-plus', label: 'Qwen3-VL-Plus' },
  { value: 'qwen-vl-plus', label: 'Qwen-VL-Plus（轻量）' },
];

const PROMPT =
  '识别图片中所有可见文字（包含对话气泡、旁白框、音效字 SFX）。' +
  '按文字块输出 JSON：{"lines":[{"text":"原文","bbox":[x1,y1,x2,y2]}]}。' +
  'bbox 是该文字块的包围盒，坐标归一化到 0~1000 的整数，原点在左上角，需满足 x1<x2、y1<y2。' +
  '每个气泡或独立文本块作为一行。不要翻译、不要解释，只输出 JSON。';

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

interface RawLine {
  text: string;
  bbox: [number, number, number, number];
}

function endpoint(region: 'intl' | 'cn'): string {
  const host = region === 'intl' ? 'dashscope-intl.aliyuncs.com' : 'dashscope.aliyuncs.com';
  return `https://${host}/compatible-mode/v1/chat/completions`;
}

/** 通义千问 Qwen-VL 视觉 OCR：识别文字并返回像素包围盒。 */
export const qwenVlProvider: VisionOcrProvider = {
  id: 'qwen-vl',
  label: '通义千问 Qwen-VL',

  async detectText(imageDataUrl, apiKey, options) {
    if (!apiKey) throw new Error('未配置通义千问 API Key');
    const region = options?.region ?? 'cn';
    const model = options?.model || DEFAULT_MODEL;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
    if (options?.disableInspection) {
      // 关闭 DashScope 内容安全审查（漫画常被误判）。需账号已开通该权限，否则接口返回 403。
      headers['X-DashScope-DataInspection'] = '{"input":"disable","output":"disable"}';
    }

    const res = await postWithRetry(endpoint(region), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageDataUrl } },
              { type: 'text', text: PROMPT },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Qwen-VL 接口错误 ${res.status}：${detail.slice(0, 200)}`);
    }

    const data = (await res.json()) as ChatResponse;
    const content = data.choices?.[0]?.message?.content ?? '';
    const lines = parseLines(content);
    const size = await imageSize(imageDataUrl);
    return toPixels(lines, size);
  },
};

/** 从模型输出里稳健地解析 JSON（容忍 ```json 代码块包裹）。 */
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
  // 不同模型可能返回 {lines:[...]}（默认）或直接返回裸数组 [...]，两者都兼容。
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
    const box = record.bbox;
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!Array.isArray(box) || box.length !== 4) continue;
    const [x1, y1, x2, y2] = box.map(Number);
    if ([x1, y1, x2, y2].some((n) => n === undefined || Number.isNaN(n))) continue;
    result.push({ text: value, bbox: [x1!, y1!, x2!, y2!] });
  }
  return result;
}

/** 0~1000 归一化坐标转换为源图像素坐标。 */
function toPixels(lines: RawLine[], size: { width: number; height: number }): OcrLine[] {
  return lines.map((line) => ({
    text: line.text,
    bbox: [
      Math.round((line.bbox[0] / 1000) * size.width),
      Math.round((line.bbox[1] / 1000) * size.height),
      Math.round((line.bbox[2] / 1000) * size.width),
      Math.round((line.bbox[3] / 1000) * size.height),
    ],
  }));
}
