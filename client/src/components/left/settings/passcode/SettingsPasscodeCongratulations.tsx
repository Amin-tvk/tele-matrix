import type { FC } from '../../../../lib/teact/teact';
import { memo, useCallback, useMemo } from '../../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../../global';

import { STICKER_SIZE_PASSCODE } from '../../../../config';
import { LOCAL_TGS_URLS } from '../../../common/helpers/animatedAssets';
import { buildAutolockOptions } from './autolockOptions';

import useHistoryBack from '../../../../hooks/useHistoryBack';
import useLang from '../../../../hooks/useLang';
import useLastCallback from '../../../../hooks/useLastCallback';

import AnimatedIcon from '../../../common/AnimatedIcon';
import Island, { IslandTitle } from '../../../gili/layout/Island';
import Button from '../../../ui/Button';
import RadioGroup from '../../../ui/RadioGroup';

type OwnProps = {
  isActive?: boolean;
  onReset: (forceReturnToChatList?: boolean) => void;
};

type StateProps = {
  autolockDuration?: number;
};

const SettingsPasscodeCongratulations: FC<OwnProps & StateProps> = ({
  isActive, autolockDuration, onReset,
}) => {
  const { setPasscodeAutolockDuration } = getActions();
  const lang = useLang();

  // When to lock by itself is picked right away; it stays changeable in the passcode settings
  const autolockOptions = useMemo(() => buildAutolockOptions(lang), [lang]);
  const handleAutolockChange = useLastCallback((value: string) => {
    setPasscodeAutolockDuration({ duration: Number(value) || undefined });
  });

  const fullReset = useCallback(() => {
    onReset(true);
  }, [onReset]);

  useHistoryBack({ isActive, onBack: onReset });

  return (
    <div className="settings-content local-passcode custom-scroll">
      <div className="settings-content-header no-border">
        <AnimatedIcon
          size={STICKER_SIZE_PASSCODE}
          tgsUrl={LOCAL_TGS_URLS.Congratulations}
          className="settings-content-icon"
        />

        <p className="settings-item-description mb-3" dir="auto">
          {lang('SettingsPasscodeSuccess', undefined, { withNodes: true, renderTextFilters: ['br'] })}
        </p>
      </div>

      <IslandTitle dir={lang.isRtl ? 'rtl' : undefined}>{lang('PasscodeAutoLockTitle')}</IslandTitle>
      <Island>
        <RadioGroup
          name="passcode-autolock-new"
          options={autolockOptions}
          selected={String(autolockDuration || 0)}
          onChange={handleAutolockChange}
        />
      </Island>

      <Island>
        <Button onClick={fullReset}>{lang('Back')}</Button>
      </Island>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => ({
    autolockDuration: global.passcode.autolockDuration,
  }),
)(SettingsPasscodeCongratulations));
