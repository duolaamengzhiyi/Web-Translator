/**
 * 监听页面动态新增内容，防抖后回调。
 * 译文节点已带 data-wt 标记，collect 会自动跳过，故不会形成翻译循环。
 */
export function startObserver(onNewContent: () => void): MutationObserver {
  let timer: number | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(onNewContent, 800);
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        schedule();
        return;
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  return observer;
}
