import type { ChangeEvent } from 'react';
import {
  memo, useEffect, useRef, useState,
} from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import type { TabState } from '../../../global/types';

import { callApi } from '../../../api/gramjs';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';
import Modal from '../../ui/Modal';
import TextArea from '../../ui/TextArea';

import styles from './StoryComposerModal.module.scss';

export type OwnProps = {
  modal: TabState['storyComposerModal'];
};

type Picked = {
  blob: Blob;
  url: string;
  fileName: string;
  mimeType: string;
  isVideo: boolean;
  width?: number;
  height?: number;
  duration?: number;
};

const MAX_CAPTION_LENGTH = 1024;
// Photos are made smaller before upload so stories post quickly on weak connections
const MAX_PHOTO_SIDE = 2048;
const PHOTO_QUALITY = 0.85;
const MAX_VIDEO_DURATION_S = 120;

function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

function loadVideoInfo(url: string) {
  return new Promise<{ width: number; height: number; duration: number }>((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => resolve({
      width: video.videoWidth, height: video.videoHeight, duration: video.duration,
    });
    video.onerror = reject;
    video.src = url;
  });
}

async function preparePhoto(file: File): Promise<Picked> {
  const sourceUrl = URL.createObjectURL(file);
  const image = await loadImage(sourceUrl);
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  if (scale === 1 || file.type === 'image/gif') {
    return {
      blob: file, url: sourceUrl, fileName: file.name, mimeType: file.type, isVideo: false,
      width: image.naturalWidth, height: image.naturalHeight,
    };
  }
  const width = Math.round(image.naturalWidth * scale);
  const height = Math.round(image.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(image, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve) => {
    canvas.toBlob((result) => resolve(result!), 'image/jpeg', PHOTO_QUALITY);
  });
  URL.revokeObjectURL(sourceUrl);
  return {
    blob,
    url: URL.createObjectURL(blob),
    fileName: file.name.replace(/\.[^.]+$/, '.jpg'),
    mimeType: 'image/jpeg',
    isVideo: false,
    width,
    height,
  };
}

// People with the blue tick post a photo or video as a story for a day, optionally kept on their profile's Posts tab
const StoryComposerModal = ({ modal }: OwnProps) => {
  const { closeStoryComposerModal, showNotification } = getActions();
  const lang = useLang();
  const inputRef = useRef<HTMLInputElement>();

  const [picked, setPicked] = useState<Picked | undefined>();
  const [caption, setCaption] = useState('');
  const [isInProfile, setIsInProfile] = useState(true);
  const [isPosting, setIsPosting] = useState(false);

  const isOpen = Boolean(modal);

  useEffect(() => {
    if (isOpen) return;
    setPicked(undefined);
    setCaption('');
    setIsInProfile(true);
  }, [isOpen]);

  useEffect(() => (picked ? () => URL.revokeObjectURL(picked.url) : undefined), [picked]);

  const handleChoose = useLastCallback(() => inputRef.current?.click());
  const handleClose = useLastCallback(() => closeStoryComposerModal());

  const handleFile = useLastCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      if (file.type.startsWith('video/')) {
        const url = URL.createObjectURL(file);
        const info = await loadVideoInfo(url);
        if (info.duration > MAX_VIDEO_DURATION_S) {
          URL.revokeObjectURL(url);
          showNotification({ message: { key: 'PeyvandStoryVideoTooLong', variables: { count: MAX_VIDEO_DURATION_S } } });
          return;
        }
        setPicked({
          blob: file, url, fileName: file.name, mimeType: file.type, isVideo: true, ...info,
        });
      } else if (file.type.startsWith('image/')) {
        setPicked(await preparePhoto(file));
      }
    } catch {
      showNotification({ message: { key: 'SomethingWentWrong' } });
    }
  });

  const handlePost = useLastCallback(async () => {
    if (!picked || isPosting) return;
    setIsPosting(true);
    const result = await callApi('sendStory', {
      blob: picked.blob,
      fileName: picked.fileName,
      mimeType: picked.mimeType,
      caption: caption.trim() || undefined,
      isInProfile,
      width: picked.width,
      height: picked.height,
      duration: picked.duration,
    });
    setIsPosting(false);
    if (!result) {
      showNotification({ message: { key: 'SomethingWentWrong' } });
      return;
    }
    showNotification({ message: { key: 'PeyvandStoryPosted' } });
    closeStoryComposerModal();
  });

  return (
    <Modal
      isOpen={isOpen}
      title={lang('PeyvandStoryNew')}
      hasCloseButton
      className={styles.root}
      onClose={handleClose}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        className={styles.input}
        onChange={handleFile}
      />
      {picked ? (
        <button type="button" className={styles.preview} onClick={handleChoose} disabled={isPosting}>
          {picked.isVideo
            ? <video src={picked.url} muted autoPlay loop playsInline />
            : <img src={picked.url} alt="" />}
        </button>
      ) : (
        <button type="button" className={styles.picker} onClick={handleChoose}>
          {lang('PeyvandStoryChoose')}
        </button>
      )}
      <TextArea
        id="story-caption"
        label={lang('ComposerPlaceholderCaption')}
        value={caption}
        maxLength={MAX_CAPTION_LENGTH}
        disabled={isPosting}
        onChange={(e) => setCaption(e.target.value)}
      />
      <Checkbox
        label={lang('PeyvandStoryKeepOnProfile')}
        subLabel={lang('PeyvandStoryKeepOnProfileHint')}
        checked={isInProfile}
        disabled={isPosting}
        onCheck={setIsInProfile}
      />
      <div className="dialog-buttons">
        <Button className="confirm-dialog-button" isText onClick={handleClose}>{lang('Cancel')}</Button>
        <Button
          className="confirm-dialog-button"
          isText
          disabled={!picked}
          isLoading={isPosting}
          onClick={handlePost}
        >
          {lang('PeyvandStoryPost')}
        </Button>
      </div>
    </Modal>
  );
};

export default memo(StoryComposerModal);
