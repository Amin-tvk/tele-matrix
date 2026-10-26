import '../../global/actions/initial';

import { memo } from '../../lib/teact/teact';
import { withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import { IS_TAURI } from '../../util/browser/globalEnvironment';
import { IS_MAC_OS } from '../../util/browser/windowEnvironment';

import Transition from '../ui/Transition';
import AuthMatrix from './AuthMatrix';

import './Auth.scss';

type StateProps = {
  authState: GlobalState['auth']['state'];
};

const Auth = ({
  authState,
}: StateProps) => {
  return (
    <Transition
      activeKey={0}
      name="fade"
      className="Auth"
      data-tauri-drag-region={IS_TAURI && IS_MAC_OS ? true : undefined}
    >
      <AuthMatrix key={authState === 'authorizationStateLoggingOut' ? 'out' : 'in'} />
    </Transition>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    return {
      authState: global.auth.state,
    };
  },
)(Auth));
