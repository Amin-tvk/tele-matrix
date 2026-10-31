#!/bin/sh
# Builds the signed calculator APK in Docker. Needs the Android SDK in $ANDROID_SDK (default /opt/android-sdk,
# with build-tools 35 and platform 35), Gradle 8.7's zip next to it, and the signing key in $KEYS_DIR
# (default /root/.peyvand-android: release.jks + keystore.properties with storeFile=/keys/release.jks).
# Set PROXY=host:port to fetch Gradle dependencies through a SOCKS proxy
set -e
cd "$(dirname "$0")"
SDK=${ANDROID_SDK:-/opt/android-sdk}
KEYS=${KEYS_DIR:-/root/.peyvand-android}
PROXY_OPTS=""
if [ -n "$PROXY" ]; then
  PROXY_OPTS="-DsocksProxyHost=${PROXY%:*} -DsocksProxyPort=${PROXY#*:}"
fi
docker run --rm --network host -v "$PWD":/app -v "$SDK":/sdk -v "$KEYS":/keys:ro -v peyvand-gradle-cache:/root/.gradle \
  -e ANDROID_HOME=/sdk -e PEYVAND_KEYSTORE_PROPERTIES=/keys/keystore.properties -e PEYVAND_APP_URL \
  -w /app eclipse-temurin:17-jdk sh -c "
    [ -x /root/.gradle/gradle-8.7/bin/gradle ] || (cd /root/.gradle && jar xf /sdk/gradle-8.7-bin.zip && chmod +x gradle-8.7/bin/gradle)
    /root/.gradle/gradle-8.7/bin/gradle --no-daemon -q $PROXY_OPTS assembleRelease"
cp app/build/outputs/apk/release/app-release.apk calculator.apk
echo "Built $(pwd)/calculator.apk"
