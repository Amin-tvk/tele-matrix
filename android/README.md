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
- No notifications (removed in version 3 by request). The app keeps nothing of the login outside Tele itself.
- No service worker inside the app: the files are already on the phone, and the worker only added cache lookups and 3-second network races to every start.
- Downloads from Tele are saved to the phone's Downloads folder.
- The app checks `android-version.txt` on the website twice a day and offers the new APK when there is one.
- Download link to share: **https://tele.peyvand-yar.ir/download**. It always serves the latest build. ArvanCloud caches anything ending in `.apk` whatever the headers say, so the production nginx (`/etc/nginx/conf.d/tele.conf`) serves `/download` (no extension, so it isn't cached) from the site's `calculator.apk`, with the APK type and filename, and redirects `/calculator.apk` there.
- Turning the calculator lock on, or changing the calculation, always shows the warning first (forgetting it means clearing the app's data).

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

- The Tele inside the app only changes with a new APK. `build-apk.sh` takes the web build from `WEB_DIR` (default `/opt/tele/www`), so build the web client first.
