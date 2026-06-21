import { useEffect, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  watchSettings,
  type Settings,
} from '@/lib/settings';

/** React 端读写配置：加载、跨上下文同步、局部更新。 */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    getSettings().then((s) => {
      if (!active) return;
      setSettings(s);
      setLoaded(true);
    });
    const unwatch = watchSettings(setSettings);
    return () => {
      active = false;
      unwatch();
    };
  }, []);

  const update = async (patch: Partial<Settings>): Promise<void> => {
    setSettings((prev) => ({ ...prev, ...patch }));
    await saveSettings(patch);
  };

  return { settings, loaded, update };
}
