import { memo, useEffect, useState } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import { LeftColumnContent, SettingsScreens } from '../../types';

import { selectCanSetPasscode, selectTabState } from '../../global/selectors';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import ConfirmDialog from '../ui/ConfirmDialog';

type StateProps = {
  currentUserId?: string;
  canOffer: boolean;
  isBusy: boolean;
};

const OFFERED_STORAGE_PREFIX = 'tt-passcode-offered-';
// Let the chat list settle first, so the question isn't the first thing flashing after signing in
const OFFER_DELAY_MS = 4000;

function wasOffered(userId: string) {
  try {
    return Boolean(localStorage.getItem(`${OFFERED_STORAGE_PREFIX}${userId}`));
  } catch {
    return true;
  }
}

function markOffered(userId: string) {
  try {
    localStorage.setItem(`${OFFERED_STORAGE_PREFIX}${userId}`, '1');
  } catch {
    // Not offering again isn't worth failing over
  }
}

// Once per account on each device, people are asked whether to protect the app with a passcode. It locks the app
// on demand and, by default, after an hour away; both can be changed in Privacy and Security
const PasscodeOfferModal = ({ currentUserId, canOffer, isBusy }: StateProps) => {
  const { openLeftColumnContent, openSettingsScreen } = getActions();
  const lang = useLang();
  const [isOpen, setIsOpen] = useState(false);

  const shouldOffer = Boolean(currentUserId) && canOffer && !wasOffered(currentUserId!);

  useEffect(() => {
    if (!shouldOffer || isBusy || isOpen) return undefined;
    const timeout = window.setTimeout(() => {
      markOffered(currentUserId!);
      setIsOpen(true);
    }, OFFER_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [shouldOffer, isBusy, isOpen, currentUserId]);

  const handleClose = useLastCallback(() => setIsOpen(false));

  const handleSetUp = useLastCallback(() => {
    setIsOpen(false);
    openLeftColumnContent({ contentKey: LeftColumnContent.Settings });
    openSettingsScreen({ screen: SettingsScreens.PasscodeDisabled });
  });

  return (
    <ConfirmDialog
      isOpen={isOpen}
      title={lang('PasscodeOfferTitle')}
      text={lang('PasscodeOfferText')}
      confirmLabel={lang('PasscodeOfferSetUp')}
      confirmHandler={handleSetUp}
      onClose={handleClose}
    />
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    const tabState = selectTabState(global);
    return {
      currentUserId: global.currentUserId,
      canOffer: Boolean(global.isSynced) && !global.passcode.hasPasscode && selectCanSetPasscode(global),
      // Encryption key questions come first on a new sign-in
      isBusy: Boolean(tabState.encryptionRecoveryModal || tabState.deviceVerificationModal),
    };
  },
)(PasscodeOfferModal));
