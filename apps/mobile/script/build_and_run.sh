#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-start}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PICO_HERMES_NODE_BIN="$HOME/.hermes/node/bin"
PICO_ANDROID_SDK="$HOME/Library/Android/sdk"
PICO_JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
PICO_XCODE_DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"

if [[ -x "$PICO_HERMES_NODE_BIN/node" ]]; then
  export PATH="$PICO_HERMES_NODE_BIN:$PATH"
fi
if [[ -d "$PICO_ANDROID_SDK" ]]; then
  export ANDROID_HOME="$PICO_ANDROID_SDK"
  export ANDROID_SDK_ROOT="$PICO_ANDROID_SDK"
  export PATH="$PICO_ANDROID_SDK/platform-tools:$PICO_ANDROID_SDK/emulator:$PATH"
fi
if [[ -d "$PICO_JAVA_HOME" ]]; then
  export JAVA_HOME="$PICO_JAVA_HOME"
fi
if [[ -d "$PICO_XCODE_DEVELOPER_DIR" ]]; then
  export DEVELOPER_DIR="$PICO_XCODE_DEVELOPER_DIR"
fi

cd "$ROOT_DIR"

show_usage() {
  cat <<'USAGE'
usage: ./script/build_and_run.sh [mode]

Modes:
  start, run          Start the Expo dev server
  --ios, ios          Start Expo and open iOS
  --android, android  Start Expo and open Android
  --gateway, gateway  Start the loopback Mobile Gateway
  --web, web          Start Expo for web
  --doctor, doctor    Run Expo diagnostics
  --help, help        Show this help
USAGE
}

run_doctor() {
  npx expo-doctor
}

case "$MODE" in
  start|run)
    exec npx expo start
    ;;
  --ios|ios)
    exec npx expo start --ios
    ;;
  --android|android)
    exec npx expo start --android
    ;;
  --gateway|gateway)
    exec npm run mobile:gateway --prefix "$ROOT_DIR/../.."
    ;;
  --web|web)
    exec npx expo start --web
    ;;
  --doctor|doctor)
    run_doctor
    ;;
  --help|help)
    show_usage
    ;;
  *)
    show_usage >&2
    exit 2
    ;;
esac
