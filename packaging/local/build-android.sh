#!/usr/bin/env bash
# Builds the Android APK on this PC (Git Bash) and uploads it to the release of the tag. Signed with the release keystore
# when OMNICHAT_KEYSTORE_FILE / _PASSWORD / OMNICHAT_KEY_ALIAS / OMNICHAT_KEY_PASSWORD are set (see docs/CLIENTS.md),
# otherwise with the debug key (installs for testing, cannot be updated in place by a differently signed APK).
#   packaging/local/build-android.sh v0.2.0 [--no-upload]
# Needs Android Studio (its bundled JDK) and the Android SDK; the first run downloads the NDK and CMake (a few GB).
set -euo pipefail
TAG="${1:?usage: build-android.sh <tag> [--no-upload]}"
VER="${TAG#v}"
cd "$(dirname "$0")/../.."
export JAVA_HOME="${JAVA_HOME:-C:/Program Files/Android/Android Studio/jbr}"
export ANDROID_HOME="${ANDROID_HOME:-$LOCALAPPDATA/Android/Sdk}"; export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$PATH"
export JAVA_TOOL_OPTIONS="--enable-native-access=ALL-UNNAMED"   # JDK 24+ otherwise fails the CMake step
ROOT="$(pwd)"
# A neutral Gradle home keeps this PC's account name out of the native libraries (it ends up in their build paths).
export GRADLE_USER_HOME="${OMNICHAT_GRADLE_HOME:-C:/omnichat-build/gradle}"
cd app
cp app.json /tmp/omnichat-app.json.bak
# absolute paths: the script changes directory before it exits. Commit your own edits to app.json / package.json first.
trap 'cp /tmp/omnichat-app.json.bak "$ROOT/app/app.json"; git -C "$ROOT" checkout -- app/package.json 2>/dev/null || true' EXIT
node -e '
const fs = require("fs");
const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-.*?(\d+))?$/.exec(process.argv[1]);
const j = JSON.parse(fs.readFileSync("app.json", "utf8"));
j.expo.version = m[1] + "." + m[2] + "." + m[3];
// base*100 + pre-release number (beta.4 -> 4) or 99 for a formal release: betas of one version upgrade each other in place and the final release is above all of them
j.expo.android.versionCode = Math.max(1, ((+m[1]) * 10000 + (+m[2]) * 100 + (+m[3])) * 100 + (m[4] !== undefined ? Math.min(98, +m[4]) : 99));
fs.writeFileSync("app.json", JSON.stringify(j, null, 2));' "$TAG"
npm ci --no-audit --no-fund > /dev/null
npx expo prebuild --platform android --no-install --clean
cd android
printf '\n%s\n' "org.gradle.jvmargs=-Xmx4g -XX:MaxMetaspaceSize=1g --enable-native-access=ALL-UNNAMED" >> gradle.properties
./gradlew assembleRelease --no-daemon --init-script ../android-signing.init.gradle -PreactNativeArchitectures=arm64-v8a,armeabi-v7a -PreactNativeDevServerIp=localhost
cd ../..
OUT="out-android"; rm -rf "$OUT"; mkdir -p "$OUT"
node packaging/local/scan-leaks.mjs app/android/app/build/outputs/apk/release/app-release.apk
cp app/android/app/build/outputs/apk/release/app-release.apk "$OUT/OmniChat-$VER.apk"
cp "$OUT/OmniChat-$VER.apk" "$OUT/OmniChat.apk"
(cd "$OUT" && sha256sum OmniChat-*.apk OmniChat.apk > SHA256SUMS-android.txt)
ls -l "$OUT"
[ "${2:-}" = "--no-upload" ] || node packaging/local/upload.mjs "$TAG" "$OUT"/*
