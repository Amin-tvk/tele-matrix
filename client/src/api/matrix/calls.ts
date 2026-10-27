import { Method } from 'matrix-js-sdk';

import { getClient, getDmRoomIdForUser } from './client';
import { CALL_EVENT_PREFIX } from './constants';
import { getUserIdByPeerId } from './ids';

// One-to-one voice and video calls use Matrix VoIP signaling (m.call.* events in the private chat), so they
// work with other Matrix apps too. The media itself flows between the two browsers over WebRTC; the
// connection is set up on the main thread, as workers have no WebRTC

export async function sendMatrixCallEvent({ userId, type, content }: {
  userId: string;
  type: string;
  content: Record<string, unknown>;
}) {
  if (!type.startsWith(CALL_EVENT_PREFIX)) return false;
  const matrixUserId = getUserIdByPeerId(userId);
  const roomId = matrixUserId ? getDmRoomIdForUser(matrixUserId) : undefined;
  if (!roomId) return false;
  // Custom event types aren't in the SDK's typed event map
  await getClient().sendEvent(roomId, type as never, content as never);
  return true;
}

type TurnServerResponse = {
  uris?: string[];
  username?: string;
  password?: string;
};

// Short-lived credentials for the homeserver's TURN relay, which connects calls behind strict NATs
export async function fetchMatrixCallIceServers(): Promise<RTCIceServer[]> {
  try {
    const response = await getClient().http.authedRequest<TurnServerResponse>(Method.Get, '/voip/turnServer');
    if (!response.uris?.length) return [];
    return [{ urls: response.uris, username: response.username, credential: response.password }];
  } catch {
    return [];
  }
}
