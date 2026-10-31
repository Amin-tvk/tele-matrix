import { useEffect } from '@teact';

import { IS_TOUCH_ENV } from '../../util/browser/windowEnvironment';
import { createSignal } from '../../util/signals';
import useLastCallback from '../useLastCallback';

// Android's WebView (and some phone browsers) never fire focus/blur when switching apps, and report no focus while
// a page loads off screen. Visibility and touches are what tell there whether someone is looking at the app
const [getIsInBackgroundLocal, setIsInBackground] = createSignal(
  document.hidden || (!IS_TOUCH_ENV && !document.hasFocus()),
);
export const getIsInBackground = getIsInBackgroundLocal;

function handleBlur() {
  if (IS_TOUCH_ENV) return;
  setIsInBackground(true);
}

function handleFocus() {
  if (document.hidden) return;
  setIsInBackground(false);
}

function handleVisibilityChange() {
  setIsInBackground(document.hidden || (!IS_TOUCH_ENV && !document.hasFocus()));
}

function handleInteraction() {
  if (getIsInBackground() && !document.hidden) setIsInBackground(false);
}

window.addEventListener('blur', handleBlur);
window.addEventListener('focus', handleFocus);
document.addEventListener('visibilitychange', handleVisibilityChange);
window.addEventListener('pointerdown', handleInteraction, { capture: true, passive: true });
window.addEventListener('keydown', handleInteraction, { capture: true, passive: true });

export default function useBackgroundMode(
  onBlur?: AnyToVoidFunction,
  onFocus?: AnyToVoidFunction,
  isDisabled = false,
) {
  const lastOnBlur = useLastCallback(onBlur);
  const lastOnFocus = useLastCallback(onFocus);

  useEffect(() => {
    if (isDisabled) {
      return undefined;
    }

    if (getIsInBackground()) {
      lastOnBlur();
    }

    return getIsInBackground.subscribe(() => {
      if (getIsInBackground()) {
        lastOnBlur();
      } else {
        lastOnFocus();
      }
    });
  }, [isDisabled, lastOnBlur, lastOnFocus]);
}

export function isBackgroundModeActive() {
  return getIsInBackground();
}
