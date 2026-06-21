const STYLE_ID = 'wt-injected-style';

// 文章型块级元素：译文以块级显示在原文下方；其余（标题/表格/导航等）内联追加，避免破坏布局。
const BLOCK_TAGS = new Set([
  'P',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'DD',
  'DT',
  'FIGCAPTION',
]);

/** 一次性注入译文样式（注入节点在宿主页，非 Shadow DOM，需自带样式）。 */
function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .wt-translation { color: #d6398a; text-decoration: none; font-style: normal; unicode-bidi: isolate; }
    .wt-inline { display: inline; }
    .wt-inline::before { content: " "; }
    .wt-block { display: block; margin: 2px 0 0; padding-left: 8px; border-left: 3px solid #f06595; opacity: 0.96; }
    .wt-loading {
      display: inline-block; width: 0.78em; height: 0.78em; margin-left: 5px; vertical-align: middle;
      border: 2px solid rgba(240,101,149,0.35); border-top-color: #f06595; border-radius: 50%;
      animation: wt-inject-spin 0.7s linear infinite;
    }
    @keyframes wt-inject-spin { to { transform: rotate(360deg); } }
  `;
  (document.head ?? document.documentElement).appendChild(style);
}

/** 在原文元素内部末尾追加一个 loading 转圈占位（就地、不破坏布局）。 */
export function markLoading(el: HTMLElement): void {
  if (el.hasAttribute('data-wt-translated')) return;
  if (el.querySelector(':scope > [data-wt="translation"]')) return;
  ensureStyle();
  const node = document.createElement('span');
  node.className = 'wt-loading';
  node.setAttribute('data-wt', 'translation');
  el.appendChild(node);
}

/** 用译文替换 loading 占位（无则新建），就地内联/块级追加，保持原页面布局。 */
export function injectTranslation(el: HTMLElement, translated: string): void {
  if (el.hasAttribute('data-wt-translated')) return;
  ensureStyle();
  let node = el.querySelector(':scope > [data-wt="translation"]') as HTMLElement | null;
  if (!node) {
    node = document.createElement('span');
    node.setAttribute('data-wt', 'translation');
    el.appendChild(node);
  }
  node.className = `wt-translation ${BLOCK_TAGS.has(el.tagName) ? 'wt-block' : 'wt-inline'}`;
  node.textContent = translated;
  el.setAttribute('data-wt-translated', '1');
}

/** 清除尚未完成（翻译失败/为空）的 loading 转圈。 */
export function removeStaleLoading(): void {
  document.querySelectorAll('.wt-loading').forEach((n) => n.remove());
}

/** 移除全部译文与占位，恢复原页面。 */
export function removeAllTranslations(): void {
  document.querySelectorAll('[data-wt="translation"]').forEach((n) => n.remove());
  document
    .querySelectorAll('[data-wt-translated]')
    .forEach((n) => n.removeAttribute('data-wt-translated'));
}
