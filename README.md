# Web Translator

AI 网页翻译 Chrome 扩展（Manifest V3，纯前端、无后端）。支持**网页文本、PDF、图片、漫画**翻译，并把译文嵌回原内容：

- **文本**：段落上方保留原文、下方显示译文（双语对照）。
- **PDF**：自建 pdf.js 查看器，逐页渲染原图并在旁侧给出双语译文。
- **图片 / 漫画**：识别图中文字 → 擦除原文并补回背景 → 把译文排版回填到原位置。

翻译能力来自大模型：**DeepSeek V4 Pro** 负责翻译，**通义千问 Qwen-VL** 负责图片/漫画的文字识别与定位（DeepSeek 为纯文本模型，无视觉能力）。

## 技术栈

- [WXT](https://wxt.dev) + React 19 + TypeScript（strict）
- 文本翻译：DeepSeek V4 Pro（OpenAI 兼容接口）
- 图片 OCR：通义千问 Qwen-VL（DashScope）
- 背景擦除：Canvas 智能遮罩（默认）/ LaMa（onnxruntime-web + WebGPU，可选高质量）
- PDF：pdfjs-dist

## 开发与构建

```bash
pnpm install          # 安装依赖（自动准备类型 + 复制 ORT 运行时）
pnpm dev              # 开发模式（HMR）
pnpm build            # 生产构建，产物在 output/chrome-mv3
pnpm compile          # 仅类型检查
pnpm format           # Prettier 格式化
```

## 加载到 Chrome

1. `pnpm build`
2. 打开 `chrome://extensions`，开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择 `output/chrome-mv3` 目录。

> 开发模式下也可直接加载 `pnpm dev` 产出的 `output/chrome-mv3-dev`。

## 配置（首次必做）

点击地址栏旁的扩展图标 → 弹窗里选「前往设置 / 更多设置」打开设置页：

- **DeepSeek API Key**：文本/PDF/漫画译文所需（https://platform.deepseek.com）。
- **通义千问 / DashScope API Key** 与**区域**（国内站 / 国际站）：图片/漫画 OCR 所需。
- **背景擦除方式**：智能遮罩（默认，轻量）或 LaMa 高质量。
- 弹窗里可设原文语言、目标语言、翻译服务商。

## 使用

- **网页文本**：点击页面右下角悬浮球（可拖拽）一键翻译；再次点击还原。也可在弹窗点「翻译此页」。
- **图片 / 漫画**：右键图片 → 「翻译此图片 / 漫画」；再次右键翻译可还原。
- **PDF**：在 PDF 页打开弹窗 → 「在 PDF 翻译查看器中打开」；或打开扩展的 PDF 查看器页选择本地文件。

## 注意事项

- **LaMa 高质量模式**：首次使用会从 Hugging Face 下载约 208MB 模型并缓存，且依赖浏览器 **WebGPU**；任何环节失败会自动回退到智能遮罩。此模式需在真实环境验证。
- 扩展体积约 50MB，主要来自 onnxruntime-web 运行时（仅 LaMa 使用）。`public/ort/` 由 `pnpm sync:ort` 从依赖复制，不纳入版本库。
- 仅供个人/小范围使用，未做上架与额外安全加固。API key 仅存于本地 `chrome.storage.local`。

## 扩展更多模型

`lib/providers/` 下按 `TranslationProvider` / `VisionOcrProvider` 接口实现新服务商，在 `registry.ts` 登记即可在设置中切换，调用方无需改动。
