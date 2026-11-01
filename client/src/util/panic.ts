import { getActions } from '../global';

import { callApi } from '../api/gramjs';
import { getAndroidBridge } from './androidBridge';
import { pause } from './schedulers';

// The Android app's panic gesture (= three times on the calculator) calls this: the emergency contacts are
// told first, then the account signs out here and the app wipes everything Tele kept on the phone

const ALERT_TIMEOUT_MS = 15000;
const SIGN_OUT_TIMEOUT_MS = 10000;

let isRunning = false;

async function panic() {
  if (isRunning) return;
  isRunning = true;
  try {
    await Promise.race([callApi('sendEmergencyAlert', { isPanic: true }), pause(ALERT_TIMEOUT_MS)]);
  } catch {
    // Wiping matters more than the alert
  }
  try {
    getActions().signOut();
    await pause(SIGN_OUT_TIMEOUT_MS);
  } finally {
    getAndroidBridge()?.panicDone?.();
  }
}

if (getAndroidBridge()) {
  (window as Window & { peyvandPanic?: () => void }).peyvandPanic = () => {
    void panic();
  };
}
