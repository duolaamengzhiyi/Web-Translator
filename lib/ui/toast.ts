let container: HTMLElement | undefined;
let keyframesInjected = false;

const BASE_STYLE: Partial<CSSStyleDeclaration> = {
  margin: '6px auto 0',
  padding: '8px 14px',
  borderRadius: '8px',
  fontSize: '13px',
  color: '#fff',
  boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
  pointerEvents: 'none',
  maxWidth: '80vw',
  textAlign: 'center',
};

const INFO_BG = 'rgba(31,41,55,0.95)';
const ERROR_BG = 'rgba(220,38,38,0.95)';
const SUCCESS_BG = 'rgba(22,163,74,0.95)';

/** 轻量全局提示，挂在页面底部居中，自动消失。用于一次性反馈。 */
export function showToast(
  message: string,
  kind: 'info' | 'error' = 'info',
  durationMs = 3000,
): void {
  const host = ensureContainer();
  const toast = document.createElement('div');
  toast.textContent = message;
  Object.assign(toast.style, BASE_STYLE, { background: kind === 'error' ? ERROR_BG : INFO_BG });
  host.appendChild(toast);
  window.setTimeout(() => toast.remove(), durationMs);
}

/** 常驻进度提示的句柄：可多次更新文案，最后以成功/失败收尾并自动消失。 */
export interface ProgressToast {
  update(message: string): void;
  success(message: string): void;
  error(message: string): void;
}

/** 用于图片/漫画翻译等多步骤长任务：带转圈、不自动消失，直到 success/error。 */
export function showProgress(message: string): ProgressToast {
  const host = ensureContainer();
  injectKeyframes(host);

  const toast = document.createElement('div');
  Object.assign(toast.style, BASE_STYLE, {
    background: INFO_BG,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  });

  const spinner = document.createElement('span');
  Object.assign(spinner.style, {
    width: '12px',
    height: '12px',
    flex: '0 0 auto',
    border: '2px solid rgba(255,255,255,0.35)',
    borderTopColor: '#fff',
    borderRadius: '50%',
    animation: 'wt-toast-spin 0.8s linear infinite',
  } satisfies Partial<CSSStyleDeclaration>);

  const label = document.createElement('span');
  label.textContent = message;
  toast.append(spinner, label);
  host.appendChild(toast);

  let closed = false;
  const finish = (msg: string, background: string, durationMs: number) => {
    if (closed) return;
    closed = true;
    spinner.remove();
    label.textContent = msg;
    toast.style.background = background;
    window.setTimeout(() => toast.remove(), durationMs);
  };

  return {
    update(msg) {
      if (!closed) label.textContent = msg;
    },
    success(msg) {
      finish(msg, SUCCESS_BG, 2500);
    },
    error(msg) {
      finish(msg, ERROR_BG, 6000);
    },
  };
}

function injectKeyframes(host: HTMLElement): void {
  if (keyframesInjected) return;
  const style = document.createElement('style');
  style.textContent = '@keyframes wt-toast-spin{to{transform:rotate(360deg)}}';
  host.appendChild(style);
  keyframesInjected = true;
}

function ensureContainer(): HTMLElement {
  if (container && container.isConnected) return container;
  const el = document.createElement('div');
  el.setAttribute('data-wt', 'toast');
  Object.assign(el.style, {
    position: 'fixed',
    left: '0',
    right: '0',
    bottom: '24px',
    zIndex: '2147483647',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  document.body.appendChild(el);
  container = el;
  return el;
}
