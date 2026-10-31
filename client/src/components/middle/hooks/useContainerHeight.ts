import type { ElementRef } from '../../../lib/teact/teact';
import { useEffect, useRef, useSignal } from '../../../lib/teact/teact';

import useLastCallback from '../../../hooks/useLastCallback';
import useResizeObserver from '../../../hooks/useResizeObserver';

export default function useContainerHeight(containerRef: ElementRef<HTMLDivElement>, isComposerVisible: boolean) {
  const [getContainerHeight, setContainerHeight] = useSignal<number | undefined>();

  // Container resize observer (caused by Composer reply/webpage panels)
  const handleResize = useLastCallback((entry: ResizeObserverEntry) => {
    setContainerHeight(entry.contentRect.height);
  });

  useResizeObserver(containerRef, handleResize);

  useEffect(() => {
    const { dataset } = containerRef.current!;
    const currentNormalHeight = Number(dataset.normalHeight) || 0;
    const containerHeight = getContainerHeight();
    if (!containerHeight || !isComposerVisible) return;

    // The normal height is the list without a grown composer. A phone keyboard shrinks the whole window instead;
    // keeping the taller height then would stop every scroll to a sent message a keyboard's height short
    const windowHeight = String(window.innerHeight);
    if (dataset.normalHeightWindow !== windowHeight) {
      dataset.normalHeightWindow = windowHeight;
      dataset.normalHeight = String(containerHeight);
    } else if (containerHeight > currentNormalHeight) {
      dataset.normalHeight = String(containerHeight);
    }
  }, [isComposerVisible, containerRef, getContainerHeight]);

  const prevContainerHeightRef = useRef<number>();

  return [getContainerHeight, prevContainerHeightRef] as const;
}
