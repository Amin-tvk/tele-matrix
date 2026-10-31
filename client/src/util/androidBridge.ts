// Calls into the Android app (the calculator APK), which runs Tele inside itself. Elsewhere this is a no-op

export type AndroidBridge = {
  isCalculatorLockOn: () => boolean;
  openCalculatorLock: () => void;
  setMatrixSession?: (sessionJson: string) => void;
  clearMatrixSession?: () => void;
  setDarkTheme?: (isDark: boolean) => void;
  startFile?: (filename: string, mimeType: string) => string;
  appendFile?: (id: string, base64: string) => boolean;
  finishFile?: (id: string) => void;
};

// Base64 grows data by a third; 768 KB chunks keep each call under 1 MB
const FILE_CHUNK_SIZE = 768 * 1024;

export function getAndroidBridge() {
  return (window as Window & { PeyvandAndroid?: AndroidBridge }).PeyvandAndroid;
}

// The app checks for new messages itself while Tele is closed, using the same login
export function shareSessionWithAndroid(sessionKey?: string) {
  const bridge = getAndroidBridge();
  if (!bridge?.setMatrixSession) return;
  if (sessionKey) bridge.setMatrixSession(sessionKey);
  else bridge.clearMatrixSession?.();
}

export function setAndroidDarkTheme(isDark: boolean) {
  getAndroidBridge()?.setDarkTheme?.(isDark);
}

export function canSaveFilesOnAndroid() {
  return Boolean(getAndroidBridge()?.startFile);
}

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// The WebView can't save a download by itself, so the file goes to the app in pieces and lands in Downloads
export async function saveFileOnAndroid(url: string, filename: string) {
  const bridge = getAndroidBridge();
  if (!bridge?.startFile || !bridge.appendFile || !bridge.finishFile) return;
  const blob = await (await fetch(url)).blob();
  const id = bridge.startFile(filename, blob.type || 'application/octet-stream');
  if (!id) return;
  for (let offset = 0; offset < blob.size; offset += FILE_CHUNK_SIZE) {
    const chunk = await blob.slice(offset, offset + FILE_CHUNK_SIZE).arrayBuffer();
    if (!bridge.appendFile(id, toBase64(chunk))) return;
  }
  bridge.finishFile(id);
}
