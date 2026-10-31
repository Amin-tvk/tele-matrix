import { memo, useEffect, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import { SettingsScreens } from '../../../types';

import { selectCanSetPasscode } from '../../../global/selectors';
import { callApi } from '../../../api/gramjs';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';

import Island, { IslandDescription, IslandTitle } from '../../gili/layout/Island';
import ListItem from '../../ui/ListItem';

// Everything that protects the account in one place: the app lock, encryption keys, devices and last seen

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

type StateProps = {
  hasPasscode?: boolean;
  canSetPasscode?: boolean;
  autolockDuration?: number;
  sessionCount: number;
};

type EncryptionStatus = Awaited<ReturnType<typeof callApi<'fetchEncryptionStatus'>>>;

const MINUTE_MS = 60 * 1000;
const CALCULATOR_LOCK_EVENT = 'peyvandcalculatorlock';

// Set by the Android app (the calculator APK), which runs Tele inside itself
type AndroidBridge = {
  isCalculatorLockOn: () => boolean;
  openCalculatorLock: () => void;
};

function getAndroidBridge() {
  return (window as Window & { PeyvandAndroid?: AndroidBridge }).PeyvandAndroid;
}

function formatAutolock(duration?: number) {
  if (!duration) return 'Never locks by itself';
  const minutes = Math.round(duration / MINUTE_MS);
  if (minutes < 60) return `Locks after ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} away`;
  const hours = Math.round(minutes / 60);
  return `Locks after ${hours} ${hours === 1 ? 'hour' : 'hours'} away`;
}

function describeBackup(status?: EncryptionStatus) {
  if (!status) return 'Checking…';
  if (!status.isAvailable) return 'Not available in this browser';
  if (status.isDeviceBroken) return 'This device needs to be fixed';
  if (!status.hasKeyBackup) return 'Off: old messages are lost on a new device';
  if (status.isPasswordBased) return 'On, unlocked with your account password';
  return 'On, unlocked with your recovery key';
}

const SettingsSecurity = ({
  isActive, onReset, hasPasscode, canSetPasscode, autolockDuration, sessionCount,
}: OwnProps & StateProps) => {
  const { openSettingsScreen, openEncryptionRecoveryModal, lockScreen } = getActions();
  const lang = useLang();
  const [status, setStatus] = useState<EncryptionStatus>();
  const android = getAndroidBridge();
  const [isCalculatorLockOn, setIsCalculatorLockOn] = useState(() => Boolean(android?.isCalculatorLockOn()));

  useHistoryBack({ isActive, onBack: onReset });

  useEffect(() => {
    if (!isActive) return;
    void callApi('fetchEncryptionStatus').then(setStatus);
  }, [isActive]);

  useEffect(() => {
    if (!android) return undefined;
    const update = () => setIsCalculatorLockOn(android.isCalculatorLockOn());
    window.addEventListener(CALCULATOR_LOCK_EVENT, update);
    return () => window.removeEventListener(CALCULATOR_LOCK_EVENT, update);
  }, [android]);

  const isDeviceVerified = status?.isAvailable && status.isDeviceVerified;

  return (
    <div className="settings-content custom-scroll">
      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>App lock</IslandTitle>
      <Island>
        <ListItem
          icon="lock-filled"
          iconBg="blue"
          multiline
          narrow
          disabled={!canSetPasscode}
          onClick={() => openSettingsScreen({
            screen: hasPasscode ? SettingsScreens.PasscodeEnabled : SettingsScreens.PasscodeDisabled,
          })}
          rightElement={(
            <span className="settings-item__current-value">
              {lang(hasPasscode ? 'SettingsItemPrivacyOn' : 'SettingsItemPrivacyOff')}
            </span>
          )}
        >
          <span className="title">{lang('Passcode')}</span>
          <span className="subtitle">
            {hasPasscode ? formatAutolock(autolockDuration) : 'Ask for a code when Tele opens'}
          </span>
        </ListItem>
        {hasPasscode && (
          <ListItem icon="lock" iconBg="gray" narrow onClick={() => lockScreen()}>
            <span className="title">Lock now</span>
          </ListItem>
        )}
        {android && (
          <ListItem
            icon="eye-crossed"
            iconBg="orange"
            multiline
            narrow
            onClick={() => android.openCalculatorLock()}
            rightElement={(
              <span className="settings-item__current-value">
                {lang(isCalculatorLockOn ? 'SettingsItemPrivacyOn' : 'SettingsItemPrivacyOff')}
              </span>
            )}
          >
            <span className="title">Calculator lock</span>
            <span className="subtitle">
              {isCalculatorLockOn
                ? 'The app opens as a calculator until you type your calculation'
                : 'Open as a calculator, and show Tele only after your own calculation'}
            </span>
          </ListItem>
        )}
      </Island>
      <IslandDescription dir={lang.isRtl ? 'rtl' : undefined}>
        The passcode locks Tele on this device only. Change how soon it locks itself on the passcode screen.
      </IslandDescription>

      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>Encryption</IslandTitle>
      <Island>
        <ListItem
          icon="key-filled"
          iconBg="green"
          multiline
          narrow
          onClick={() => openEncryptionRecoveryModal()}
        >
          <span className="title">Message key backup</span>
          <span className="subtitle">{describeBackup(status)}</span>
        </ListItem>
        <ListItem
          icon={isDeviceVerified ? 'check' : 'info-filled'}
          iconBg={isDeviceVerified ? 'green' : 'orange'}
          multiline
          narrow
          onClick={() => openEncryptionRecoveryModal()}
        >
          <span className="title">This device</span>
          <span className="subtitle">
            {!status ? 'Checking…' : isDeviceVerified
              ? 'Verified: it can read your encrypted messages'
              : 'Not verified yet: verify it to read older encrypted messages'}
          </span>
        </ListItem>
      </Island>
      <IslandDescription dir={lang.isRtl ? 'rtl' : undefined}>
        Encrypted chats can only be read on your devices. The backup lets a new device read your earlier messages.
      </IslandDescription>

      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>Devices and privacy</IslandTitle>
      <Island>
        <ListItem
          icon="devices-filled"
          iconBg="blue"
          multiline
          narrow
          rightElement={sessionCount > 0
            ? <span className="settings-item__current-value">{sessionCount}</span>
            : undefined}
          onClick={() => openSettingsScreen({ screen: SettingsScreens.ActiveSessions })}
        >
          <span className="title">{lang('SessionsTitle')}</span>
          <span className="subtitle">See where you're signed in and sign out other devices</span>
        </ListItem>
        <ListItem
          icon="eye"
          iconBg="purple"
          multiline
          narrow
          onClick={() => openSettingsScreen({ screen: SettingsScreens.PrivacyLastSeen })}
        >
          <span className="title">{lang('PrivacyLastSeen')}</span>
          <span className="subtitle">{lang('PeyvandLastSeenDesc')}</span>
        </ListItem>
      </Island>
    </div>
  );
};

export default memo(withGlobal<OwnProps>((global): StateProps => ({
  hasPasscode: global.passcode?.hasPasscode,
  canSetPasscode: selectCanSetPasscode(global),
  autolockDuration: global.passcode?.autolockDuration,
  sessionCount: global.activeSessions.orderedHashes.length,
}))(SettingsSecurity));
