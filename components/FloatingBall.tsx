import { useRef, useState, type CSSProperties, type PointerEvent } from 'react';

interface FloatingBallProps {
  /** 当前是否处于翻译/工作中状态。 */
  busy: boolean;
  /** 点击悬浮球（与拖拽区分后）触发。 */
  onClick: () => void;
}

const SIZE = 48;
const EDGE_GAP = 20;

/**
 * 右下角可拖拽悬浮球，挂载在 content 的 Shadow DOM 内。
 * 拖拽与点击通过位移阈值区分：移动超过阈值视为拖拽，不触发点击。
 */
export const FloatingBall = ({ busy, onClick }: FloatingBallProps) => {
  const [pos, setPos] = useState<{ right: number; bottom: number }>({
    right: EDGE_GAP,
    bottom: 100,
  });
  const dragState = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);

  const handlePointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragState.current = { startX: e.clientX, startY: e.clientY, moved: false };
  };

  const handlePointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const drag = dragState.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    setPos((prev) => ({
      right: clamp(prev.right - dx, EDGE_GAP, window.innerWidth - SIZE - EDGE_GAP),
      bottom: clamp(prev.bottom - dy, EDGE_GAP, window.innerHeight - SIZE - EDGE_GAP),
    }));
  };

  const handlePointerUp = () => {
    const drag = dragState.current;
    dragState.current = null;
    if (drag && !drag.moved) onClick();
  };

  return (
    <button
      type="button"
      aria-label="一键翻译本页"
      title="一键翻译本页"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{ ...ballStyle, right: pos.right, bottom: pos.bottom }}
    >
      <span style={{ ...glyphStyle, animation: busy ? 'wt-spin 0.9s linear infinite' : 'none' }}>
        {busy ? '⏳' : '译'}
      </span>
      <style>{keyframes}</style>
    </button>
  );
};

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

const ballStyle: CSSProperties = {
  position: 'fixed',
  width: SIZE,
  height: SIZE,
  borderRadius: '50%',
  border: 'none',
  cursor: 'pointer',
  zIndex: 2147483647,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'linear-gradient(135deg, #ff9a9e 0%, #f06595 100%)',
  boxShadow: '0 4px 16px rgba(240, 101, 149, 0.45)',
  color: '#fff',
  fontSize: 18,
  fontWeight: 700,
  userSelect: 'none',
  touchAction: 'none',
};

const glyphStyle: CSSProperties = {
  display: 'inline-block',
  lineHeight: 1,
};

const keyframes = `@keyframes wt-spin { to { transform: rotate(360deg); } }`;
