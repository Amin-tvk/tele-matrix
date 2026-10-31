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

## Build

```sh
PROXY=127.0.0.1:10808 ./build-apk.sh   # PROXY only where Google's servers are blocked
```

The build runs in Docker. It needs:
- The Android SDK, with platform 35 and build-tools 35, in `/opt/android-sdk`.
- `gradle-8.7-bin.zip` next to the SDK.
- A signing key in `/root/.peyvand-android`: `release.jks` and `keystore.properties`.

Keep the signing key off GitHub. Every update has to be signed with the same key, or Android refuses to install it over the old app.

To publish an update on the live site, copy `calculator.apk` to the client's `public/` folder (on the production server, `/opt/tele/src/public/`) and rebuild the client. It is served at `/calculator.apk`.

`PEYVAND_APP_URL` sets the Tele address the app loads. It defaults to `https://tele.peyvand-yar.ir/`.

## Limits

- No push notifications. Android's WebView has no web push.
- Files Tele saves through the browser (blob downloads) are not saved to the phone yet.
