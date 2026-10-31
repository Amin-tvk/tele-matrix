import { getActions, getGlobal, setGlobal } from '../../global';

import type { ApiUpdateMatrixGroupCall, ApiUpdateMatrixGroupCallSignal } from '../../api/types';
import type { GlobalState } from '../../global/types';

import { callApi } from '../../api/gramjs';

// Group voice chats over Matrix: this device connects to every other participant directly (a WebRTC mesh). The worker
// tracks who is in the call (api/matrix/groupCalls.ts); here live the microphone, one peer connection per participant
// and their set-up. The device with the smaller `userId|deviceId` makes the offer, so two never offer at once

export const MAX_GROUP_CALL_PARTICIPANTS = 6;
// Must stay well under the worker's GROUP_CALL_MEMBER_TIMEOUT_MS
const PING_INTERVAL_MS = 60 * 1000;
const CANDIDATES_BATCH_MS = 200;
const SPEAKING_CHECK_MS = 250;
const SPEAKING_LEVEL = 0.015;
// A dropped connection is set up again after this long, by the side that makes offers
const RECONNECT_DELAY_MS = 3000;

type ActiveState = NonNullable<NonNullable<GlobalState['matrixGroupCalls']>['active']>;

type Peer = {
  key: string;
  userId: string;
  deviceId: string;
  isInitiator: boolean;
  connection: RTCPeerConnection;
  audio?: HTMLAudioElement;
  analyser?: AnalyserNode;
  pendingRemoteCandidates: RTCIceCandidateInit[];
  outgoingCandidates: RTCIceCandidateInit[];
  candidatesTimeout?: ReturnType<typeof setTimeout>;
  reconnectTimeout?: ReturnType<typeof setTimeout>;
  isConnected?: boolean;
  isMuted?: boolean;
  // Seen in the participant list; one that only greeted may not be in it yet
  isListed?: boolean;
};

type ActiveCall = {
  chatId: string;
  callId: string;
  myKey: string;
  localStream: MediaStream;
  iceServers: RTCIceServer[];
  peers: Map<string, Peer>;
  // Participants told that this device joined, who make the offer to it
  greetedKeys: Set<string>;
  pingInterval?: ReturnType<typeof setInterval>;
  speakingInterval?: ReturnType<typeof setInterval>;
  audioContext?: AudioContext;
  localAnalyser?: AnalyserNode;
  isMuted: boolean;
  isSoundOff: boolean;
};

let active: ActiveCall | undefined;

function generateId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function keyOf(userId: string, deviceId: string) {
  return `${userId}|${deviceId}`;
}

function setActiveState(update?: Partial<ActiveState>) {
  let global = getGlobal();
  const groupCalls = global.matrixGroupCalls || { byChatId: {} };
  const activeState: ActiveState | undefined = active && update !== undefined ? {
    chatId: active.chatId,
    callId: active.callId,
    isMuted: active.isMuted,
    isScreenOpen: groupCalls.active?.isScreenOpen ?? true,
    isSoundOff: active.isSoundOff,
    connectedKeys: [...active.peers.values()].filter((peer) => peer.isConnected).map((peer) => peer.key),
    mutedKeys: [...active.peers.values()].filter((peer) => peer.isMuted).map((peer) => peer.key),
    speakingKeys: groupCalls.active?.speakingKeys || [],
    ...update,
  } : undefined;
  global = { ...global, matrixGroupCalls: { ...groupCalls, active: activeState } };
  setGlobal(global);
}

export function handleMatrixGroupCallUpdate(update: ApiUpdateMatrixGroupCall) {
  const { chatId, callId, participants } = update;
  let global = getGlobal();
  const groupCalls = global.matrixGroupCalls || { byChatId: {} };
  global = {
    ...global,
    matrixGroupCalls: { ...groupCalls, byChatId: { ...groupCalls.byChatId, [chatId]: { callId, participants } } },
  };
  setGlobal(global);
  if (active?.chatId === chatId) reconcilePeers();
}

// Connects to participants who joined and drops those who left
function reconcilePeers() {
  if (!active) return;
  const current = active;
  const info = getGlobal().matrixGroupCalls?.byChatId[current.chatId];
  const others = (info?.callId === current.callId ? info.participants : [])
    .filter(({ userId, deviceId }) => keyOf(userId, deviceId) !== current.myKey);
  const otherKeys = new Set(others.map(({ userId, deviceId }) => keyOf(userId, deviceId)));

  current.peers.forEach((peer, key) => {
    if (otherKeys.has(key)) {
      peer.isListed = true;
    } else if (peer.isListed) {
      closePeer(key, false);
    }
  });
  others.forEach(({ userId, deviceId }) => {
    const key = keyOf(userId, deviceId);
    if (current.peers.has(key)) return;
    if (current.myKey < key) {
      void startPeer(userId, deviceId, true);
    } else if (!current.greetedKeys.has(key)) {
      // They make the offer; this tells them not to wait for this device's join to reach them
      current.greetedKeys.add(key);
      void callApi('sendMatrixGroupCallSignal', {
        userId, deviceId, content: { type: 'hello', call_id: current.callId },
      });
    }
  });
}

function sendSignal(peer: Peer, content: Record<string, unknown>) {
  if (!active) return Promise.resolve(false);
  return callApi('sendMatrixGroupCallSignal', {
    userId: peer.userId, deviceId: peer.deviceId, content: { ...content, call_id: active.callId },
  });
}

function createPeer(userId: string, deviceId: string, isInitiator: boolean) {
  const current = active!;
  const key = keyOf(userId, deviceId);
  const connection = new RTCPeerConnection({ iceServers: current.iceServers });
  const peer: Peer = {
    key, userId, deviceId, isInitiator, connection, pendingRemoteCandidates: [], outgoingCandidates: [],
  };
  current.peers.set(key, peer);

  connection.onicecandidate = ({ candidate }) => {
    if (!candidate || active !== current) return;
    peer.outgoingCandidates.push(candidate.toJSON());
    if (peer.candidatesTimeout) return;
    peer.candidatesTimeout = setTimeout(() => {
      peer.candidatesTimeout = undefined;
      const candidates = peer.outgoingCandidates;
      peer.outgoingCandidates = [];
      if (active === current && candidates.length) void sendSignal(peer, { type: 'candidates', candidates });
    }, CANDIDATES_BATCH_MS);
  };

  connection.ontrack = ({ track, streams: [stream] }) => {
    if (active !== current || track.kind !== 'audio') return;
    const remoteStream = stream || new MediaStream([track]);
    if (!peer.audio) {
      peer.audio = new Audio();
      peer.audio.autoplay = true;
    }
    peer.audio.srcObject = remoteStream;
    peer.audio.muted = current.isSoundOff;
    void peer.audio.play().catch(() => undefined);
    peer.analyser = createAnalyser(remoteStream);
  };

  connection.onconnectionstatechange = () => {
    if (active !== current) return;
    const { connectionState } = connection;
    const wasConnected = peer.isConnected;
    peer.isConnected = connectionState === 'connected';
    // The other side learns whether this device is muted
    if (peer.isConnected && !wasConnected) void sendSignal(peer, { type: 'state', muted: current.isMuted });
    setActiveState({});
    if (connectionState === 'failed' && peer.isInitiator) {
      // Try again with a fresh connection; the other side follows the new offer
      clearTimeout(peer.reconnectTimeout);
      peer.reconnectTimeout = setTimeout(() => {
        if (active !== current || current.peers.get(key) !== peer) return;
        closePeer(key, false);
        void startPeer(userId, deviceId, true);
      }, RECONNECT_DELAY_MS);
    }
  };

  current.localStream.getTracks().forEach((track) => connection.addTrack(track, current.localStream));
  return peer;
}

async function startPeer(userId: string, deviceId: string, isInitiator: boolean) {
  const current = active;
  if (!current) return;
  const peer = createPeer(userId, deviceId, isInitiator);
  if (!isInitiator) return;
  const offer = await peer.connection.createOffer();
  if (active !== current) return;
  await peer.connection.setLocalDescription(offer);
  void sendSignal(peer, { type: 'offer', sdp: offer.sdp });
}

function closePeer(key: string, shouldSendHangup: boolean) {
  const peer = active?.peers.get(key);
  if (!peer) return;
  if (shouldSendHangup) void sendSignal(peer, { type: 'hangup' });
  clearTimeout(peer.candidatesTimeout);
  clearTimeout(peer.reconnectTimeout);
  peer.connection.close();
  if (peer.audio) {
    peer.audio.pause();
    peer.audio.srcObject = null; // eslint-disable-line no-null/no-null
  }
  active!.peers.delete(key);
  setActiveState({});
}

async function addRemoteCandidates(peer: Peer, candidates: RTCIceCandidateInit[]) {
  if (!peer.connection.remoteDescription) {
    peer.pendingRemoteCandidates.push(...candidates);
    return;
  }
  for (const candidate of candidates) {
    if (!candidate.candidate) continue;
    await peer.connection.addIceCandidate(candidate).catch(() => undefined);
  }
}

function flushCandidates(peer: Peer) {
  const candidates = peer.pendingRemoteCandidates;
  peer.pendingRemoteCandidates = [];
  void addRemoteCandidates(peer, candidates);
}

export async function handleMatrixGroupCallSignal(update: ApiUpdateMatrixGroupCallSignal) {
  const { fromUserId, fromDeviceId, content } = update;
  const current = active;
  if (!current || content.call_id !== current.callId || !fromDeviceId) return;
  const key = keyOf(fromUserId, fromDeviceId);
  let peer = current.peers.get(key);

  switch (content.type) {
    case 'offer': {
      if (typeof content.sdp !== 'string') return;
      // A new offer from the same device replaces the old connection (it reconnected)
      if (peer) closePeer(key, false);
      peer = createPeer(fromUserId, fromDeviceId, false);
      await peer.connection.setRemoteDescription({ type: 'offer', sdp: content.sdp });
      const answer = await peer.connection.createAnswer();
      if (active !== current) return;
      await peer.connection.setLocalDescription(answer);
      flushCandidates(peer);
      void sendSignal(peer, { type: 'answer', sdp: answer.sdp });
      break;
    }
    case 'answer':
      if (!peer || typeof content.sdp !== 'string' || peer.connection.signalingState !== 'have-local-offer') return;
      await peer.connection.setRemoteDescription({ type: 'answer', sdp: content.sdp });
      flushCandidates(peer);
      break;
    case 'candidates':
      if (peer && Array.isArray(content.candidates)) await addRemoteCandidates(peer, content.candidates);
      break;
    case 'hangup':
      closePeer(key, false);
      break;
    case 'hello':
      if (!peer && current.myKey < key) void startPeer(fromUserId, fromDeviceId, true);
      break;
    case 'state':
      if (!peer) return;
      peer.isMuted = Boolean(content.muted);
      setActiveState({});
      break;
    default:
  }
}

function createAnalyser(stream: MediaStream) {
  if (!active) return undefined;
  try {
    active.audioContext ||= new AudioContext();
    const analyser = active.audioContext.createAnalyser();
    analyser.fftSize = 512;
    active.audioContext.createMediaStreamSource(stream).connect(analyser);
    return analyser;
  } catch {
    return undefined;
  }
}

function getLevel(analyser: AnalyserNode) {
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}

function checkSpeaking() {
  if (!active) return;
  const speaking: string[] = [];
  if (!active.isMuted && active.localAnalyser && getLevel(active.localAnalyser) > SPEAKING_LEVEL) {
    speaking.push(active.myKey);
  }
  active.peers.forEach((peer) => {
    if (peer.analyser && getLevel(peer.analyser) > SPEAKING_LEVEL) speaking.push(peer.key);
  });
  const previous = getGlobal().matrixGroupCalls?.active?.speakingKeys || [];
  if (previous.join() !== speaking.join()) setActiveState({ speakingKeys: speaking });
}

export async function joinMatrixGroupCall(chatId: string) {
  if (active?.chatId === chatId) return;
  if (active) leaveMatrixGroupCall();
  const { showNotification } = getActions();

  const state = await callApi('fetchMatrixGroupCall', { chatId });
  if (!state) return;
  if (state.participantsCount >= MAX_GROUP_CALL_PARTICIPANTS) {
    showNotification({ message: `This voice chat is full (${MAX_GROUP_CALL_PARTICIPANTS} people)` });
    return;
  }

  let localStream: MediaStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    showNotification({
      message: {
        key: 'CallMicrophoneAccessNeeded',
        options: { withNodes: true, withMarkdown: true, renderTextFilters: ['br', 'links'] },
      },
    });
    return;
  }

  const iceServers = await callApi('fetchMatrixCallIceServers') || [];
  const isStart = !state.callId;
  const callId = state.callId || generateId();
  active = {
    chatId,
    callId,
    myKey: keyOf(state.myUserId, state.myDeviceId),
    localStream,
    iceServers,
    peers: new Map(),
    greetedKeys: new Set(),
    isMuted: false,
    isSoundOff: false,
  };
  active.localAnalyser = createAnalyser(localStream);
  active.speakingInterval = setInterval(checkSpeaking, SPEAKING_CHECK_MS);
  setActiveState({ speakingKeys: [], isScreenOpen: true });

  const current = active;
  await callApi('sendMatrixGroupCallMember', {
    chatId, callId, action: 'join', isStart,
  });
  current.pingInterval = setInterval(() => {
    if (active === current) void callApi('sendMatrixGroupCallMember', { chatId, callId, action: 'ping' });
  }, PING_INTERVAL_MS);
  reconcilePeers();
}

export function leaveMatrixGroupCall() {
  const current = active;
  if (!current) return;
  void callApi('sendMatrixGroupCallMember', { chatId: current.chatId, callId: current.callId, action: 'leave' });
  [...current.peers.keys()].forEach((key) => closePeer(key, true));
  clearInterval(current.pingInterval);
  clearInterval(current.speakingInterval);
  current.localStream.getTracks().forEach((track) => track.stop());
  void current.audioContext?.close().catch(() => undefined);
  active = undefined;
  setActiveState(undefined);
}

export function toggleMatrixGroupCallMute() {
  if (!active) return;
  active.isMuted = !active.isMuted;
  active.localStream.getAudioTracks().forEach((track) => {
    track.enabled = !active!.isMuted;
  });
  active.peers.forEach((peer) => {
    if (peer.isConnected) void sendSignal(peer, { type: 'state', muted: active!.isMuted });
  });
  setActiveState({});
}

export function getMatrixGroupCallMyKey() {
  return active?.myKey;
}

export function toggleMatrixGroupCallSound() {
  if (!active) return;
  active.isSoundOff = !active.isSoundOff;
  active.peers.forEach((peer) => {
    if (peer.audio) peer.audio.muted = active!.isSoundOff;
  });
  setActiveState({});
}

export function setMatrixGroupCallScreenOpen(isScreenOpen: boolean) {
  if (active) setActiveState({ isScreenOpen });
}

// Voice levels right now (0 to about 0.3), read by the call screen on every frame; muted is silent
export function getMatrixGroupCallLevels() {
  const levels: Record<string, number> = {};
  if (!active) return levels;
  levels[active.myKey] = !active.isMuted && active.localAnalyser ? getLevel(active.localAnalyser) : 0;
  active.peers.forEach((peer) => {
    levels[peer.key] = peer.analyser ? getLevel(peer.analyser) : 0;
  });
  return levels;
}

// Leaving the page leaves the call, so others don't wait for this device to time out
window.addEventListener('pagehide', () => leaveMatrixGroupCall());
