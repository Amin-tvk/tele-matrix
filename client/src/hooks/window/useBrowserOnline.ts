import { useEffect, useState } from '../../lib/teact/teact';

// Phones report "offline" for a moment while switching networks or reconnecting a VPN; that is not worth a banner
const OFFLINE_DELAY_MS = 3000;

export default function useBrowserOnline() {
  const [isOnline, setIsOnline] = useState(window.navigator.onLine);

  useEffect(() => {
    let offlineTimeout: ReturnType<typeof setTimeout> | undefined;

    function handleChange() {
      clearTimeout(offlineTimeout);
      offlineTimeout = undefined;
      if (window.navigator.onLine) {
        setIsOnline(true);
        return;
      }
      offlineTimeout = setTimeout(() => {
        offlineTimeout = undefined;
        setIsOnline(window.navigator.onLine);
      }, OFFLINE_DELAY_MS);
    }

    window.addEventListener('online', handleChange);
    window.addEventListener('offline', handleChange);

    return () => {
      clearTimeout(offlineTimeout);
      window.removeEventListener('offline', handleChange);
      window.removeEventListener('online', handleChange);
    };
  }, []);

  return isOnline;
}
