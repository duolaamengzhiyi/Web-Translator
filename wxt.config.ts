import { defineConfig } from 'wxt';

// WXT 配置：自动生成 MV3 manifest，启用 React 模块。
// 文档：https://wxt.dev
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // 输出到 output/ 而非默认的 .output/：带点的隐藏目录在 Chrome 加载扩展时不可见
  outDir: 'output',
  manifest: {
    name: 'Web Translator',
    description: 'AI 网页翻译：文本 / PDF / 图片 / 漫画',
    icons: {
      16: '/icon/16.png',
      32: '/icon/32.png',
      48: '/icon/48.png',
      128: '/icon/128.png',
    },
    // storage: 存配置；contextMenus: 右键翻译图片；offscreen: 在文档上下文跑 LaMa
    permissions: ['storage', 'contextMenus', 'offscreen'],
    // 注入任意页面 + 由 background 跨域拉取翻译/OCR 接口与图片字节
    host_permissions: ['<all_urls>'],
    // 放行 wasm，使 offscreen 文档可运行 onnxruntime-web（LaMa）
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
});
