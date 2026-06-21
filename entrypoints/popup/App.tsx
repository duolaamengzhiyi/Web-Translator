import { useEffect, useState } from 'react';
import { useSettings } from '@/lib/useSettings';
import { SOURCE_LANGS, TARGET_LANGS } from '@/lib/langs';
import type { InpaintMode } from '@/lib/settings';
import { DEEPSEEK_MODELS } from '@/lib/providers/deepseek';
import { QWEN_VISION_MODELS } from '@/lib/providers/qwenVl';
import { GEMINI_VISION_MODELS } from '@/lib/providers/gemini';

const CLOUD_VISION_PROVIDERS = [
  { id: 'gemini', label: 'Google Gemini（可关审查）' },
  { id: 'qwen-vl', label: '通义千问 Qwen-VL' },
];

function cloudVisionModels(providerId: string): { value: string; label: string }[] {
  return providerId === 'gemini' ? GEMINI_VISION_MODELS : QWEN_VISION_MODELS;
}

/** 工具栏弹窗：集中调节语言/模型/视觉/擦除，并一键翻译当前页。密钥在设置页配置。 */
export const App = () => {
  const { settings, loaded, update } = useSettings();
  const [tabUrl, setTabUrl] = useState('');

  useEffect(() => {
    browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      setTabUrl(tab?.url ?? '');
    });
  }, []);

  const isPdf = /\.pdf(\?|#|$)/i.test(tabUrl);
  const openOptions = () => browser.runtime.openOptionsPage();

  const openPdfViewer = () => {
    const viewer = browser.runtime.getURL('/pdf-viewer.html' as never);
    browser.tabs.create({ url: `${viewer}?file=${encodeURIComponent(tabUrl)}` });
    window.close();
  };

  const translateActivePage = async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) {
      await browser.tabs.sendMessage(tab.id, { cmd: 'toggle-translate' }).catch(() => {
        // 某些页面（商店、设置页）无法注入 content script，忽略
      });
    }
    window.close();
  };

  if (!loaded) return <div className="wt-popup">加载中…</div>;

  const useLocalVision = settings.visionProviderId === 'local';
  // 当前云端服务商：非本地时即生效服务商；本地时取记忆值。
  const cloudProvider = useLocalVision ? settings.cloudVisionProviderId : settings.visionProviderId;

  const toggleLocalVision = (on: boolean) => {
    if (on) {
      void update({ visionProviderId: 'local' });
      return;
    }
    // 切回云端：若当前模型不属于该服务商，归位到其默认模型，避免下拉空白。
    const models = cloudVisionModels(cloudProvider);
    const valid = models.some((m) => m.value === settings.visionModel);
    void update({
      visionProviderId: cloudProvider,
      visionModel: valid ? settings.visionModel : (models[0]?.value ?? settings.visionModel),
    });
  };

  const changeCloudProvider = (id: string) => {
    const first = cloudVisionModels(id)[0];
    void update({
      cloudVisionProviderId: id,
      visionProviderId: useLocalVision ? 'local' : id,
      visionModel: first ? first.value : settings.visionModel,
    });
  };

  const missingKey = !settings.deepseekApiKey;

  return (
    <div className="wt-popup">
      <h1 className="wt-title">
        <span className="wt-logo">译</span>
        Web Translator
      </h1>

      <div className="wt-row">
        <div className="wt-field">
          <label htmlFor="sourceLang">原文语言</label>
          <select
            id="sourceLang"
            value={settings.sourceLang}
            onChange={(e) => update({ sourceLang: e.target.value })}
          >
            {SOURCE_LANGS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="wt-field">
          <label htmlFor="targetLang">目标语言</label>
          <select
            id="targetLang"
            value={settings.targetLang}
            onChange={(e) => update({ targetLang: e.target.value })}
          >
            {TARGET_LANGS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="wt-field">
        <label htmlFor="translationModel">翻译模型</label>
        <select
          id="translationModel"
          value={settings.translationModel}
          onChange={(e) => update({ translationModel: e.target.value })}
        >
          {DEEPSEEK_MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div className="wt-divider" />

      <div className="wt-field">
        <label htmlFor="useLocalVision" className="wt-check">
          <input
            id="useLocalVision"
            type="checkbox"
            checked={useLocalVision}
            onChange={(e) => toggleLocalVision(e.target.checked)}
          />
          图片/漫画用本地视觉模型（无审查，露骨内容可用）
        </label>
      </div>

      {useLocalVision ? (
        <p className="wt-hint">
          本地识别，无需
          key、无审查。识别模型跟随上方「原文语言」：默认中/英/日(PP-OCRv5)，韩语用韩语模型，日语用
          manga-ocr 专用模型（竖排更准）。
        </p>
      ) : (
        <>
          <div className="wt-field">
            <label htmlFor="cloudVisionProvider">云端视觉服务商</label>
            <select
              id="cloudVisionProvider"
              value={cloudProvider}
              onChange={(e) => changeCloudProvider(e.target.value)}
            >
              {CLOUD_VISION_PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="wt-field">
            <label htmlFor="visionModel">视觉模型</label>
            <select
              id="visionModel"
              value={settings.visionModel}
              onChange={(e) => update({ visionModel: e.target.value })}
            >
              {cloudVisionModels(cloudProvider).map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      <div className="wt-field">
        <label htmlFor="inpaintMode">漫画/图片背景擦除</label>
        <select
          id="inpaintMode"
          value={settings.inpaintMode}
          onChange={(e) => update({ inpaintMode: e.target.value as InpaintMode })}
        >
          <option value="mask">智能遮罩（轻量，白底气泡效果好）</option>
          <option value="lama">LaMa 高质量（需下载模型、较慢）</option>
        </select>
      </div>

      <div className="wt-divider" />

      <button className="wt-btn" onClick={translateActivePage} disabled={missingKey}>
        翻译此页
      </button>

      {isPdf && (
        <button className="wt-btn wt-btn-secondary" onClick={openPdfViewer} disabled={missingKey}>
          在 PDF 翻译查看器中打开
        </button>
      )}

      {missingKey ? (
        <p className="wt-hint">
          尚未配置 DeepSeek API key。
          <button className="wt-link" onClick={openOptions}>
            前往设置填写
          </button>
        </p>
      ) : (
        <p className="wt-hint">
          也可点页面右下角悬浮球翻译。API 密钥在
          <button className="wt-link" onClick={openOptions}>
            设置
          </button>
          里配置。
        </p>
      )}
    </div>
  );
};
