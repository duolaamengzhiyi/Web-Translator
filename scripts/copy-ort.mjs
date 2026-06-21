// 把 onnxruntime-web 的全部运行时 wasm/mjs 复制到 public/ort，随扩展打包。
// LaMa 用 /webgpu(jsep)，本地 OCR(ppu) 用基础版（可能需要 asyncify 变体），
// 全部复制可保证 ort 运行时请求哪个文件都能在 /ort/ 找到。
import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const outDir = join(root, 'public', 'ort');

if (!existsSync(distDir)) {
  console.warn(
    '[copy-ort] 未找到 onnxruntime-web dist，跳过（LaMa/本地OCR 不可用，但不影响其它功能）',
  );
  process.exit(0);
}

// 复制所有 ort-*.wasm 与 ort-*.mjs 运行时文件。
const files = readdirSync(distDir).filter((f) => /^ort-.*\.(wasm|mjs)$/.test(f));

mkdirSync(outDir, { recursive: true });
for (const file of files) {
  copyFileSync(join(distDir, file), join(outDir, file));
}
console.log(`[copy-ort] 已复制 ${files.length} 个 ORT 运行时文件到 public/ort：`, files.join(', '));
