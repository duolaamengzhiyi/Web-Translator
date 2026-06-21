import type { OcrLine } from '@/lib/providers/types';

type Bbox = [number, number, number, number];

/**
 * 合并相邻的 OCR 文字框：OCR 常把同一句/同一气泡拆成多个行框，
 * 各自翻译+回填会导致一句话碎成多块、不可读。按邻近度并查集聚类后，
 * 同组文字拼成整句一起翻译、回填到合并后的大框。
 */
export function mergeOcrLines(lines: OcrLine[]): OcrLine[] {
  const n = lines.length;
  if (n <= 1) return lines;

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[x] !== root) {
      const next = parent[x]!;
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (near(lines[i]!.bbox, lines[j]!.bbox)) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  }

  const merged: OcrLine[] = [];
  for (const indices of groups.values()) {
    const items = indices.map((i) => lines[i]!);
    // 阅读顺序近似：先上后下、再左到右（横排准确；竖排为近似）
    items.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
    const text = items
      .map((it) => it.text.trim())
      .filter(Boolean)
      .join(' ');
    const bbox: Bbox = [
      Math.min(...items.map((it) => it.bbox[0])),
      Math.min(...items.map((it) => it.bbox[1])),
      Math.max(...items.map((it) => it.bbox[2])),
      Math.max(...items.map((it) => it.bbox[3])),
    ];
    merged.push({ text, bbox });
  }
  return merged;
}

/** 两个框是否足够近（同一气泡/句子），阈值相对文字高度。 */
function near(a: Bbox, b: Bbox): boolean {
  const size = Math.min(a[3] - a[1], b[3] - b[1]) || Math.max(a[3] - a[1], b[3] - b[1]) || 10;
  const gapX = Math.max(0, Math.max(b[0] - a[2], a[0] - b[2]));
  const gapY = Math.max(0, Math.max(b[1] - a[3], a[1] - b[3]));
  return gapX <= size * 0.8 && gapY <= size * 1.0;
}
