export type QwenRegion = 'intl' | 'cn';
export type InpaintMode = 'mask' | 'lama';

/** 插件全部可配置项，持久化在 chrome.storage.local。 */
export interface Settings {
  /** 原文语言，'auto' 表示自动检测。 */
  sourceLang: string;
  /** 目标语言（BCP-47，如 zh-Hans / en）。 */
  targetLang: string;
  /** 文本翻译服务商 id。 */
  translationProviderId: string;
  /** 文本翻译模型 id（DeepSeek 系列，见 DEEPSEEK_MODELS）。 */
  translationModel: string;
  /** 生效的视觉 OCR 服务商 id：'qwen-vl' | 'gemini' | 'local'。 */
  visionProviderId: string;
  /** 关闭本地视觉时使用的云端服务商（记忆用户选择）：'qwen-vl' | 'gemini'。 */
  cloudVisionProviderId: string;
  /** 视觉 OCR 模型 id（云端服务商对应的模型；本地忽略）。 */
  visionModel: string;
  /** DeepSeek API key。 */
  deepseekApiKey: string;
  /** 通义千问 / DashScope API key。 */
  qwenApiKey: string;
  /** Google Gemini API key。 */
  geminiApiKey: string;
  /** DashScope 区域。 */
  qwenRegion: QwenRegion;
  /** 是否在 Qwen 请求中关闭内容安全审查（需阿里云账号已开通该权限，否则接口 403）。 */
  disableQwenInspection: boolean;
  /** 漫画/图片背景擦除方式：遮罩（轻量）/ LaMa（高质量）。 */
  inpaintMode: InpaintMode;
  /** 单次翻译请求合并的文本段数。 */
  batchSize: number;
  /** 翻译请求最大并发数。 */
  concurrency: number;
}

export const DEFAULT_SETTINGS: Settings = {
  sourceLang: 'auto',
  targetLang: 'zh-Hans',
  translationProviderId: 'deepseek',
  translationModel: 'deepseek-v4-pro',
  visionProviderId: 'gemini',
  cloudVisionProviderId: 'gemini',
  visionModel: 'gemini-3.5-flash',
  deepseekApiKey: '',
  qwenApiKey: '',
  geminiApiKey: '',
  qwenRegion: 'cn',
  disableQwenInspection: false,
  inpaintMode: 'mask',
  batchSize: 20,
  concurrency: 3,
};

// WXT 的类型化存储项。fallback 仅在完全无存储时使用；
// getSettings 再与默认值做一次合并，保证新增字段向前兼容。
const settingsStore = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await settingsStore.getValue()) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next: Settings = { ...(await getSettings()), ...patch };
  await settingsStore.setValue(next);
  return next;
}

/** 监听配置变化，返回取消监听的函数。 */
export function watchSettings(callback: (settings: Settings) => void): () => void {
  return settingsStore.watch((value) => {
    callback({ ...DEFAULT_SETTINGS, ...value });
  });
}
