import { memo, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import { selectUser } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';
import { getEmojiImageUrl } from '../../../util/emoji/emoji';
import { callApi } from '../../../api/gramjs';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import VerifiedIcon from '../../common/VerifiedIcon';
import Island, { IslandDescription, IslandTitle } from '../../gili/layout/Island';

import styles from './VerifiedBadgePicker.module.scss';

type StateProps = {
  isVerified?: boolean;
  badgeEmoji?: string;
};

const BADGE_EMOJIS = [
  '🔥', '⭐', '💎', '👑', '🚀', '⚡', '❤', '💯', '🏆', '🎯', '🌟', '🦄', '🍀', '🎵', '📚', '💼',
];

// People given the blue tick by a server admin choose whether it shows as the tick or as an emoji
const VerifiedBadgePicker = ({ isVerified, badgeEmoji }: StateProps) => {
  const { showNotification } = getActions();
  const lang = useLang();
  const [isSaving, setIsSaving] = useState(false);

  const handleSelect = useLastCallback(async (emoji?: string) => {
    if (isSaving || emoji === (badgeEmoji || undefined)) return;
    setIsSaving(true);
    const result = await callApi('setMyBadgeEmoji', { emoji });
    setIsSaving(false);
    if (!result) showNotification({ message: { key: 'SomethingWentWrong' } });
  });

  if (!isVerified) return undefined;

  function renderOption(emoji?: string) {
    const isSelected = (emoji || '') === (badgeEmoji || '');
    const url = emoji ? getEmojiImageUrl(emoji) : undefined;
    return (
      <button
        key={emoji || 'tick'}
        type="button"
        className={buildClassName(styles.option, isSelected && styles.selected)}
        aria-pressed={isSelected}
        disabled={isSaving}
        onClick={() => handleSelect(emoji)}
      >
        {url ? <img src={url} alt={emoji} draggable={false} /> : <VerifiedIcon />}
      </button>
    );
  }

  return (
    <>
      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>{lang('PeyvandBadgeTitle')}</IslandTitle>
      <Island>
        <div className={styles.grid}>
          {renderOption(undefined)}
          {BADGE_EMOJIS.map((emoji) => renderOption(emoji))}
        </div>
      </Island>
      <IslandDescription dir={lang.isRtl ? 'rtl' : undefined}>{lang('PeyvandBadgeDescription')}</IslandDescription>
    </>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    const user = global.currentUserId ? selectUser(global, global.currentUserId) : undefined;
    return {
      isVerified: user?.isVerified,
      badgeEmoji: user?.badgeEmoji,
    };
  },
)(VerifiedBadgePicker));
