import type { ApiSessionData } from '../types';

import { MATRIX_HOMESERVER_URL } from './constants';

export type MatrixSession = {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId: string;
};

const SESSION_DC_ID = 1;

let currentSession: MatrixSession | undefined;

export function getSession() {
  return currentSession;
}

export function setSession(session: MatrixSession | undefined) {
  currentSession = session;
}

// The Telegram session storage keeps auth keys per data center; the Matrix session is stored as one such key
export function buildSessionData(session: MatrixSession): ApiSessionData {
  return {
    mainDcId: SESSION_DC_ID,
    keys: { [SESSION_DC_ID]: JSON.stringify(session) },
  };
}

export function parseSessionData(sessionData?: ApiSessionData): MatrixSession | undefined {
  const raw = sessionData?.keys?.[SESSION_DC_ID];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as MatrixSession;
    if (!parsed.accessToken || !parsed.userId) return undefined;
    return { ...parsed, homeserver: parsed.homeserver || MATRIX_HOMESERVER_URL };
  } catch {
    return undefined;
  }
}

export function getAuthHeaders(): Record<string, string> {
  return currentSession ? { Authorization: `Bearer ${currentSession.accessToken}` } : {};
}

export function getHomeserverUrl() {
  return currentSession?.homeserver || MATRIX_HOMESERVER_URL;
}
