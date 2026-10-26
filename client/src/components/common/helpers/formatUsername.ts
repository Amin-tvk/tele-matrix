import { TME_LINK_PREFIX } from '../../../config';

const MATRIX_TO_PREFIX = 'https://matrix.to/#/';

export default function formatUsername(username: string, asAbsoluteLink?: boolean) {
  // Matrix room addresses (#name:server) are shown as they are and link through matrix.to,
  // which opens them in any Matrix app
  if (username.startsWith('#')) {
    return asAbsoluteLink ? `${MATRIX_TO_PREFIX}${username}` : username;
  }

  return asAbsoluteLink ? `${TME_LINK_PREFIX}${username}` : `@${username}`;
}
