// 生成扩展图标：方案3（对话气泡 + 文A），蓝→紫→粉半透明渐变（粉为主）。
// 源 SVG → public/icon/{16,32,48,128}.png（保留 alpha）。改配色后重跑即可。
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
<defs><linearGradient id="g" x1="0.1" y1="0" x2="0.92" y2="1">
<stop offset="0" stop-color="#5eb3fb"/>
<stop offset="0.2" stop-color="#b07cf6"/>
<stop offset="0.52" stop-color="#e35fc0"/>
<stop offset="1" stop-color="#f7559e"/>
</linearGradient></defs>
<rect width="96" height="96" rx="24" fill="url(#g)" fill-opacity="0.88"/>
<path d="M24 27 h48 a9 9 0 0 1 9 9 v22 a9 9 0 0 1 -9 9 h-31 l-13 11 v-11 h-4 a9 9 0 0 1 -9 -9 v-22 a9 9 0 0 1 9 -9 z" fill="#ffffff"/>
<text x="36" y="53" font-size="25" fill="#9333ea" text-anchor="middle" font-weight="700" font-family="PingFang SC, Hiragino Sans GB, sans-serif">文</text>
<text x="61" y="53" font-size="25" fill="#db2777" text-anchor="middle" font-weight="700" font-family="Helvetica, Arial, sans-serif">A</text>
</svg>`;

mkdirSync('public/icon', { recursive: true });
writeFileSync('public/icon/icon.svg', SVG);
for (const s of [16, 32, 48, 128]) {
  await sharp(Buffer.from(SVG), { density: 400 }).resize(s, s).png().toFile(`public/icon/${s}.png`);
}
console.log('图标已生成：public/icon/{16,32,48,128}.png + icon.svg');
