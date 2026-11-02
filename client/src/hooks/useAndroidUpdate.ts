import { useEffect, useState } from '../lib/teact/teact';

import { getAndroidBridge } from '../util/androidBridge';

// The Android app finds new versions itself and downloads them when the "Update" button is tapped; it reports
// what is happening as 'peyvandupdate' events (see Updater.java)

export type AndroidUpdateState = 'available' | 'downloading' | 'installing' | 'failed';

const UPDATE_EVENT = 'peyvandupdate';

function readInitialState(): AndroidUpdateState | undefined {
  const bridge = getAndroidBridge();
  if (!bridge?.getAvailableUpdate?.()) return undefined;
  const state = bridge.getUpdateState?.();
  return state === 'downloading' || state === 'installing' || state === 'failed' ? state : 'available';
}

export default function useAndroidUpdate() {
  const [state, setState] = useState<AndroidUpdateState | undefined>(readInitialState);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!getAndroidBridge()?.startUpdate) return undefined;
    const handleUpdate = (event: Event) => {
      const { detail } = event as CustomEvent<{ state: AndroidUpdateState; progress: number }>;
      setState(detail.state);
      setProgress(detail.progress);
    };
    window.addEventListener(UPDATE_EVENT, handleUpdate);
    return () => window.removeEventListener(UPDATE_EVENT, handleUpdate);
  }, []);

  return { state, progress };
}
