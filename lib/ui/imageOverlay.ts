let keyframesInjected = false;

/** 覆盖在图片上的翻译进度句柄。 */
export interface ImageProgress {
  set(percent: number, label: string): void;
  success(label: string): void;
  error(label: string): void;
}

/**
 * 在指定图片上叠加一层半透明遮罩 + 转圈 + 文案 + 底部百分比进度条（仿豆包）。
 * 随页面滚动/缩放自动对齐；success/error 后自动淡出移除。
 */
export function showImageOverlay(img: HTMLImageElement): ImageProgress {
  injectKeyframes();

  const overlay = document.createElement('div');
  overlay.setAttribute('data-wt', 'img-overlay');
  Object.assign(overlay.style, {
    position: 'absolute',
    zIndex: '2147483647',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
    padding: '10px',
    overflow: 'hidden',
    background: 'rgba(22,22,26,0.5)',
    color: '#fff',
    borderRadius: '6px',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);

  const spinner = document.createElement('div');
  Object.assign(spinner.style, {
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    border: '3px solid rgba(255,255,255,0.3)',
    borderTopColor: '#fff',
    animation: 'wt-ov-spin 0.8s linear infinite',
    textAlign: 'center',
    lineHeight: '32px',
    fontSize: '20px',
  } satisfies Partial<CSSStyleDeclaration>);

  const label = document.createElement('div');
  Object.assign(label.style, {
    fontSize: '13px',
    fontWeight: '600',
    textShadow: '0 1px 3px rgba(0,0,0,0.6)',
    textAlign: 'center',
  } satisfies Partial<CSSStyleDeclaration>);
  label.textContent = '翻译中…';

  const track = document.createElement('div');
  Object.assign(track.style, {
    width: '64%',
    maxWidth: '180px',
    height: '4px',
    borderRadius: '2px',
    background: 'rgba(255,255,255,0.28)',
    overflow: 'hidden',
  } satisfies Partial<CSSStyleDeclaration>);
  const bar = document.createElement('div');
  Object.assign(bar.style, {
    height: '100%',
    width: '0%',
    background: '#ff6b9d',
    transition: 'width 0.3s ease',
  } satisfies Partial<CSSStyleDeclaration>);
  track.appendChild(bar);

  const percentText = document.createElement('div');
  Object.assign(percentText.style, {
    fontSize: '11px',
    opacity: '0.85',
  } satisfies Partial<CSSStyleDeclaration>);
  percentText.textContent = '0%';

  overlay.append(spinner, label, track, percentText);
  document.body.appendChild(overlay);

  const reposition = () => {
    const rect = img.getBoundingClientRect();
    Object.assign(overlay.style, {
      left: `${rect.left + window.scrollX}px`,
      top: `${rect.top + window.scrollY}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    // 图片太小则只保留转圈，隐藏文字与进度条
    const compact = rect.height < 90 || rect.width < 90;
    for (const el of [label, track, percentText]) el.style.display = compact ? 'none' : '';
  };
  reposition();
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);

  let done = false;
  const cleanup = (delayMs: number) => {
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition);
    window.setTimeout(() => overlay.remove(), delayMs);
  };

  const markGlyph = (glyph: string) => {
    spinner.style.animation = 'none';
    spinner.style.border = 'none';
    spinner.textContent = glyph;
  };

  return {
    set(percent, text) {
      if (done) return;
      const clamped = Math.max(0, Math.min(100, Math.round(percent)));
      bar.style.width = `${clamped}%`;
      percentText.textContent = `${clamped}%`;
      label.textContent = text;
    },
    success(text) {
      if (done) return;
      done = true;
      markGlyph('✓');
      bar.style.width = '100%';
      percentText.textContent = '100%';
      label.textContent = text;
      cleanup(800);
    },
    error(text) {
      if (done) return;
      done = true;
      overlay.style.background = 'rgba(120,22,22,0.6)';
      markGlyph('!');
      label.textContent = text;
      cleanup(3500);
    },
  };
}

function injectKeyframes(): void {
  if (keyframesInjected) return;
  const style = document.createElement('style');
  style.textContent = '@keyframes wt-ov-spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
  keyframesInjected = true;
}
