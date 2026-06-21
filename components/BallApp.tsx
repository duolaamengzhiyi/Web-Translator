import { useEffect, useRef, useState } from 'react';
import { FloatingBall } from './FloatingBall';
import { pageTranslator, type TranslatorState } from '@/lib/text/controller';
import { showToast } from '@/lib/ui/toast';

/** 悬浮球容器：连接整页翻译控制器，并接收弹窗下发的翻译指令。 */
export const BallApp = () => {
  const [state, setState] = useState<TranslatorState>(pageTranslator.getState());
  const lastErrorRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = pageTranslator.subscribe(setState);

    const onMessage = (message: unknown): undefined => {
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { cmd?: string }).cmd === 'toggle-translate'
      ) {
        void pageTranslator.toggle();
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(onMessage);

    return () => {
      unsubscribe();
      browser.runtime.onMessage.removeListener(onMessage);
    };
  }, []);

  useEffect(() => {
    if (state.error && state.error !== lastErrorRef.current) {
      lastErrorRef.current = state.error;
      showToast(state.error, 'error');
    }
    if (!state.error) lastErrorRef.current = undefined;
  }, [state.error]);

  return (
    <FloatingBall busy={state.status === 'working'} onClick={() => void pageTranslator.toggle()} />
  );
};
