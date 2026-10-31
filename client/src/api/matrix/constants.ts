export const MATRIX_HOMESERVER_URL = (import.meta.env.TG_APP_MATRIX_HOMESERVER || 'https://mtx.peyvand-yar.ir')
  .replace(/\/$/, '');

// Custom content key used to keep "Forwarded from" information when copying an event to another room
export const FORWARD_KEY = 'im.peyvand.forward';

export const THUMBNAIL_SEPARATOR = '~';

export const UNDECRYPTABLE_TEXT = '🔒 Waiting for this message';

// Second line under an unreadable message: what the reader can do about it, by why the key is missing
export const UNDECRYPTABLE_HINTS: Record<string, string> = {
  HISTORICAL_MESSAGE_USER_NOT_JOINED: 'It was sent before you joined, so it cannot be read.',
  HISTORICAL_MESSAGE_NO_KEY_BACKUP: 'Turn on message key backup on a device you used before, '
    + 'then it will appear here.',
  HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED: 'Open Settings › Privacy and Security › Message key backup '
    + 'to read older messages on this device.',
  MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE: 'The sender only shares keys with verified devices. '
    + 'Verify this device in Settings › Privacy and Security.',
  MEGOLM_KEY_WITHHELD: 'The sender did not share the key with this device.',
};
export const UNDECRYPTABLE_DEFAULT_HINT = 'If you use Tele on another device, open it there '
  + 'and this message will appear here within a minute.';

export const DEVICE_DISPLAY_NAME = 'Peyvand Web';

export const INITIAL_SYNC_LIMIT = 30;

// Must match the app ID in the Sygnal push gateway config
export const PUSH_APP_ID = import.meta.env.TG_APP_PUSH_APP_ID || 'ir.peyvand-yar.tele.web';

export const PUSH_GATEWAY_URL = `${MATRIX_HOMESERVER_URL}/_matrix/push/v1/notify`;

export const ROUND_VIDEO_KEY = 'im.peyvand.round_video';

// How long the server holds a sync request open when there is nothing new
export const SYNC_POLL_TIMEOUT_MS = 15000;

// Room state event holding a member's tag shown next to their name. Servers only let a user set state keys
// equal to their own ID when the key starts with "@", so the member's user ID is stored behind a prefix
export const MEMBER_TAG_EVENT = 'im.peyvand.member_tag';
// Group permissions Matrix can't enforce by event type (photos vs. files etc.); clients hide those buttons
export const PERMISSIONS_EVENT = 'im.peyvand.permissions';
export const MEMBER_TAG_KEY_PREFIX = 'member:';

// Account data event holding the user's chat folders
export const FOLDERS_EVENT = 'im.peyvand.chat_folders';
export const QUICK_REACTION_EVENT = 'im.peyvand.quick_reaction';
export const REACTION_USAGE_EVENT = 'im.peyvand.reaction_usage';

// Matrix VoIP signaling for one-to-one calls: invite, answer, candidates, select_answer, reject, hangup
export const CALL_EVENT_PREFIX = 'm.call.';
