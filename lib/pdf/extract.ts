interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

function isTextItem(value: unknown): value is PdfTextItem {
  return (
    typeof value === 'object' &&
    value !== null &&
    'str' in value &&
    'transform' in value &&
    Array.isArray((value as { transform: unknown }).transform)
  );
}

interface Line {
  y: number;
  height: number;
  parts: PdfTextItem[];
}

/**
 * 把 pdf.js 的文字项聚合成段落：先按 y 聚类成行，再按行间距合并成段。
 * 行内按 x 间隙决定是否插入空格（兼容拉丁词与无空格的 CJK 串）。
 */
export function groupParagraphs(items: unknown[]): string[] {
  const textItems = items.filter(isTextItem).filter((i) => i.str.length > 0);
  if (textItems.length === 0) return [];

  // 顶部优先（PDF 坐标原点在左下，y 越大越靠上）
  const sorted = [...textItems].sort((a, b) => (b.transform[5] ?? 0) - (a.transform[5] ?? 0));

  const lines: Line[] = [];
  for (const item of sorted) {
    const y = item.transform[5] ?? 0;
    const height = Math.max(1, Math.abs(item.transform[3] ?? 0) || item.height || 10);
    const line = lines.find((l) => Math.abs(l.y - y) <= l.height * 0.5);
    if (line) line.parts.push(item);
    else lines.push({ y, height, parts: [item] });
  }

  const lineTexts = lines
    .map((line) => buildLineText(line))
    .filter((entry) => entry.text.trim().length > 0);

  const paragraphs: string[] = [];
  let current = '';
  let prevY: number | undefined;
  let prevHeight = 10;
  for (const entry of lineTexts) {
    if (prevY !== undefined && prevY - entry.y > prevHeight * 1.8) {
      if (current.trim()) paragraphs.push(cleanup(current));
      current = '';
    }
    current = current ? `${current} ${entry.text}` : entry.text;
    prevY = entry.y;
    prevHeight = entry.height;
  }
  if (current.trim()) paragraphs.push(cleanup(current));

  return paragraphs.filter((p) => /\p{L}/u.test(p));
}

function buildLineText(line: Line): { y: number; height: number; text: string } {
  const parts = [...line.parts].sort((a, b) => (a.transform[4] ?? 0) - (b.transform[4] ?? 0));
  let text = '';
  let prevEnd: number | undefined;
  for (const part of parts) {
    const x = part.transform[4] ?? 0;
    if (prevEnd !== undefined && x - prevEnd > line.height * 0.25) text += ' ';
    text += part.str;
    prevEnd = x + part.width;
  }
  return { y: line.y, height: line.height, text: text.trim() };
}

const CJK = '\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af';
const CJK_SPACE = new RegExp(`([${CJK}])\\s+([${CJK}])`, 'gu');

function cleanup(text: string): string {
  let result = text.replace(/\s+/g, ' ').trim();
  // 去除 CJK 字符之间的多余空格
  for (let i = 0; i < 2; i++) result = result.replace(CJK_SPACE, '$1$2');
  return result;
}
