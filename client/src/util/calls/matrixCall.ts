import { getActions, getGlobal, setGlobal } from '../../global';

import type { ApiPhoneCall, ApiUpdateMatrixCallEvent } from '../../api/types';

import { callApi } from '../../api/gramjs';
import { getServerTime } from '../serverTime';

// One-to-one calls over Matrix VoIP (version 1 of the m.call.* signaling). The call shown in the UI is
// `global.phoneCall`; this module owns the WebRTC side: devices, the peer connection and the signaling

const VOIP_VERSION = '1';
// How long an invite rings before it's treated as missed, as in the Matrix spec's examples
const INVITE_LIFETIME_MS = 60000;
// Candidates found in quick succession are sent in one event
const CANDIDATES_BATCH_MS = 200;
// A dropped connection often comes back by itself, e.g. when switching between Wi-Fi and mobile data
const DISCONNECTED_GRACE_MS = 10000;

type Streams = {
  ownAudio?: MediaStream;
  ownVideo?: MediaStream;
  video?: MediaStream;
  presentation?: MediaStream;
};

type Call = {
  callId: string;
  partyId: string;
  userId: string;
  isOutgoing: boolean;
  isVideo: boolean;
  offer?: RTCSessionDescriptionInit;
  remotePartyId?: string;
  connection?: RTCPeerConnection;
  localStream?: MediaStream;
  remoteStream?: MediaStream;
  remoteAudio?: HTMLAudioElement;
  // Candidates that arrive before the remote description is set
  pendingRemoteCandidates: RTCIceCandidateInit[];
  outgoingCandidates: RTCIceCandidateInit[];
  candidatesTimeout?: ReturnType<typeof setTimeout>;
  inviteTimeout?: ReturnType<typeof setTimeout>;
  disconnectedTimeout?: ReturnType<typeof setTimeout>;
  isEnded?: boolean;
};

let call: Call | undefined;
let streams: Streams = {};

function generateId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function getMatrixCallStreams() {
  return streams;
}

function updatePhoneCall(update: Partial<ApiPhoneCall>) {
  let global = getGlobal();
  if (!global.phoneCall || (call && global.phoneCall.id && global.phoneCall.id !== call.callId)) return;
  global = { ...global, phoneCall: { ...global.phoneCall, ...update } };
  setGlobal(global);
}

function sendCallEvent(type: string, content: Record<string, unknown>) {
  if (!call) return Promise.resolve(false);
  return callApi('sendMatrixCallEvent', {
    userId: call.userId,
    type: `m.call.${type}`,
    content: {
      call_id: call.callId, party_id: call.partyId, version: VOIP_VERSION, ...content,
    },
  });
}

async function getLocalStream(isVideo: boolean) {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: isVideo ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
  });
}

function updateStreams() {
  if (!call) {
    streams = {};
    return;
  }
  const { localStream, remoteStream } = call;
  const ownAudio = localStream?.getAudioTracks().length ? new MediaStream(localStream.getAudioTracks()) : undefined;
  const ownVideo = localStream?.getVideoTracks().length ? new MediaStream(localStream.getVideoTracks()) : undefined;
  const video = remoteStream?.getVideoTracks().length ? new MediaStream(remoteStream.getVideoTracks()) : undefined;
  streams = { ownAudio, ownVideo, video };
}

async function createConnection() {
  const iceServers = await callApi('fetchMatrixCallIceServers') || [];
  const current = call!;
  const connection = new RTCPeerConnection({ iceServers });
  current.connection = connection;

  connection.onicecandidate = ({ candidate }) => {
    if (!candidate || call !== current) return;
    current.outgoingCandidates.push(candidate.toJSON());
    if (current.candidatesTimeout) return;
    current.candidatesTimeout = setTimeout(() => {
      current.candidatesTimeout = undefined;
      const candidates = current.outgoingCandidates;
      current.outgoingCandidates = [];
      if (call === current && candidates.length) void sendCallEvent('candidates', { candidates });
    }, CANDIDATES_BATCH_MS);
  };

  connection.ontrack = ({ track, streams: [stream] }) => {
    if (call !== current) return;
    current.remoteStream = stream || new MediaStream([track]);
    if (track.kind === 'audio') {
      if (!current.remoteAudio) {
        current.remoteAudio = new Audio();
        current.remoteAudio.autoplay = true;
      }
      current.remoteAudio.srcObject = current.remoteStream;
      void current.remoteAudio.play().catch(() => undefined);
    }
    updateStreams();
    updatePhoneCall({ videoState: streams.video ? 'active' : 'inactive' });
  };

  connection.onconnectionstatechange = () => {
    if (call !== current) return;
    const { connectionState } = connection;
    if (connectionState === 'connected') {
      clearTimeout(current.disconnectedTimeout);
      current.disconnectedTimeout = undefined;
      const { phoneCall } = getGlobal();
      updatePhoneCall({ isConnected: true, startDate: phoneCall?.startDate || getServerTime() });
    } else if (connectionState === 'disconnected') {
      updatePhoneCall({ isConnected: false });
      clearTimeout(current.disconnectedTimeout);
      current.disconnectedTimeout = setTimeout(() => endCall('ice_failed'), DISCONNECTED_GRACE_MS);
    } else if (connectionState === 'failed') {
      endCall('ice_failed');
    }
  };

  current.localStream!.getTracks().forEach((track) => connection.addTrack(track, current.localStream!));
  return connection;
}

async function addRemoteCandidates(candidates: RTCIceCandidateInit[]) {
  const connection = call?.connection;
  if (!connection?.remoteDescription) {
    call?.pendingRemoteCandidates.push(...candidates);
    return;
  }
  for (const candidate of candidates) {
    // An empty candidate marks the end of the list
    if (!candidate.candidate) continue;
    await connection.addIceCandidate(candidate).catch(() => undefined);
  }
}

function flushPendingCandidates() {
  if (!call) return;
  const candidates = call.pendingRemoteCandidates;
  call.pendingRemoteCandidates = [];
  void addRemoteCandidates(candidates);
}

function releaseCall(ended: Call) {
  ended.isEnded = true;
  clearTimeout(ended.inviteTimeout);
  clearTimeout(ended.candidatesTimeout);
  clearTimeout(ended.disconnectedTimeout);
  ended.connection?.close();
  ended.localStream?.getTracks().forEach((track) => track.stop());
  if (ended.remoteAudio) {
    ended.remoteAudio.pause();
    ended.remoteAudio.srcObject = null; // eslint-disable-line no-null/no-null
  }
  if (call === ended) {
    call = undefined;
    updateStreams();
  }
}

// Ends the call on this side because of something other than the user's choice
function endCall(reason: 'ice_failed' | 'invite_timeout' | 'user_media_failed') {
  if (!call) return;
  void sendCallEvent('hangup', { reason });
  updatePhoneCall({ state: 'discarded', reason: reason === 'invite_timeout' ? 'missed' : 'disconnect' });
  releaseCall(call);
}

function showMediaError(isVideo: boolean) {
  getActions().showNotification({
    message: {
      key: isVideo ? 'CallCameraAccessNeeded' : 'CallMicrophoneAccessNeeded',
      options: { withNodes: true, withMarkdown: true, renderTextFilters: ['br', 'links'] },
    },
  });
}

export async function startMatrixCall() {
  const { phoneCall } = getGlobal();
  if (!phoneCall?.participantId || call) return;

  const current: Call = {
    callId: generateId(),
    partyId: generateId(),
    userId: phoneCall.participantId,
    isOutgoing: true,
    isVideo: Boolean(phoneCall.isVideo),
    pendingRemoteCandidates: [],
    outgoingCandidates: [],
  };
  call = current;
  updatePhoneCall({ id: current.callId, state: 'waiting' });

  try {
    current.localStream = await getLocalStream(current.isVideo);
  } catch {
    showMediaError(current.isVideo);
    updatePhoneCall({ state: 'discarded', reason: 'disconnect' });
    releaseCall(current);
    return;
  }
  if (current.isEnded) {
    releaseCall(current);
    return;
  }
  updateStreams();

  const connection = await createConnection();
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  if (current.isEnded) return;

  const isSent = await sendCallEvent('invite', {
    lifetime: INVITE_LIFETIME_MS,
    offer: { type: 'offer', sdp: offer.sdp },
  });
  if (!isSent) {
    updatePhoneCall({ state: 'discarded', reason: 'disconnect' });
    releaseCall(current);
    return;
  }
  if (call !== current) return;
  updatePhoneCall({ state: 'requested' });
  current.inviteTimeout = setTimeout(() => endCall('invite_timeout'), INVITE_LIFETIME_MS);
}

export async function acceptMatrixCall() {
  const current = call;
  if (!current || current.isOutgoing || !current.offer || current.connection) return;

  updatePhoneCall({ state: 'accepted' });
  try {
    current.localStream = await getLocalStream(current.isVideo);
  } catch {
    showMediaError(current.isVideo);
    void sendCallEvent('reject', {});
    updatePhoneCall({ state: 'discarded', reason: 'disconnect' });
    releaseCall(current);
    return;
  }
  if (current.isEnded) {
    releaseCall(current);
    return;
  }
  updateStreams();

  const connection = await createConnection();
  await connection.setRemoteDescription(current.offer);
  const answer = await connection.createAnswer();
  await connection.setLocalDescription(answer);
  if (current.isEnded) return;
  flushPendingCandidates();

  await sendCallEvent('answer', { answer: { type: 'answer', sdp: answer.sdp } });
  updatePhoneCall({ state: 'active' });
}

// The user ended or declined the call
export function hangUpMatrixCall() {
  if (!call) return;
  const isUnansweredIncoming = !call.isOutgoing && !call.connection;
  void sendCallEvent(isUnansweredIncoming ? 'reject' : 'hangup', isUnansweredIncoming ? {} : { reason: 'user_hangup' });
  releaseCall(call);
}

export function toggleMatrixCallTrack(kind: 'audio' | 'video') {
  const track = kind === 'audio' ? call?.localStream?.getAudioTracks()[0] : call?.localStream?.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  updateStreams();
  updatePhoneCall({ isMuted: kind === 'audio' ? !track.enabled : getGlobal().phoneCall?.isMuted });
}

export async function switchMatrixCallCamera() {
  const current = call;
  const oldTrack = current?.localStream?.getVideoTracks()[0];
  const sender = current?.connection?.getSenders().find((s) => s.track === oldTrack);
  if (!current || !oldTrack || !sender) return;

  const facingMode = oldTrack.getSettings().facingMode === 'environment' ? 'user' : 'environment';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode } });
    const newTrack = stream.getVideoTracks()[0];
    newTrack.enabled = oldTrack.enabled;
    await sender.replaceTrack(newTrack);
    current.localStream!.removeTrack(oldTrack);
    current.localStream!.addTrack(newTrack);
    oldTrack.stop();
    updateStreams();
    updatePhoneCall({});
  } catch {
    // Keeps the current camera
  }
}

function handleInvite(update: ApiUpdateMatrixCallEvent) {
  const { content, userId, age } = update;
  const lifetime = Number(content.lifetime) || INVITE_LIFETIME_MS;
  if (age > lifetime || !content.offer?.sdp) return;

  const { phoneCall, groupCalls } = getGlobal();
  // Already in a call: the caller hears a busy signal
  if (call || phoneCall || groupCalls.activeGroupCallId) {
    void callApi('sendMatrixCallEvent', {
      userId,
      type: 'm.call.hangup',
      content: {
        call_id: content.call_id, party_id: generateId(), version: VOIP_VERSION, reason: 'user_busy',
      },
    });
    return;
  }

  const offer: RTCSessionDescriptionInit = { type: 'offer', sdp: content.offer.sdp };
  const isVideo = /^m=video /m.test(content.offer.sdp);
  call = {
    callId: content.call_id,
    partyId: generateId(),
    userId,
    isOutgoing: false,
    isVideo,
    offer,
    remotePartyId: content.party_id,
    pendingRemoteCandidates: [],
    outgoingCandidates: [],
  };
  call.inviteTimeout = setTimeout(() => {
    if (!call?.connection) {
      updatePhoneCall({ state: 'discarded', reason: 'missed' });
      if (call) releaseCall(call);
    }
  }, lifetime - age);

  let global = getGlobal();
  global = {
    ...global,
    phoneCall: {
      id: content.call_id,
      state: 'requested',
      participantId: userId,
      adminId: userId,
      isVideo,
    },
  };
  setGlobal(global);
}

export function handleMatrixCallEvent(update: ApiUpdateMatrixCallEvent) {
  const { eventType, content, isOwn } = update;
  const type = eventType.replace(/^m\.call\./, '');

  if (type === 'invite') {
    if (!isOwn) handleInvite(update);
    return;
  }

  if (!call || content.call_id !== call.callId || content.party_id === call.partyId) return;

  if (isOwn) {
    // Answered or declined on another device of this account: stop ringing here
    if ((type === 'answer' || type === 'reject' || type === 'hangup') && !call.isOutgoing && !call.connection) {
      releaseCall(call);
      let global = getGlobal();
      global = { ...global, phoneCall: undefined };
      setGlobal(global);
      getActions().toggleGroupCallPanel({ force: undefined });
    }
    return;
  }

  // In a call with a party chosen, other devices of the same person are ignored
  if (call.remotePartyId && content.party_id !== call.remotePartyId) return;

  switch (type) {
    case 'answer': {
      if (!call.isOutgoing || call.remotePartyId || !content.answer?.sdp || !call.connection) return;
      const current = call;
      current.remotePartyId = content.party_id;
      clearTimeout(current.inviteTimeout);
      void sendCallEvent('select_answer', { selected_party_id: content.party_id });
      void current.connection!.setRemoteDescription({ type: 'answer', sdp: content.answer.sdp }).then(() => {
        if (call === current) flushPendingCandidates();
      });
      updatePhoneCall({ state: 'active' });
      break;
    }
    case 'candidates':
      if (Array.isArray(content.candidates)) void addRemoteCandidates(content.candidates);
      break;
    case 'reject':
    case 'hangup':
      updatePhoneCall({
        state: 'discarded',
        reason: content.reason === 'user_busy' ? 'busy' : call.connection || call.isOutgoing ? 'hangup' : 'missed',
      });
      releaseCall(call);
      break;
    default:
      break;
  }
}
