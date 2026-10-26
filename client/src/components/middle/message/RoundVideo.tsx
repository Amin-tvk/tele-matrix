import {
  useEffect, useLayoutEffect,
  useRef, useSignal, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { ApiMessage } from '../../../api/types';
import type { GlobalState } from '../../../global/types';
import type { ObserveFn } from '../../../hooks/useIntersectionObserver';
import { ApiMediaFormat } from '../../../api/types';

import {
  getMediaFormat,
  getVideoMediaHash,
  hasMessageTtl,
} from '../../../global/helpers';
import { selectTabState } from '../../../global/selectors';
import { stopCurrentAudio } from '../../../util/audioPlayback/playbackController';
import buildClassName from '../../../util/buildClassName';
import { formatMediaDuration } from '../../../util/dates/duration';
import safePlay from '../../../util/safePlay';
import { ROUND_VIDEO_DIMENSIONS_PX } from '../../common/helpers/mediaDimensions';
import {
  formatPlaybackRate, getActivePlaybackRate, getNextPlaybackRate, REGULAR_PLAYBACK_RATE,
} from '../../common/helpers/playbackRates';

import useSelector from '../../../hooks/data/useSelector';
import useThumbnail from '../../../hooks/media/useThumbnail';
import { useThrottledSignal } from '../../../hooks/useAsyncResolvers';
import useFlag from '../../../hooks/useFlag';
import { useIsIntersecting } from '../../../hooks/useIntersectionObserver';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useMediaTransition from '../../../hooks/useMediaTransition';
import useMediaWithLoadProgress from '../../../hooks/useMediaWithLoadProgress';
import usePreviousDeprecated from '../../../hooks/usePreviousDeprecated';
import useShowTransition from '../../../hooks/useShowTransition';
import useBlurredMediaThumbRef from './hooks/useBlurredMediaThumbRef';

import Icon from '../../common/icons/Icon';
import MediaSpoiler from '../../common/MediaSpoiler';
import Button from '../../ui/Button';
import OptimizedVideo from '../../ui/OptimizedVideo';
import ProgressSpinner from '../../ui/ProgressSpinner';
import MediaBadge from './MediaBadge';

import './RoundVideo.scss';
import styles from './media.module.scss';

type OwnProps = {
  message: ApiMessage;
  className?: string;
  canAutoLoad?: boolean;
  isDownloading?: boolean;
  origin?: 'oneTimeModal';
  observeIntersection?: ObserveFn;
  onStop?: NoneToVoidFunction;
  onReadMedia?: NoneToVoidFunction;
  onHideTranscription?: (isHidden: boolean) => void;
  isTranscriptionError?: boolean;
  canTranscribe?: boolean;
  isTranscribed?: boolean;
  isTranscriptionHidden?: boolean;
  isTranscribing?: boolean;
};

const PROGRESS_CENTER = ROUND_VIDEO_DIMENSIONS_PX / 2;
const PROGRESS_MARGIN = 6;
const PROGRESS_CIRCUMFERENCE = (PROGRESS_CENTER - PROGRESS_MARGIN) * 2 * Math.PI;
const PROGRESS_THROTTLE = 16; // Min period needed for `playerEl.currentTime` to update
// Touches farther from the center than this share of the radius grab the progress ring to seek, like in Telegram
const SEEK_RING_MIN_DISTANCE = 0.55;

// Video messages follow the speed chosen for voice messages
const selectPlaybackRate = (global: GlobalState) => {
  const { playbackRate, isPlaybackRateActive } = selectTabState(global).audioPlayer;
  return getActivePlaybackRate(playbackRate, isPlaybackRateActive);
};

let stopPrevious: NoneToVoidFunction;

const RoundVideo = ({
  message,
  className,
  canAutoLoad,
  isDownloading,
  origin,
  observeIntersection,
  onStop,
  onReadMedia,
  isTranscriptionError,
  isTranscribed,
  canTranscribe,
  onHideTranscription,
  isTranscriptionHidden,
  isTranscribing,
}: OwnProps) => {
  const ref = useRef<HTMLDivElement>();
  const playerRef = useRef<HTMLVideoElement>();
  const circleRef = useRef<SVGCircleElement>();

  const {
    cancelMediaDownload, openOneTimeMediaModal, transcribeAudio, setAudioPlayerPlaybackRate,
  } = getActions();
  const lang = useLang();

  const isIntersecting = useIsIntersecting(ref, observeIntersection);

  const video = message.content.video!;
  const isMediaUnread = message.isMediaUnread;

  const [isLoadAllowed, setIsLoadAllowed] = useState(canAutoLoad);
  const shouldLoad = Boolean(isLoadAllowed && isIntersecting);
  const { mediaData, loadProgress } = useMediaWithLoadProgress(
    getVideoMediaHash(video, 'inline'),
    !shouldLoad,
    getMediaFormat(video, 'inline'),
  );
  const fullMediaData = video.blobUrl || mediaData;

  const { loadProgress: downloadProgress } = useMediaWithLoadProgress(
    getVideoMediaHash(video, 'download'),
    !isDownloading,
    ApiMediaFormat.BlobUrl,
  );

  const [isPlayerReady, markPlayerReady] = useFlag();
  const hasTtl = hasMessageTtl(message);
  const isInOneTimeModal = origin === 'oneTimeModal';
  const shouldRenderSpoiler = hasTtl && !isInOneTimeModal;
  const thumbDataUri = useThumbnail(message);
  const hasThumb = Boolean(thumbDataUri);
  const noThumb = !hasThumb || isPlayerReady || shouldRenderSpoiler;
  const thumbRef = useBlurredMediaThumbRef(video, noThumb);
  useMediaTransition({ hasMediaData: !noThumb, ref: thumbRef });

  const isTransferring = (isLoadAllowed && !isPlayerReady) || isDownloading;
  const wasLoadDisabled = usePreviousDeprecated(isLoadAllowed) === false;

  const {
    ref: spinnerRef,
    shouldRender: shouldRenderSpinner,
  } = useShowTransition({
    isOpen: isTransferring,
    noMountTransition: wasLoadDisabled,
    withShouldRender: true,
  });

  const [isActivated, setIsActivated] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const [getProgress, setProgress] = useSignal(0);
  const getThrottledProgress = useThrottledSignal(getProgress, PROGRESS_THROTTLE);

  useEffect(() => {
    if (!isActivated) {
      return;
    }

    const playerEl = playerRef.current!;
    setProgress(playerEl.currentTime / playerEl.duration);
  }, [setProgress, isActivated, getThrottledProgress]);

  useLayoutEffect(() => {
    if (!isActivated || !circleRef.current) {
      return;
    }

    const strokeDashOffset = PROGRESS_CIRCUMFERENCE - getThrottledProgress() * PROGRESS_CIRCUMFERENCE;
    circleRef.current.setAttribute('stroke-dashoffset', strokeDashOffset.toString());
  }, [isActivated, getThrottledProgress]);

  const shouldPlay = Boolean(fullMediaData && isIntersecting);
  const playbackRate = useSelector(selectPlaybackRate);

  useEffect(() => {
    const playerEl = playerRef.current;
    if (playerEl) playerEl.playbackRate = isActivated ? playbackRate : REGULAR_PLAYBACK_RATE;
  }, [isActivated, playbackRate, fullMediaData]);

  const handlePlaybackRateClick = useLastCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const nextRate = getNextPlaybackRate(playbackRate);
    setAudioPlayerPlaybackRate({
      playbackRate: nextRate,
      isPlaybackRateActive: nextRate !== REGULAR_PLAYBACK_RATE,
    });
  });

  const stopPlaying = useLastCallback(() => {
    if (!playerRef.current) {
      return;
    }

    setIsActivated(false);
    setProgress(0);
    safePlay(playerRef.current);
  });

  const capturePlaying = useLastCallback(() => {
    stopPrevious?.();
    stopPrevious = stopPlaying;
  });

  const togglePlaying = useLastCallback(() => {
    const playerEl = playerRef.current!;
    if (isActivated) {
      if (playerEl.paused) {
        safePlay(playerEl);
        stopCurrentAudio();
      } else {
        playerEl.pause();
      }
    } else {
      capturePlaying();
      // Pause is a workaround for iOS Safari – otherwise it stops video after several frames
      playerEl.pause();
      playerEl.currentTime = 0;
      safePlay(playerEl);
      stopCurrentAudio();
      setIsActivated(true);
    }
  });

  useEffect(() => {
    if (!isInOneTimeModal) {
      return;
    }
    togglePlaying();
  }, [isInOneTimeModal]);

  const isSeekingRef = useRef(false);
  const wasSeekingRef = useRef(false);

  // Seeking by dragging along the progress ring of a playing video
  useEffect(() => {
    const element = ref.current;
    if (!element || !isActivated || isInOneTimeModal) return undefined;

    const getSeekFraction = (e: PointerEvent | TouchEvent) => {
      const point = 'touches' in e ? e.touches[0] : e;
      if (!point) return undefined;
      const { left, top, width } = element.getBoundingClientRect();
      const radius = width / 2;
      const x = point.clientX - left - radius;
      const y = point.clientY - top - radius;
      if (Math.hypot(x, y) < radius * SEEK_RING_MIN_DISTANCE) return undefined;
      // Angle from 12 o'clock, clockwise
      const angle = Math.atan2(x, -y);
      return (angle < 0 ? angle + 2 * Math.PI : angle) / (2 * Math.PI);
    };

    const seekTo = (fraction: number) => {
      const playerEl = playerRef.current;
      if (!playerEl || !Number.isFinite(playerEl.duration)) return;
      playerEl.currentTime = fraction * playerEl.duration;
      setProgress(fraction);
      setCurrentTime(Math.floor(playerEl.currentTime));
    };

    const handleTouchStart = (e: TouchEvent) => {
      // Keeps the message from treating the drag as a swipe to reply
      if (getSeekFraction(e) !== undefined) e.stopPropagation();
    };

    const handlePointerDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('.transcribe-button, .round-video-speed')) return;
      const fraction = getSeekFraction(e);
      if (fraction === undefined) return;
      isSeekingRef.current = true;
      wasSeekingRef.current = false;
      element.setPointerCapture(e.pointerId);
    };

    const handlePointerMove = (e: PointerEvent) => {
      if (!isSeekingRef.current) return;
      const fraction = getSeekFraction(e);
      if (fraction === undefined) return;
      wasSeekingRef.current = true;
      seekTo(fraction);
    };

    const handlePointerUp = (e: PointerEvent) => {
      if (!isSeekingRef.current) return;
      isSeekingRef.current = false;
      const fraction = getSeekFraction(e);
      // A tap on the ring seeks too, instead of pausing
      if (fraction !== undefined) {
        wasSeekingRef.current = true;
        seekTo(fraction);
      }
    };

    const handlePointerCancel = () => {
      isSeekingRef.current = false;
    };

    element.addEventListener('touchstart', handleTouchStart, { passive: true });
    element.addEventListener('pointerdown', handlePointerDown);
    element.addEventListener('pointermove', handlePointerMove);
    element.addEventListener('pointerup', handlePointerUp);
    element.addEventListener('pointercancel', handlePointerCancel);
    return () => {
      element.removeEventListener('touchstart', handleTouchStart);
      element.removeEventListener('pointerdown', handlePointerDown);
      element.removeEventListener('pointermove', handlePointerMove);
      element.removeEventListener('pointerup', handlePointerUp);
      element.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, [isActivated, isInOneTimeModal, setProgress]);

  const handleClick = useLastCallback((event) => {
    if (event.target.closest('.transcribe-button')) {
      return;
    }

    if (wasSeekingRef.current) {
      wasSeekingRef.current = false;
      return;
    }

    if (!fullMediaData) {
      setIsLoadAllowed((isAllowed) => !isAllowed);

      return;
    }

    if (isDownloading) {
      cancelMediaDownload({ media: video });
      return;
    }

    if (hasTtl && !isInOneTimeModal) {
      openOneTimeMediaModal({ message });
      onReadMedia?.();
      return;
    }

    togglePlaying();
  });

  useEffect(() => {
    if (onReadMedia && isMediaUnread && isActivated) {
      onReadMedia();
    }
  }, [isActivated, isMediaUnread, onReadMedia]);

  const handleTimeUpdate = useLastCallback((e: React.UIEvent<HTMLVideoElement>) => {
    const playerEl = e.currentTarget;
    setProgress(playerEl.currentTime / playerEl.duration);
    setCurrentTime(Math.floor(playerEl.currentTime));
  });

  const handleTranscribe = useLastCallback(() => {
    transcribeAudio({ chatId: message.chatId, messageId: message.id });
  });

  function renderPlayWrapper() {
    return (
      <div className="play-wrapper">
        <Button
          color="dark"
          round
          size="smaller"
          className="play"
          nonInteractive
          iconName="play"
          iconClassName="play-icon"
        />
        <Icon name="view-once" className="view-once-icon" />
      </div>
    );
  }

  const handleButtonClick = useLastCallback(() => {
    if ((isTranscribed || isTranscriptionError) && onHideTranscription) {
      onHideTranscription(!isTranscriptionHidden);
    } else if (!isTranscribing) {
      handleTranscribe();
    }
  });

  return (
    <div
      ref={ref}
      className={buildClassName(
        'RoundVideo',
        'media-inner',
        isInOneTimeModal && 'non-interactive',
        isActivated && !isInOneTimeModal && 'seekable',
        className,
      )}
      onClick={handleClick}
    >
      {fullMediaData && (
        <div className="video-wrapper">
          {shouldRenderSpoiler && (
            <MediaSpoiler
              isVisible
              thumbDataUri={thumbDataUri}
              width={ROUND_VIDEO_DIMENSIONS_PX}
              height={ROUND_VIDEO_DIMENSIONS_PX}
              className="media-spoiler"
            />
          )}
          <OptimizedVideo
            canPlay={shouldPlay}
            ref={playerRef}
            src={fullMediaData}
            className="full-media"
            width={ROUND_VIDEO_DIMENSIONS_PX}
            height={ROUND_VIDEO_DIMENSIONS_PX}
            autoPlay={!shouldRenderSpoiler}
            disablePictureInPicture
            muted={!isActivated}
            defaultMuted
            loop={!isActivated}
            playsInline
            isPriority
            onEnded={isActivated ? onStop ?? stopPlaying : undefined}
            onTimeUpdate={isActivated ? handleTimeUpdate : undefined}
            onReady={markPlayerReady}
          />
        </div>
      )}
      {!shouldRenderSpoiler && (
        <canvas
          ref={thumbRef}
          className="thumbnail"
          style={`width: ${ROUND_VIDEO_DIMENSIONS_PX}px; height: ${ROUND_VIDEO_DIMENSIONS_PX}px`}
        />
      )}
      <div className="progress">
        {isActivated && (
          <svg width={ROUND_VIDEO_DIMENSIONS_PX} height={ROUND_VIDEO_DIMENSIONS_PX}>
            <circle
              ref={circleRef}
              cx={PROGRESS_CENTER}
              cy={PROGRESS_CENTER}
              r={PROGRESS_CENTER - PROGRESS_MARGIN}
              className="progress-circle"
              transform={`rotate(-90, ${PROGRESS_CENTER}, ${PROGRESS_CENTER})`}
              stroke-dasharray={PROGRESS_CIRCUMFERENCE}
              stroke-dashoffset={PROGRESS_CIRCUMFERENCE}
            />
          </svg>
        )}
      </div>
      {shouldRenderSpinner && (
        <div ref={spinnerRef} className={buildClassName('media-loading', styles.loading)}>
          <ProgressSpinner progress={isDownloading ? downloadProgress : loadProgress} />
        </div>
      )}
      {shouldRenderSpoiler && !shouldRenderSpinner && renderPlayWrapper()}
      {!fullMediaData && !isLoadAllowed && (
        <Icon name="download" className={buildClassName(styles.controlButton, styles.downloadButton)} />
      )}
      {!isInOneTimeModal && (
        <MediaBadge
          className={buildClassName(
            'message-media-duration', isMediaUnread && 'unread',
          )}
        >
          {isActivated ? formatMediaDuration(currentTime) : formatMediaDuration(video.duration)}
          {(!isActivated || playerRef.current!.paused) && <Icon name="muted" className="muted-icon" />}
        </MediaBadge>
      )}
      {isActivated && !isInOneTimeModal && (
        <button
          type="button"
          className={buildClassName('round-video-speed', playbackRate !== REGULAR_PLAYBACK_RATE && 'applied')}
          aria-label={lang('AudioPlaybackRate')}
          onClick={handlePlaybackRateClick}
        >
          {formatPlaybackRate(playbackRate)}
        </button>
      )}
      {canTranscribe && (
        <Button
          onClick={handleButtonClick}
          className="transcribe-button"
        >
          {isTranscribed || isTranscriptionError ? <Icon name="down" /> : <Icon name="transcribe" />}
          {isTranscribing && (
            <svg viewBox="0 0 32 24" className="loading-svg">
              <rect
                className="loading-rect"
                fill="transparent"
                width="32"
                height="24"
                stroke-width="3"
                stroke-linejoin="round"
                rx="6"
                ry="6"
                stroke="white"
                stroke-dashoffset="1"
                stroke-dasharray="32,68"
              />
            </svg>
          )}
        </Button>
      )}
    </div>
  );
};

export default RoundVideo;
