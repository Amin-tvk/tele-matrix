import type { ChangeEvent, FormEvent } from 'react';
import {
  memo, useEffect, useMemo, useState,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { AdminInvite, AdminUser } from '../../../api/matrix/admin';
import type { ApiUser } from '../../../api/types';
import type { TabState } from '../../../global/types';

import { copyTextToClipboard } from '../../../util/clipboard';
import { callApi } from '../../../api/gramjs';

import useCurrentOrPrev from '../../../hooks/useCurrentOrPrev';
import useDebouncedCallback from '../../../hooks/useDebouncedCallback';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Avatar from '../../common/Avatar';
import Button from '../../ui/Button';
import ConfirmDialog from '../../ui/ConfirmDialog';
import InputText from '../../ui/InputText';
import ListItem from '../../ui/ListItem';
import Loading from '../../ui/Loading';
import Modal from '../../ui/Modal';
import TabList from '../../ui/TabList';

import styles from './ServerAdminModal.module.scss';

export type OwnProps = {
  modal: TabState['serverAdminModal'];
};

type StateProps = {
  usersById: Record<string, ApiUser>;
};

const INVITE_LINK_BASE = `${window.location.origin}/?token=`;
const SEARCH_DEBOUNCE_MS = 300;
const MIN_PASSWORD_LENGTH = 8;

type Confirmation = 'deactivate' | 'logout' | 'deleteInvite';

// Admin requests fail with server errors (for example a missing permission), which the modal reports as a toast
function tryApi<T>(promise: Promise<T>) {
  return promise.catch(() => undefined);
}

function formatDate(timestamp: number, locale: string) {
  return new Date(timestamp).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

const ServerAdminModal = ({ modal, usersById }: OwnProps & StateProps) => {
  const { closeServerAdminModal, openChat, showNotification } = getActions();
  const lang = useLang();

  const isOpen = Boolean(modal);
  useCurrentOrPrev(modal);

  const [activeTab, setActiveTab] = useState(0);
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<AdminUser[] | undefined>();
  const [totalUsers, setTotalUsers] = useState<number | undefined>();
  const [roomsCount, setRoomsCount] = useState<number | undefined>();
  const [invites, setInvites] = useState<AdminInvite[] | undefined>();
  const [selectedUserId, setSelectedUserId] = useState<string | undefined>();
  const [isBusy, setIsBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | undefined>();
  const [inviteToDelete, setInviteToDelete] = useState<string | undefined>();

  const [newPassword, setNewPassword] = useState('');
  const [isPasswordFormOpen, setIsPasswordFormOpen] = useState(false);
  const [isCreateFormOpen, setIsCreateFormOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [inviteUses, setInviteUses] = useState('1');
  const [inviteDays, setInviteDays] = useState('7');

  const selectedUser = useMemo(
    () => users?.find(({ userId }) => userId === selectedUserId), [users, selectedUserId],
  );

  const notify = useLastCallback((message: string) => {
    showNotification({ message });
  });

  const loadUsers = useLastCallback(async (searchQuery = query) => {
    const result = await tryApi(callApi('fetchAdminUsers', { query: searchQuery }));
    if (!result) {
      notify(lang('MatrixAdminError'));
      return;
    }
    setUsers(result.users);
    setTotalUsers(result.total);
    setRoomsCount(result.roomsCount);
  });

  const loadInvites = useLastCallback(async () => {
    const result = await tryApi(callApi('fetchAdminInvites'));
    if (result) setInvites(result);
  });

  const searchDebounced = useDebouncedCallback((value: string) => {
    void loadUsers(value);
  }, [], SEARCH_DEBOUNCE_MS, true);

  useEffect(() => {
    if (!isOpen) return;
    void loadUsers('');
    void loadInvites();
  }, [isOpen]);

  const resetUserForms = useLastCallback(() => {
    setIsPasswordFormOpen(false);
    setNewPassword('');
  });

  const handleClose = useLastCallback(() => {
    closeServerAdminModal();
    setSelectedUserId(undefined);
    setQuery('');
    setActiveTab(0);
    setIsCreateFormOpen(false);
    resetUserForms();
  });

  const handleBack = useLastCallback(() => {
    if (selectedUserId) {
      setSelectedUserId(undefined);
      resetUserForms();
      return;
    }
    handleClose();
  });

  const runAction = useLastCallback(async (action: () => Promise<unknown>, successMessage?: string) => {
    setIsBusy(true);
    const result = await action();
    setIsBusy(false);
    if (result === undefined || result === false) {
      notify(lang('MatrixAdminError'));
      return false;
    }
    if (successMessage) notify(successMessage);
    await loadUsers();
    return true;
  });

  const handleQueryChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    searchDebounced(e.target.value);
  });

  const handleSendMessage = useLastCallback(() => {
    if (!selectedUser) return;
    openChat({ id: selectedUser.peerId, shouldReplaceHistory: true });
    handleClose();
  });

  const handleToggleAdmin = useLastCallback(() => {
    if (!selectedUser) return;
    void runAction(
      () => tryApi(callApi('setUserServerAdmin', { userId: selectedUser.userId, isAdmin: !selectedUser.isAdmin })),
      lang('MatrixAdminSaved'),
    );
  });

  const handlePasswordSubmit = useLastCallback(async (e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    if (!selectedUser || newPassword.length < MIN_PASSWORD_LENGTH) return;
    const isReactivation = selectedUser.isDeactivated;
    const isDone = await runAction(
      () => {
        const { userId } = selectedUser;
        return isReactivation
          ? tryApi(callApi('setUserDeactivated', { userId, isDeactivated: false, password: newPassword }))
          : tryApi(callApi('resetUserPassword', { userId, password: newPassword }));
      },
      lang(isReactivation ? 'MatrixAdminReactivated' : 'MatrixAdminPasswordChanged'),
    );
    if (isDone) resetUserForms();
  });

  const handleConfirm = useLastCallback(async () => {
    const current = confirmation;
    setConfirmation(undefined);
    if (current === 'deleteInvite' && inviteToDelete) {
      const isDeleted = await tryApi(callApi('deleteAdminInvite', { token: inviteToDelete }));
      setInviteToDelete(undefined);
      if (!isDeleted) notify(lang('MatrixAdminError'));
      void loadInvites();
      return;
    }
    if (!selectedUser) return;
    if (current === 'deactivate') {
      void runAction(
        () => tryApi(callApi('setUserDeactivated', { userId: selectedUser.userId, isDeactivated: true })),
        lang('MatrixAdminDeactivated'),
      );
    } else if (current === 'logout') {
      void runAction(
        () => tryApi(callApi('logoutUserDevices', { userId: selectedUser.userId })),
        lang('MatrixAdminLoggedOut'),
      );
    }
  });

  const handleCreateUser = useLastCallback(async (e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    if (!newUsername.trim() || newUserPassword.length < MIN_PASSWORD_LENGTH) return;
    const isDone = await runAction(
      () => tryApi(callApi('createAdminUser', { username: newUsername, password: newUserPassword })),
      lang('MatrixAdminUserCreated'),
    );
    if (isDone) {
      setIsCreateFormOpen(false);
      setNewUsername('');
      setNewUserPassword('');
    }
  });

  const handleCreateInvite = useLastCallback(async (e?: FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    setIsBusy(true);
    const invite = await tryApi(callApi('createAdminInvite', {
      usesAllowed: Number(inviteUses) || undefined,
      validDays: Number(inviteDays) || undefined,
    }));
    setIsBusy(false);
    if (!invite) {
      notify(lang('MatrixAdminError'));
      return;
    }
    copyTextToClipboard(`${INVITE_LINK_BASE}${invite.token}`);
    notify(lang('MatrixAdminInviteCreated'));
    void loadInvites();
  });

  const handleCopyInvite = useLastCallback((token: string) => {
    copyTextToClipboard(`${INVITE_LINK_BASE}${token}`);
    notify(lang('MatrixAdminLinkCopied'));
  });

  function renderAvatar(user: AdminUser, size: 'medium' | 'large' = 'medium') {
    const peer = usersById[user.peerId];
    return peer
      ? <Avatar peer={peer} size={size} />
      : <Avatar text={user.displayName || user.userId.slice(1)} size={size} />;
  }

  function renderBadges(user: AdminUser) {
    return (
      <>
        {user.isAdmin && <span className={styles.badge}>{lang('MatrixAdminAdminBadge')}</span>}
        {user.isDeactivated && (
          <span className={`${styles.badge} ${styles.badgeDanger}`}>{lang('MatrixAdminDeactivatedBadge')}</span>
        )}
      </>
    );
  }

  function renderUserDetails(user: AdminUser) {
    return (
      <div className={styles.details}>
        <div className={styles.profile}>
          {renderAvatar(user, 'large')}
          <div className={styles.profileName}>{user.displayName || user.userId}</div>
          <div className={styles.profileId}>{user.userId}</div>
          <div className={styles.badges}>{renderBadges(user)}</div>
          {Boolean(user.createdAt) && (
            <div className={styles.profileId}>
              {lang('MatrixAdminJoined', { date: formatDate(user.createdAt, lang.code) })}
            </div>
          )}
        </div>

        {!user.isDeactivated && (
          <ListItem icon="message" onClick={handleSendMessage} disabled={isBusy}>
            {lang('MatrixAdminSendMessage')}
          </ListItem>
        )}
        {!user.isDeactivated && (
          <ListItem icon="admin" onClick={handleToggleAdmin} disabled={isBusy}>
            {lang(user.isAdmin ? 'MatrixAdminRemoveAdmin' : 'MatrixAdminMakeAdmin')}
          </ListItem>
        )}
        <ListItem
          icon={user.isDeactivated ? 'user' : 'key'}
          onClick={() => setIsPasswordFormOpen(!isPasswordFormOpen)}
          disabled={isBusy}
        >
          {lang(user.isDeactivated ? 'MatrixAdminReactivate' : 'MatrixAdminResetPassword')}
        </ListItem>
        {isPasswordFormOpen && (
          <form className={styles.inlineForm} onSubmit={handlePasswordSubmit}>
            <InputText
              id="admin-new-password"
              label={lang('MatrixAdminNewPassword')}
              value={newPassword}
              autoComplete="new-password"
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <Button
              type="submit"
              size="smaller"
              isLoading={isBusy}
              disabled={newPassword.length < MIN_PASSWORD_LENGTH}
            >
              {lang('Save')}
            </Button>
          </form>
        )}
        {!user.isDeactivated && (
          <ListItem icon="logout" onClick={() => setConfirmation('logout')} disabled={isBusy}>
            {lang('MatrixAdminLogoutDevices')}
          </ListItem>
        )}
        {!user.isDeactivated && (
          <ListItem icon="delete-user" destructive onClick={() => setConfirmation('deactivate')} disabled={isBusy}>
            {lang('MatrixAdminDeactivate')}
          </ListItem>
        )}
      </div>
    );
  }

  function renderUsers() {
    return (
      <div className={styles.section}>
        <div className={styles.toolbar}>
          <InputText
            id="admin-user-search"
            className={styles.search}
            label={lang('MatrixAdminSearchUsers')}
            value={query}
            onChange={handleQueryChange}
            autoComplete="off"
          />
          <Button size="smaller" color="translucent" onClick={() => setIsCreateFormOpen(!isCreateFormOpen)}>
            {lang('MatrixAdminCreateUser')}
          </Button>
        </div>
        {isCreateFormOpen && (
          <form className={styles.inlineForm} onSubmit={handleCreateUser}>
            <InputText
              id="admin-create-username"
              label={lang('MatrixAdminUsername')}
              value={newUsername}
              autoComplete="off"
              onChange={(e) => setNewUsername(e.target.value)}
            />
            <InputText
              id="admin-create-password"
              label={lang('MatrixAdminPassword')}
              value={newUserPassword}
              autoComplete="new-password"
              onChange={(e) => setNewUserPassword(e.target.value)}
            />
            <Button
              type="submit"
              size="smaller"
              isLoading={isBusy}
              disabled={!newUsername.trim() || newUserPassword.length < MIN_PASSWORD_LENGTH}
            >
              {lang('MatrixAdminCreateUser')}
            </Button>
          </form>
        )}
        {totalUsers !== undefined && (
          <div className={styles.stats}>
            {lang('MatrixAdminStats', { users: totalUsers, rooms: roomsCount ?? '—' })}
          </div>
        )}
        {!users ? <Loading /> : (
          <div className={styles.list}>
            {users.map((user) => (
              <ListItem
                key={user.userId}
                className="chat-item-clickable"
                leftElement={renderAvatar(user)}
                multiline
                onClick={() => setSelectedUserId(user.userId)}
              >
                <span className="title">
                  {user.displayName || user.userId}
                  {renderBadges(user)}
                </span>
                <span className="subtitle">{user.userId}</span>
              </ListItem>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderInvites() {
    return (
      <div className={styles.section}>
        <form className={styles.inviteForm} onSubmit={handleCreateInvite}>
          <InputText
            id="admin-invite-uses"
            label={lang('MatrixAdminInviteUses')}
            value={inviteUses}
            inputMode="numeric"
            onChange={(e) => setInviteUses(e.target.value.replace(/\D/g, ''))}
          />
          <InputText
            id="admin-invite-days"
            label={lang('MatrixAdminInviteDays')}
            value={inviteDays}
            inputMode="numeric"
            onChange={(e) => setInviteDays(e.target.value.replace(/\D/g, ''))}
          />
          <Button type="submit" size="smaller" isLoading={isBusy}>{lang('MatrixAdminCreateInvite')}</Button>
        </form>
        <div className={styles.hint}>{lang('MatrixAdminInviteHint')}</div>
        {!invites ? <Loading /> : !invites.length ? (
          <div className={styles.empty}>{lang('MatrixAdminNoInvites')}</div>
        ) : (
          <div className={styles.list}>
            {invites.map((invite) => (
              <ListItem
                key={invite.token}
                icon="link"
                multiline
                onClick={() => handleCopyInvite(invite.token)}
                contextActions={[{
                  title: lang('Delete'),
                  icon: 'delete',
                  destructive: true,
                  handler: () => {
                    setInviteToDelete(invite.token);
                    setConfirmation('deleteInvite');
                  },
                }]}
                rightElement={(
                  <Button
                    round
                    size="smaller"
                    color="translucent"
                    iconName="delete"
                    ariaLabel={lang('Delete')}
                    onClick={(e) => {
                      e.stopPropagation();
                      setInviteToDelete(invite.token);
                      setConfirmation('deleteInvite');
                    }}
                  />
                )}
              >
                <span className="title">{invite.token}</span>
                <span className="subtitle">
                  {lang('MatrixAdminInviteUsage', {
                    used: invite.completed,
                    total: invite.usesAllowed ?? '∞',
                  })}
                  {invite.expiresAt
                    ? ` · ${lang('MatrixAdminInviteExpires', { date: formatDate(invite.expiresAt, lang.code) })}`
                    : ''}
                </span>
              </ListItem>
            ))}
          </div>
        )}
      </div>
    );
  }

  const tabs = useMemo(() => [
    { title: lang('MatrixAdminUsers') },
    { title: lang('MatrixAdminInvites') },
  ], [lang]);

  return (
    <Modal
      isOpen={isOpen}
      title={selectedUser ? (selectedUser.displayName || selectedUser.userId) : lang('MatrixAdminTitle')}
      hasCloseButton
      isBackButton={Boolean(selectedUser)}
      className={styles.root}
      contentClassName={styles.content}
      onClose={selectedUser ? handleBack : handleClose}
    >
      {selectedUser ? renderUserDetails(selectedUser) : (
        <>
          <TabList tabs={tabs} activeTab={activeTab} onSwitchTab={setActiveTab} className={styles.tabs} />
          {activeTab === 0 ? renderUsers() : renderInvites()}
        </>
      )}
      <ConfirmDialog
        isOpen={Boolean(confirmation)}
        title={confirmation === 'deleteInvite' ? lang('MatrixAdminDeleteInvite')
          : confirmation === 'logout' ? lang('MatrixAdminLogoutDevices') : lang('MatrixAdminDeactivate')}
        text={confirmation === 'deleteInvite' ? lang('MatrixAdminDeleteInviteConfirm')
          : confirmation === 'logout' ? lang('MatrixAdminLogoutConfirm') : lang('MatrixAdminDeactivateConfirm')}
        confirmLabel={confirmation === 'logout' ? lang('MatrixAdminLogoutDevices') : lang('Delete')}
        confirmIsDestructive
        confirmHandler={handleConfirm}
        onClose={() => setConfirmation(undefined)}
      />
    </Modal>
  );
};

export default memo(withGlobal<OwnProps>((global): StateProps => ({
  usersById: global.users.byId,
}))(ServerAdminModal));
