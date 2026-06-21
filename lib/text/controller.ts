import { collectBlocks, type TextBlock } from './collect';
import {
  injectTranslation,
  markLoading,
  removeAllTranslations,
  removeStaleLoading,
} from './inject';
import { startObserver } from './observe';
import { sendMessage } from '@/lib/messaging';
import { getSettings, type Settings } from '@/lib/settings';

export type TranslatorStatus = 'idle' | 'working' | 'translated';

export interface TranslatorState {
  status: TranslatorStatus;
  done: number;
  total: number;
  error?: string;
}

/** 整页翻译编排：收集段落 → 批量翻译 → 双语注入；支持还原与动态内容。 */
class PageTranslator {
  private state: TranslatorState = { status: 'idle', done: 0, total: 0 };
  private listeners = new Set<(state: TranslatorState) => void>();
  private observer: MutationObserver | undefined;
  private runId = 0;

  subscribe(callback: (state: TranslatorState) => void): () => void {
    this.listeners.add(callback);
    callback(this.state);
    return () => this.listeners.delete(callback);
  }

  getState(): TranslatorState {
    return this.state;
  }

  private setState(patch: Partial<TranslatorState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  /** 悬浮球/弹窗点击入口：未翻译则翻译，否则还原。 */
  async toggle(): Promise<void> {
    if (this.state.status === 'idle') {
      await this.translate();
    } else {
      this.restore();
    }
  }

  async translate(): Promise<void> {
    const settings = await getSettings();
    if (!settings.deepseekApiKey) {
      this.setState({ status: 'idle', error: '未配置 DeepSeek API Key，请在设置中填写' });
      return;
    }

    const blocks = collectBlocks();
    if (blocks.length === 0) {
      this.setState({ status: 'translated', error: undefined });
      this.ensureObserver();
      return;
    }

    const runId = ++this.runId;
    this.setState({ status: 'working', done: 0, total: blocks.length, error: undefined });
    await this.translateBlocks(blocks, settings, runId);
    if (this.runId !== runId) return; // 已被还原/取消

    removeStaleLoading(); // 清掉失败/空结果遗留的转圈
    this.setState({ status: 'translated' });
    this.ensureObserver();
  }

  restore(): void {
    this.runId++; // 取消进行中的翻译
    this.observer?.disconnect();
    this.observer = undefined;
    removeAllTranslations();
    this.setState({ status: 'idle', done: 0, total: 0, error: undefined });
  }

  /** 批量翻译一组块：去重 → 分批 → 限并发 → 注入。 */
  private async translateBlocks(
    blocks: TextBlock[],
    settings: Settings,
    runId: number,
  ): Promise<void> {
    // 相同文本只翻译一次，结果回填到所有同文本块；同时就地标记 loading 转圈
    const byText = new Map<string, TextBlock[]>();
    for (const block of blocks) {
      markLoading(block.el);
      const list = byText.get(block.text);
      if (list) list.push(block);
      else byText.set(block.text, [block]);
    }

    const batches = chunk([...byText.keys()], settings.batchSize);
    await runPool(batches, settings.concurrency, async (batch) => {
      if (this.runId !== runId) return;
      try {
        const results = await sendMessage('translateBatch', {
          texts: batch,
          sourceLang: settings.sourceLang,
          targetLang: settings.targetLang,
        });
        if (this.runId !== runId) return;
        batch.forEach((text, index) => {
          const translated = results[index];
          if (!translated) return;
          for (const block of byText.get(text) ?? []) {
            injectTranslation(block.el, translated);
            this.setState({ done: this.state.done + 1 });
          }
        });
      } catch (error) {
        this.setState({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  private ensureObserver(): void {
    if (this.observer) return;
    this.observer = startObserver(() => {
      void this.translateNewContent();
    });
  }

  /** 动态新增内容到来时，只翻译新出现的块。 */
  private async translateNewContent(): Promise<void> {
    if (this.state.status !== 'translated') return;
    const blocks = collectBlocks();
    if (blocks.length === 0) return;
    const settings = await getSettings();
    if (!settings.deepseekApiKey) return;
    const runId = this.runId; // 复用当前 run，不打断
    await this.translateBlocks(blocks, settings, runId);
    if (this.runId === runId) removeStaleLoading();
  }
}

export const pageTranslator = new PageTranslator();

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  const step = Math.max(1, size);
  for (let i = 0; i < items.length; i += step) {
    result.push(items.slice(i, i + step));
  }
  return result;
}

/** 限制并发的任务池。 */
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}
