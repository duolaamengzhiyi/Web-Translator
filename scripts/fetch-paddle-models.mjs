// 下载本地 OCR 模型，已存在则跳过；模型较大不入库，install 时按需获取。
//  - PaddleOCR：检测(通用) + 识别(通用 中/英/日、韩语)
//  - manga-ocr：日语漫画专用识别（竖排/假名强）
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const MEDIA =
  'https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main';
const RAW = 'https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main';
const MANGA = 'https://huggingface.co/l0wgear/manga-ocr-2025-onnx/resolve/main';

// dir: 目标目录；files: [{name,url}]
const GROUPS = [
  {
    dir: join(process.cwd(), 'public', 'paddleocr'),
    files: [
      { name: 'det.ort', url: `${MEDIA}/detection/PP-OCRv5_mobile_det_infer.ort` },
      { name: 'rec_multi.onnx', url: `${MEDIA}/recognition/PP-OCRv5_mobile_rec_infer.onnx` },
      { name: 'dict_multi.txt', url: `${RAW}/recognition/ppocrv5_dict.txt` },
      {
        name: 'rec_korean.onnx',
        url: `${MEDIA}/recognition/multi/korean/v5/korean_PP-OCRv5_mobile_rec_infer.onnx`,
      },
      {
        name: 'dict_korean.txt',
        url: `${RAW}/recognition/multi/korean/v5/ppocrv5_korean_dict.txt`,
      },
    ],
  },
  {
    // manga-ocr（日语漫画专用识别，VisionEncoderDecoder）
    dir: join(process.cwd(), 'public', 'manga-ocr'),
    files: [
      { name: 'encoder_model.onnx', url: `${MANGA}/encoder_model.onnx` },
      { name: 'decoder_model.onnx', url: `${MANGA}/decoder_model.onnx` },
      { name: 'vocab.txt', url: `${MANGA}/vocab.txt` },
      // comic-text-detector：漫画专用文字块检测
      {
        name: 'detector.onnx',
        url: 'https://huggingface.co/mayocream/comic-text-detector-onnx/resolve/main/comic-text-detector.onnx',
      },
    ],
  },
];

for (const group of GROUPS) {
  mkdirSync(group.dir, { recursive: true });
  for (const file of group.files) {
    const target = join(group.dir, file.name);
    if (existsSync(target)) {
      console.log('已存在，跳过', file.name);
      continue;
    }
    console.log('下载', file.name);
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`下载 ${file.name} 失败 ${res.status}`);
    await writeFile(target, Buffer.from(await res.arrayBuffer()));
  }
}
console.log('本地 OCR 模型就绪（PaddleOCR + manga-ocr）');
