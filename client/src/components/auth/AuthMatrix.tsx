import type { ChangeEvent, FormEvent } from 'react';
import {
  memo, useEffect, useMemo, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import { pick } from '../../util/iteratees';
import { Bundles, loadModule } from '../../util/moduleLoader';

import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';
import InputText from '../ui/InputText';

type StateProps = {
  auth: GlobalState['auth'];
};

const MAIN_BUNDLE_PRELOAD_DELAY = 500;

const AuthMatrix = ({
  auth,
}: StateProps) => {
  const { matrixLogin, matrixRegister, clearAuthErrorKey } = getActions();
  const lang = useLang();
  const { isLoading, errorKey } = auth;

  const initialToken = useMemo(() => new URLSearchParams(window.location.search).get('token') || '', []);
  const [isRegistration, setIsRegistration] = useState(Boolean(initialToken));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [passwordRepeat, setPasswordRepeat] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [token, setToken] = useState(initialToken);
  const [localErrorKey, setLocalErrorKey] = useState<'MatrixErrorPasswordsMismatch' | undefined>();

  // Downloads the chat UI while the user types, so it is ready right after signing in
  useEffect(() => {
    const timeout = setTimeout(() => {
      void loadModule(Bundles.Main);
    }, MAIN_BUNDLE_PRELOAD_DELAY);
    return () => clearTimeout(timeout);
  }, []);

  const errorText = errorKey ? lang.withRegular(errorKey) : undefined;
  const passwordRepeatErrorText = localErrorKey ? lang(localErrorKey) : undefined;

  const clearErrors = useLastCallback(() => {
    if (errorKey) clearAuthErrorKey();
    setLocalErrorKey(undefined);
  });

  const handleUsernameChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    clearErrors();
    // Matrix usernames are lowercase; phone keyboards often capitalize the first letter
    setUsername(e.target.value.toLowerCase().replace(/\s/g, ''));
  });

  const handlePasswordChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    clearErrors();
    setPassword(e.target.value);
  });

  const handlePasswordRepeatChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    clearErrors();
    setPasswordRepeat(e.target.value);
  });

  const handleDisplayNameChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setDisplayName(e.target.value);
  });

  const handleTokenChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    clearErrors();
    setToken(e.target.value);
  });

  const handleToggleMode = useLastCallback(() => {
    clearErrors();
    setIsRegistration(!isRegistration);
  });

  const handleSubmit = useLastCallback((e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isLoading) return;

    if (!isRegistration) {
      matrixLogin({ username, password });
      return;
    }

    if (password !== passwordRepeat) {
      setLocalErrorKey('MatrixErrorPasswordsMismatch');
      return;
    }

    matrixRegister({
      username, password, token, displayName,
    });
  });

  const canSubmit = Boolean(username && password && (!isRegistration || (passwordRepeat && token)));

  return (
    <div id="auth-matrix-form" className="custom-scroll">
      <div className="auth-form">
        <div id="logo" />
        <h1>{lang(isRegistration ? 'MatrixRegisterTitle' : 'MatrixLoginTitle')}</h1>
        <p className="note">{lang(isRegistration ? 'MatrixRegisterDescription' : 'MatrixLoginDescription')}</p>
        <form action="" method="post" onSubmit={handleSubmit}>
          {isRegistration && (
            <InputText
              id="matrix-display-name"
              label={lang('MatrixDisplayName')}
              value={displayName}
              onChange={handleDisplayNameChange}
              autoComplete="name"
            />
          )}
          <InputText
            id="matrix-username"
            label={lang('MatrixUsername')}
            value={username}
            error={errorText}
            onChange={handleUsernameChange}
            autoComplete="username"
            inputMode="email"
          />
          <InputText
            id="matrix-password"
            type="password"
            label={lang('MatrixPassword')}
            value={password}
            onChange={handlePasswordChange}
            autoComplete={isRegistration ? 'new-password' : 'current-password'}
          />
          {isRegistration && (
            <>
              <InputText
                id="matrix-password-repeat"
                type="password"
                label={lang('MatrixPasswordRepeat')}
                value={passwordRepeat}
                error={passwordRepeatErrorText}
                onChange={handlePasswordRepeatChange}
                autoComplete="new-password"
              />
              <InputText
                id="matrix-invite-token"
                label={lang('MatrixInviteToken')}
                value={token}
                onChange={handleTokenChange}
              />
            </>
          )}
          <Button type="submit" ripple isLoading={isLoading} disabled={!canSubmit}>
            {lang(isRegistration ? 'MatrixRegisterButton' : 'MatrixLoginButton')}
          </Button>
        </form>
        <Button isText className="auth-mode-switch" onClick={handleToggleMode}>
          {lang(isRegistration ? 'MatrixSwitchToLogin' : 'MatrixSwitchToRegister')}
        </Button>
      </div>
    </div>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => (
    pick(global, ['auth'])
  ),
)(AuthMatrix));
