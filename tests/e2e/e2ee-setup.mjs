// Sets up cross-signing, secret storage and key backup for test account 1 (like Element does),
// then sends encrypted messages to test account 2 in a new encrypted room
import { readFileSync, writeFileSync } from 'fs';
import * as sdk from '/app/node_modules/matrix-js-sdk/lib/index.js';

const HS = process.env.MATRIX_URL || 'https://mtx.peyvand-yar.ir';
const [[user1, pass1], [user2]] = readFileSync('/test/creds.txt', 'utf8').trim().split('\n').map((l) => l.split(' '));
const domain = new URL(HS).host;

const tmp = sdk.createClient({ baseUrl: HS });
const login = await tmp.loginRequest({
  type: 'm.login.password', identifier: { type: 'm.id.user', user: user1 }, password: pass1,
  initial_device_display_name: 'e2ee-setup-script',
});

let secretStorageKey;
const client = sdk.createClient({
  baseUrl: HS,
  accessToken: login.access_token,
  userId: login.user_id,
  deviceId: login.device_id,
  cryptoCallbacks: {
    getSecretStorageKey: async ({ keys }) => {
      const keyId = Object.keys(keys)[0];
      return [keyId, secretStorageKey];
    },
    cacheSecretStorageKey: (keyId, keyInfo, key) => {
      secretStorageKey = key;
    },
  },
});
await client.initRustCrypto({ useIndexedDB: false });
const crypto = client.getCrypto();

await crypto.bootstrapCrossSigning({
  setupNewCrossSigning: true,
  authUploadDeviceSigningKeys: async (makeRequest) => {
    await makeRequest({
      type: 'm.login.password', identifier: { type: 'm.id.user', user: user1 }, password: pass1,
    });
  },
});

let recoveryKey;
await crypto.bootstrapSecretStorage({
  createSecretStorageKey: async () => {
    const key = await crypto.createRecoveryKeyFromPassphrase();
    recoveryKey = key.encodedPrivateKey;
    secretStorageKey = key.privateKey;
    return key;
  },
  setupNewSecretStorage: true,
  setupNewKeyBackup: true,
});
console.log('cross-signing ready', await crypto.isCrossSigningReady(), 'backup', await crypto.getActiveSessionBackupVersion());

await client.startClient({ initialSyncLimit: 1 });
await new Promise((resolve) => client.once(sdk.ClientEvent.Sync, resolve));

const { room_id: roomId } = await client.createRoom({
  name: 'Encrypted test',
  invite: [`@${user2}:${domain}`],
  preset: 'private_chat',
  initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
});
await new Promise((resolve) => setTimeout(resolve, 3000));
for (const text of ['Secret message one 🔐', 'Secret message two', 'پیام رمزنگاری‌شده سوم']) {
  await client.sendTextMessage(roomId, text);
}
// Give the backup loop time to upload the new room keys
await new Promise((resolve) => setTimeout(resolve, 8000));
const backupInfo = await crypto.getKeyBackupInfo();
console.log('backup version', backupInfo?.version, 'room', roomId);
writeFileSync('/test/recovery_key', recoveryKey);
writeFileSync('/test/enc_room', roomId);
client.stopClient();
process.exit(0);
