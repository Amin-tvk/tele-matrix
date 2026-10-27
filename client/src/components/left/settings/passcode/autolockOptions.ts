import type { LangFn } from '../../../../util/localization';
import type { IRadioOption } from '../../../ui/RadioGroup';

const AUTOLOCK_DURATIONS_MS = {
  disabled: 0,
  oneMinute: 60 * 1000,
  fiveMinutes: 5 * 60 * 1000,
  thirtyMinutes: 30 * 60 * 1000,
  oneHour: 60 * 60 * 1000,
};

export function buildAutolockOptions(lang: LangFn): IRadioOption[] {
  return [
    { value: String(AUTOLOCK_DURATIONS_MS.disabled), label: lang('PasscodeAutoLockDisabled') },
    { value: String(AUTOLOCK_DURATIONS_MS.oneMinute), label: lang('PasscodeAutoLock1Min') },
    { value: String(AUTOLOCK_DURATIONS_MS.fiveMinutes), label: lang('PasscodeAutoLock5Min') },
    { value: String(AUTOLOCK_DURATIONS_MS.thirtyMinutes), label: lang('PasscodeAutoLock30Min') },
    { value: String(AUTOLOCK_DURATIONS_MS.oneHour), label: lang('PasscodeAutoLock1Hour') },
  ];
}
