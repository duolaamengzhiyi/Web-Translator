import { useState } from 'react';
import { useSettings } from '@/lib/useSettings';
import type { QwenRegion } from '@/lib/settings';

/**
 * 设置页：集中配置各服务商 API 密钥 + 高级项。
 * 语言/模型/视觉服务商/擦除方式等常用切换已移到工具栏弹窗。
 */
export const App = () => {
  const { settings, loaded, update } = useSettings();
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const save = async (patch: Parameters<typeof update>[0]) => {
    await update(patch);
    setSavedAt('已保存');
    window.setTimeout(() => setSavedAt(null), 1500);
  };

  if (!loaded) return <div className="wt-options">加载中…</div>;

  return (
    <div className="wt-options">
      <h1 className="wt-title">
        <span className="wt-logo">译</span>
        Web Translator 设置
        {savedAt ? <span className="wt-saved">{savedAt}</span> : null}
      </h1>
      <p className="wt-hint" style={{ marginTop: '-8px', marginBottom: '20px' }}>
        语言、翻译模型、视觉模型、擦除方式等常用切换在工具栏图标的弹窗里调节；此处只配置 API 密钥。
      </p>

      <section className="wt-section">
        <h2>API 密钥</h2>

        <div className="wt-field">
          <label htmlFor="deepseekKey">DeepSeek API Key</label>
          <input
            id="deepseekKey"
            type="password"
            placeholder="sk-..."
            value={settings.deepseekApiKey}
            onChange={(e) => save({ deepseekApiKey: e.target.value })}
          />
          <p className="wt-hint">
            文本 / PDF / 图片译文都用它翻译。在 https://platform.deepseek.com 获取。
          </p>
        </div>

        <div className="wt-field">
          <label htmlFor="geminiKey">Gemini API Key</label>
          <input
            id="geminiKey"
            type="password"
            placeholder="在 Google AI Studio 申请"
            value={settings.geminiApiKey}
            onChange={(e) => save({ geminiApiKey: e.target.value })}
          />
          <p className="wt-hint">
            云端视觉服务商选 Gemini 时用。已默认把内容安全过滤设为 BLOCK_NONE。
          </p>
        </div>

        <div className="wt-field">
          <label htmlFor="qwenKey">通义千问 / DashScope API Key</label>
          <input
            id="qwenKey"
            type="password"
            placeholder="sk-..."
            value={settings.qwenApiKey}
            onChange={(e) => save({ qwenApiKey: e.target.value })}
          />
          <p className="wt-hint">云端视觉服务商选 Qwen-VL 时用。</p>
        </div>

        <div className="wt-row">
          <div className="wt-field">
            <label htmlFor="qwenRegion">DashScope 区域</label>
            <select
              id="qwenRegion"
              value={settings.qwenRegion}
              onChange={(e) => save({ qwenRegion: e.target.value as QwenRegion })}
            >
              <option value="cn">国内站</option>
              <option value="intl">国际站</option>
            </select>
          </div>
        </div>

        <div className="wt-field">
          <label htmlFor="disableInspection" className="wt-check">
            <input
              id="disableInspection"
              type="checkbox"
              checked={settings.disableQwenInspection}
              onChange={(e) => save({ disableQwenInspection: e.target.checked })}
            />
            关闭 Qwen 内容安全审查（漫画被 data_inspection_failed 拦截时）
          </label>
          <p className="wt-hint">
            需先在阿里云百炼控制台为账号开通该权限，否则接口会返回
            403。露骨内容建议改用弹窗里的「本地视觉模型」。
          </p>
        </div>
      </section>

      <section className="wt-section">
        <h2>高级</h2>
        <div className="wt-row">
          <div className="wt-field">
            <label htmlFor="batchSize">单次翻译合并段数</label>
            <input
              id="batchSize"
              type="number"
              min={1}
              max={100}
              value={settings.batchSize}
              onChange={(e) => save({ batchSize: clampInt(e.target.value, 1, 100, 20) })}
            />
          </div>
          <div className="wt-field">
            <label htmlFor="concurrency">最大并发请求</label>
            <input
              id="concurrency"
              type="number"
              min={1}
              max={10}
              value={settings.concurrency}
              onChange={(e) => save({ concurrency: clampInt(e.target.value, 1, 10, 3) })}
            />
          </div>
        </div>
      </section>
    </div>
  );
};

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
