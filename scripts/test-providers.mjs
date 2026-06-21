// 大模型 API 契约自测脚本（在你本机运行，key 不经过任何第三方）。
// 用法：
//   DEEPSEEK_API_KEY=sk-xxx node scripts/test-providers.mjs
//   QWEN_API_KEY=sk-xxx QWEN_REGION=cn node scripts/test-providers.mjs --image ./manga.png
//
// 该脚本刻意复刻 lib/providers/deepseek.ts 与 qwenVl.ts 的请求与解析逻辑，
// 跑通即说明扩展里的 provider 假设成立。

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const args = process.argv.slice(2);
const imageArg = readFlag('--image');

await testDeepSeek();
await testQwen();

async function testDeepSeek() {
  const key = process.env.DEEPSEEK_API_KEY;
  console.log('\n=== DeepSeek V4 Pro 翻译契约 ===');
  if (!key) {
    console.log('跳过：未设置 DEEPSEEK_API_KEY');
    return;
  }
  const texts = ['Hello, world!', 'Good morning, everyone.'];
  const system =
    '你是专业翻译引擎。把用户给出的 JSON 字符串数组中每一项翻译成「简体中文」，' +
    '忠实原意与语气，保留占位符、标点与换行，不要添加解释。' +
    '仅输出 JSON 对象 {"translations": string[]}，其中 translations 与输入等长、顺序一致。';
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(texts) },
        ],
        temperature: 1.3,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      console.log(`❌ HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return;
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    const parsed = JSON.parse(content);
    const out = parsed.translations;
    if (!Array.isArray(out) || out.length !== texts.length) {
      console.log(
        '❌ 返回结构不符（期望 {"translations": [...]} 且等长）：',
        content.slice(0, 300),
      );
      return;
    }
    console.log('✅ 通过。译文：', out);
  } catch (error) {
    console.log('❌ 异常：', error.message);
  }
}

async function testQwen() {
  const key = process.env.QWEN_API_KEY;
  const region = process.env.QWEN_REGION === 'intl' ? 'intl' : 'cn';
  console.log('\n=== 通义千问 Qwen-VL OCR 契约 ===');
  if (!key) {
    console.log('跳过：未设置 QWEN_API_KEY');
    return;
  }
  if (!imageArg) {
    console.log('跳过：未提供 --image <带文字的图片路径>');
    return;
  }
  const host = region === 'intl' ? 'dashscope-intl.aliyuncs.com' : 'dashscope.aliyuncs.com';
  const dataUrl = toDataUrl(imageArg);
  const prompt =
    '识别图片中所有可见文字（包含对话气泡、旁白框、音效字 SFX）。' +
    '按文字块输出 JSON：{"lines":[{"text":"原文","bbox":[x1,y1,x2,y2]}]}。' +
    'bbox 是该文字块的包围盒，坐标归一化到 0~1000 的整数，原点在左上角，需满足 x1<x2、y1<y2。' +
    '每个气泡或独立文本块作为一行。不要翻译、不要解释，只输出 JSON。';
  try {
    const res = await fetch(`https://${host}/compatible-mode/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.QWEN_MODEL ?? 'qwen3.6-flash',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: dataUrl } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      console.log(`❌ HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return;
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    const text = content
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.lines)) {
      console.log('❌ 返回结构不符（期望 {"lines":[{text,bbox}]}）：', content.slice(0, 400));
      return;
    }
    console.log(`✅ 通过。识别到 ${parsed.lines.length} 个文字块，前几条：`);
    console.log(parsed.lines.slice(0, 5));
  } catch (error) {
    console.log('❌ 异常：', error.message);
  }
}

function readFlag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function toDataUrl(path) {
  const buf = readFileSync(path);
  const ext = extname(path).toLowerCase();
  const mime =
    ext === '.png'
      ? 'image/png'
      : ext === '.webp'
        ? 'image/webp'
        : ext === '.gif'
          ? 'image/gif'
          : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}
