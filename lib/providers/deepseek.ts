import type { TranslationProvider } from './types';
import { langLabel } from '@/lib/langs';
import { postWithRetry } from './http';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEFAULT_MODEL = 'deepseek-v4-pro';

/** 设置页可切换的 DeepSeek 翻译模型（均 OpenAI 兼容、已用真实 key 验证可用）。 */
export const DEEPSEEK_MODELS: { value: string; label: string }[] = [
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro（更强）' },
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash（更快 / 更省）' },
];

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * DeepSeek V4 Pro 文本翻译（OpenAI 兼容接口）。
 * 一次请求翻译多段：输入 JSON 数组，输出 {"translations": string[]}，保序等长。
 */
export const deepseekProvider: TranslationProvider = {
  id: 'deepseek',
  label: 'DeepSeek V4 Pro',

  async translateBatch(texts, sourceLang, targetLang, apiKey, model) {
    if (texts.length === 0) return [];
    if (!apiKey) throw new Error('未配置 DeepSeek API Key');

    const target = langLabel(targetLang);
    const sourceHint = sourceLang === 'auto' ? '' : `源语言为「${langLabel(sourceLang)}」。`;
    const system =
      `你是专业漫画/网页翻译引擎。${sourceHint}` +
      `把用户给出的 JSON 字符串数组中每一项翻译成「${target}」，输出与输入等长、顺序一致。要求：` +
      `①每一项都必须输出「${target}」，绝不原样保留原文语种（日文假名、韩文、其它外文等）；` +
      `②拟声词/音效(SFX)译成贴近的「${target}」拟声词（如 噗嗤、啪、哈啊♥）；` +
      `③原文可能有 OCR 误识，请结合上下文合理意译，宁可猜一个通顺译文也不要照搬原文；` +
      `④保留 ♡ 等符号与必要标点，不要添加解释。仅输出 JSON 对象 {"translations": string[]}。`;

    const res = await postWithRetry(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(texts) },
        ],
        temperature: 1.3, // DeepSeek 官方推荐的翻译场景温度
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`DeepSeek 接口错误 ${res.status}：${detail.slice(0, 200)}`);
    }

    const data = (await res.json()) as ChatResponse;
    const content = data.choices?.[0]?.message?.content ?? '';
    let parsed: { translations?: unknown };
    try {
      parsed = JSON.parse(content) as { translations?: unknown };
    } catch {
      throw new Error('DeepSeek 返回内容不是合法 JSON');
    }
    const out = parsed.translations;
    if (!Array.isArray(out) || out.length !== texts.length) {
      throw new Error('DeepSeek 返回结果与输入数量不匹配');
    }
    return out.map((t) => String(t));
  },
};
