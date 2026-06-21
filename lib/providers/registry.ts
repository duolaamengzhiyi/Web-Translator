import type { TranslationProvider, VisionOcrProvider } from './types';
import { deepseekProvider } from './deepseek';
import { qwenVlProvider } from './qwenVl';
import { geminiProvider } from './gemini';

// 服务商注册表：后续接入新模型只需在此登记，调用方无需改动。
const translationProviders: Record<string, TranslationProvider> = {
  [deepseekProvider.id]: deepseekProvider,
};

const visionProviders: Record<string, VisionOcrProvider> = {
  [qwenVlProvider.id]: qwenVlProvider,
  [geminiProvider.id]: geminiProvider,
};

export function getTranslationProvider(id: string): TranslationProvider {
  const provider = translationProviders[id];
  if (!provider) throw new Error(`未知翻译服务商：${id}`);
  return provider;
}

export function getVisionProvider(id: string): VisionOcrProvider {
  const provider = visionProviders[id];
  if (!provider) throw new Error(`未知视觉服务商：${id}`);
  return provider;
}

export const translationProviderList = Object.values(translationProviders);
export const visionProviderList = Object.values(visionProviders);
