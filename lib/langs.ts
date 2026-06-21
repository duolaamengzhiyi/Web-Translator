/** 语言选项：value 用于传给模型，label 给 UI 展示。 */
export interface LangOption {
  value: string;
  label: string;
}

/** 原文语言可选项（含自动检测）。 */
export const SOURCE_LANGS: LangOption[] = [
  { value: 'auto', label: '自动检测' },
  { value: 'en', label: 'English（英语）' },
  { value: 'zh-Hans', label: '简体中文' },
  { value: 'zh-Hant', label: '繁體中文' },
  { value: 'ja', label: '日本語（日语）' },
  { value: 'ko', label: '한국어（韩语）' },
  { value: 'fr', label: 'Français（法语）' },
  { value: 'de', label: 'Deutsch（德语）' },
  { value: 'es', label: 'Español（西班牙语）' },
  { value: 'ru', label: 'Русский（俄语）' },
];

/** 目标语言可选项（不含自动）。 */
export const TARGET_LANGS: LangOption[] = SOURCE_LANGS.filter((l) => l.value !== 'auto');

/** 取语言展示名，用于翻译 prompt。 */
export function langLabel(value: string): string {
  return SOURCE_LANGS.find((l) => l.value === value)?.label ?? value;
}
