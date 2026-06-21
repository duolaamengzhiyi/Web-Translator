/** 一个待翻译的段落块：元素引用 + 规整后的文本。 */
export interface TextBlock {
  el: HTMLElement;
  text: string;
}

// 完全跳过的标签（脚本、代码、媒体、表单控件等）。
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEXTAREA',
  'CODE',
  'PRE',
  'KBD',
  'SAMP',
  'VAR',
  'SVG',
  'CANVAS',
  'IMG',
  'VIDEO',
  'AUDIO',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'MAP',
  'MATH',
  'SELECT',
  'OPTION',
  'INPUT',
  'BUTTON',
  'HEAD',
]);

// 行内标签：若一个元素的所有子元素都是行内级，则它本身视为一个“段落块”。
const INLINE_TAGS = new Set([
  'A',
  'ABBR',
  'B',
  'BDI',
  'BDO',
  'BR',
  'CITE',
  'DATA',
  'DFN',
  'EM',
  'I',
  'MARK',
  'Q',
  'RP',
  'RT',
  'RUBY',
  'S',
  'SMALL',
  'SPAN',
  'STRONG',
  'SUB',
  'SUP',
  'TIME',
  'U',
  'WBR',
  'LABEL',
  'FONT',
]);

/** 从给定根节点收集尚未翻译的段落块。 */
export function collectBlocks(root: HTMLElement = document.body): TextBlock[] {
  const blocks: TextBlock[] = [];
  visit(root, blocks);
  return blocks;
}

function visit(el: Element, out: TextBlock[]): void {
  if (!(el instanceof HTMLElement)) return;
  if (shouldSkip(el)) return;

  if (isInlineOnly(el)) {
    const text = normalize(el.textContent ?? '');
    if (isTranslatable(text)) out.push({ el, text });
    return;
  }
  for (const child of el.children) visit(child, out);
}

function shouldSkip(el: HTMLElement): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.isContentEditable) return true;
  // 跳过插件自己注入的译文，以及已翻译过的原文块
  if (el.getAttribute('data-wt') === 'translation') return true;
  if (el.hasAttribute('data-wt-translated')) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (!isVisible(el)) return true;
  return false;
}

/** 元素的所有子元素都是行内标签（或无子元素）时为“行内块”。 */
function isInlineOnly(el: HTMLElement): boolean {
  for (const child of el.children) {
    if (child.getAttribute('data-wt') === 'translation') continue;
    if (!INLINE_TAGS.has(child.tagName)) return false;
  }
  return true;
}

function isVisible(el: HTMLElement): boolean {
  // Chrome 支持 checkVisibility；兜底用尺寸判断
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
  }
  return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 至少含一个字母/汉字，且不是纯数字/符号，才值得翻译。 */
function isTranslatable(text: string): boolean {
  if (text.length < 2) return false;
  return /\p{L}/u.test(text);
}
