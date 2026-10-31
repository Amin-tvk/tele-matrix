# Calculator APK

An Android app that opens Tele inside itself and can disguise itself as a calculator.

- The launcher shows **Calculator**, with a calculator icon. The app ID, `com.pocketcalc.app`, is neutral on purpose.
- Until the user turns on the calculator lock, the app opens Tele directly.
- To turn it on, go to Tele › Settings › Privacy and Security › **Calculator lock**. This item only appears inside the app. Pick a calculation, for example `5×6`, and type it twice.
- After that, the app opens as a working calculator. Typing the calculation and pressing `=` shows Tele.
- Leaving the app puts Tele behind the calculator again. Recent apps don't show the chats.
- Only a salted SHA-256 of the calculation is stored.
- If the user forgets the calculation, clearing the app's data resets it, which signs them out of Tele on that phone.
- Tele keeps loading behind the calculator, so it appears at once.
- Tele's web build ships inside the APK and is served to the WebView from there. The app starts without the website; only the Matrix server is needed. The large emoji images still load from the website when needed.
- Notifications: a background service checks the account's notification list (`/notifications`) every minute and shows new messages, with the sender's name and the text (encrypted messages show "New message"). It doesn't use `/sync`, so it never takes the device's encryption key messages away from Tele. While the calculator lock is on, notifications only say "You have new notifications".
- Downloads from Tele are saved to the phone's Downloads folder.
- The app checks `android-version.txt` on the website twice a day and offers the new APK when there is one.

## Build

```sh
PROXY=127.0.0.1:10808 ./build-apk.sh   # PROXY only where Google's servers are blocked
```

The build runs in Docker. It needs:
- The Android SDK, with platform 35 and build-tools 35, in `/opt/android-sdk`.
- `gradle-8.7-bin.zip` next to the SDK.
- A signing key in `/root/.peyvand-android`: `release.jks` and `keystore.properties`.

Keep the signing key off GitHub. Every update has to be signed with the same key, or Android refuses to install it over the old app.

To publish an update on the live site, copy `calculator.apk` and `android-version.txt` to the client's `public/` folder (on the production server, `/opt/tele/src/public/`) and rebuild the client. It is served at `/calculator.apk`.

`PEYVAND_APP_URL` sets the Tele address the app loads. It defaults to `https://tele.peyvand-yar.ir/`.

## Limits

- Notifications can be up to a minute late. In deep sleep, Android may delay them further.
- The Tele inside the app only changes with a new APK. `build-apk.sh` takes the web build from `WEB_DIR` (default `/opt/tele/www`), so build the web client first.
