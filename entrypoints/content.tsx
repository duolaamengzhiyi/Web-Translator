import { createRoot, type Root } from 'react-dom/client';
import { BallApp } from '@/components/BallApp';
import { translateImageElement } from '@/lib/image/pipeline';

// content script：在每个页面注入可拖拽悬浮球（Shadow DOM 隔离样式），
// 点击悬浮球或经弹窗下发指令即可一键翻译/还原整页。
export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',
  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: 'web-translator-ball',
      position: 'inline',
      anchor: 'body',
      onMount(container): Root {
        const root = createRoot(container);
        root.render(<BallApp />);
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });
    ui.mount();

    setupImageTranslation();
  },
});

/** 记录最近右键的图片，并响应右键菜单的翻译指令。 */
function setupImageTranslation(): void {
  let lastImage: HTMLImageElement | null = null;

  document.addEventListener(
    'contextmenu',
    (event) => {
      const target = event.target;
      lastImage = target instanceof HTMLImageElement ? target : null;
    },
    true,
  );

  browser.runtime.onMessage.addListener((message: unknown) => {
    const cmd = (message as { cmd?: string } | null)?.cmd;
    if (cmd === 'translate-image' && lastImage) {
      void translateImageElement(lastImage);
    }
    return undefined;
  });
}
