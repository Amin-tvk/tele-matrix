import type { ElementRef } from '../../../lib/teact/teact';
import { useEffect } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import { IS_TOUCH_ENV } from '../../../util/browser/windowEnvironment';

import useLastCallback from '../../../hooks/useLastCallback';

// Moves this far before deciding whether the gesture is a horizontal swipe or a scroll
const DIRECTION_THRESHOLD = 10;
// A swipe has to be this much more horizontal than vertical
const HORIZONTAL_RATIO = 1.5;
const COMPLETE_DISTANCE_RATIO = 0.35;
const FLING_MIN_DISTANCE = 50;
const FLING_MIN_VELOCITY = 0.5; // px per ms
const SETTLE_MIN_DURATION_MS = 120;
const SETTLE_MAX_DURATION_MS = 280;
// Decelerating curve, so a release continues at the finger's speed and then eases out
const SETTLE_EASING = 'cubic-bezier(0.2, 0.8, 0.3, 1)';
// The chat list moves slower than the chat for depth, like in Telegram's mobile apps
const LIST_PARALLAX_SHIFT = 0.3;
const LIST_MAX_DIM_OPACITY = 0.25;
// Without the chat list behind, the chat only moves a little to show the gesture is recognized
const PARTIAL_SHIFT_RATIO = 0.3;
// The chat closes on the next render; the swipe keeps the columns in place until then
const HANDOFF_MAX_FRAMES = 30;
const SWIPING_CLASS = 'swipe-back-active';
// Gestures that start on these keep their own meaning: inputs, seeking, horizontal scrolling and selection
const EXCLUDED_SELECTOR = [
  'input', 'textarea', '[contenteditable]', '.Composer', '.no-word-wrap', 'pre', 'code',
  '.RoundVideo.seekable', '.waveform', '.seekline', '[class*="seekline"]', '.AudioPlayer',
  '.Tabs', '.TabList', '.custom-scroll-x', '.MessageSelectToolbar', '.is-swiped',
].join(', ');

// Telegram-like swipe back on phones: dragging the open chat to the right goes back,
// revealing the chat list under the finger when the chat itself is being closed
export default function useSwipeBack({
  ref, isEnabled, isClosingChat, onBack,
}: {
  ref: ElementRef<HTMLDivElement>;
  isEnabled?: boolean;
  isClosingChat?: boolean;
  onBack: NoneToVoidFunction;
}) {
  const handleBack = useLastCallback(onBack);
  const getIsClosingChat = useLastCallback(() => Boolean(isClosingChat));

  useEffect(() => {
    const middleColumn = ref.current;
    if (!IS_TOUCH_ENV || !isEnabled || !middleColumn) return undefined;

    let startX = 0;
    let startY = 0;
    let isTracking: boolean | undefined;
    let isSettling = false;
    let shouldRevealList = false;
    let lastOffset = 0;
    let lastMoveTime = 0;
    let recentVelocity = 0;

    const getLeftColumn = () => document.getElementById('LeftColumn');

    let dimLayer: HTMLDivElement | undefined;

    const applyOffset = (offset: number, duration = 0) => {
      const transition = duration ? `transform ${duration}ms ${SETTLE_EASING}` : 'none';
      const width = middleColumn.offsetWidth || 1;
      const shift = shouldRevealList ? offset : offset * PARTIAL_SHIFT_RATIO;
      const progress = Math.min(1, offset / width);
      middleColumn.style.transition = transition;
      middleColumn.style.transform = `translate3d(${shift}px, 0, 0)`;
      middleColumn.style.boxShadow = shouldRevealList && offset ? '-0.5rem 0 1.5rem rgba(0, 0, 0, 0.15)' : '';

      const leftColumn = shouldRevealList ? getLeftColumn() : undefined;
      if (leftColumn) {
        // Its own dimming would stay on top of the swipe's and fade out again after it
        leftColumn.classList.add(SWIPING_CLASS);
        leftColumn.style.transition = transition;
        leftColumn.style.transform = `translate3d(${-LIST_PARALLAX_SHIFT * (1 - progress) * 100}%, 0, 0)`;

        if (!dimLayer) {
          dimLayer = document.createElement('div');
          dimLayer.style.cssText = 'position:absolute;inset:0;z-index:2;pointer-events:none;background:#000;';
          leftColumn.appendChild(dimLayer);
        }
        dimLayer.style.transition = duration ? `opacity ${duration}ms ${SETTLE_EASING}` : 'none';
        dimLayer.style.opacity = String(LIST_MAX_DIM_OPACITY * (1 - progress));
      }
    };

    const clearOffset = () => {
      [middleColumn, getLeftColumn()].forEach((element) => {
        if (!element) return;
        element.style.transition = '';
        element.style.transform = '';
        element.style.boxShadow = '';
      });
      getLeftColumn()?.classList.remove(SWIPING_CLASS);
      dimLayer?.remove();
      dimLayer = undefined;
    };

    // Once the chat is closed, the columns' classes put them where the swipe left them.
    // Waits for that, so the chat doesn't jump back and play the close animation a second time
    const handOffWhenClosed = (framesLeft = HANDOFF_MAX_FRAMES) => {
      const isClosed = document.getElementById('Main')?.classList.contains('left-column-open');
      if (!isClosed && framesLeft > 0) {
        requestAnimationFrame(() => handOffWhenClosed(framesLeft - 1));
        return;
      }
      clearOffset();
      [middleColumn, getLeftColumn()].forEach((element) => {
        if (element) element.style.transition = 'none';
      });
      requestAnimationFrame(() => {
        [middleColumn, getLeftColumn()].forEach((element) => {
          if (element) element.style.transition = '';
        });
        isSettling = false;
      });
    };

    const settle = (offset: number, velocity: number, onDone?: NoneToVoidFunction) => {
      isSettling = true;
      // Covers the rest of the way at about the release speed
      const distance = Math.abs(offset - lastOffset);
      const duration = Math.round(Math.min(SETTLE_MAX_DURATION_MS, Math.max(
        SETTLE_MIN_DURATION_MS, velocity > 0 ? distance / velocity : SETTLE_MAX_DURATION_MS,
      )));
      applyOffset(offset, duration);
      setTimeout(() => {
        if (onDone) {
          // The swipe already played the transition
          getActions().disableHistoryAnimations();
          onDone();
          requestAnimationFrame(() => handOffWhenClosed());
          return;
        }
        clearOffset();
        isSettling = false;
      }, duration);
    };

    const handleTouchStart = (e: TouchEvent) => {
      isTracking = undefined;
      if (isSettling || e.touches.length !== 1) {
        isTracking = false;
        return;
      }
      const target = e.target as HTMLElement;
      if (target.closest(EXCLUDED_SELECTOR) || window.getSelection()?.toString()) {
        isTracking = false;
        return;
      }

      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      lastOffset = 0;
      lastMoveTime = 0;
      recentVelocity = 0;
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (isTracking === false || e.touches.length !== 1) return;

      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;

      if (isTracking === undefined) {
        if (Math.abs(dx) < DIRECTION_THRESHOLD && Math.abs(dy) < DIRECTION_THRESHOLD) return;
        isTracking = dx > 0 && dx > Math.abs(dy) * HORIZONTAL_RATIO;
        if (!isTracking) return;
        // Measured from here, so the chat doesn't jump by the threshold
        startX = e.touches[0].clientX;
        shouldRevealList = getIsClosingChat();
      }

      if (e.cancelable) e.preventDefault();
      const offset = Math.max(0, e.touches[0].clientX - startX);
      const now = Date.now();
      if (lastMoveTime && now > lastMoveTime) {
        // Smoothed, so a single jittery frame doesn't decide the release
        recentVelocity = recentVelocity * 0.5 + ((offset - lastOffset) / (now - lastMoveTime)) * 0.5;
      }
      lastMoveTime = now;
      lastOffset = offset;
      requestAnimationFrame(() => {
        if (isTracking) applyOffset(lastOffset);
      });
    };

    const handleTouchEnd = () => {
      if (!isTracking) {
        isTracking = undefined;
        return;
      }
      isTracking = undefined;

      const width = middleColumn.offsetWidth;
      const velocity = recentVelocity;
      // A quick flick back to the left cancels even past the halfway point
      const isComplete = velocity > -FLING_MIN_VELOCITY && (
        lastOffset > width * COMPLETE_DISTANCE_RATIO
        || (lastOffset > FLING_MIN_DISTANCE && velocity > FLING_MIN_VELOCITY)
      );

      if (!isComplete) {
        settle(0, Math.abs(velocity));
        return;
      }

      if (shouldRevealList) {
        settle(width, velocity, handleBack);
      } else {
        handleBack();
        settle(0, velocity);
      }
    };

    middleColumn.addEventListener('touchstart', handleTouchStart, { passive: true });
    middleColumn.addEventListener('touchmove', handleTouchMove, { passive: false });
    middleColumn.addEventListener('touchend', handleTouchEnd, { passive: true });
    middleColumn.addEventListener('touchcancel', handleTouchEnd, { passive: true });

    return () => {
      middleColumn.removeEventListener('touchstart', handleTouchStart);
      middleColumn.removeEventListener('touchmove', handleTouchMove);
      middleColumn.removeEventListener('touchend', handleTouchEnd);
      middleColumn.removeEventListener('touchcancel', handleTouchEnd);
      clearOffset();
    };
  }, [ref, isEnabled]);
}
