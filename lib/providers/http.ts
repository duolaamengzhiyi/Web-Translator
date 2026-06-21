// 可重试状态码：限流与网关/服务端临时错误。
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** POST 请求，遇到 429/5xx 自动退避重试，降低偶发失败。 */
export async function postWithRetry(
  url: string,
  init: RequestInit,
  retries = 2,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok || attempt >= retries || !RETRYABLE.has(res.status)) return res;
    await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
  }
}
