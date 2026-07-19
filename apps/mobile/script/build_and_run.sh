#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-start}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

show_usage() {
  cat <<'USAGE'
usage: ./script/build_and_run.sh [mode]

Modes:
  start, run          Start the Expo dev server
  --ios, ios          Start Expo and open iOS
  --android, android  Start Expo and open Android
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
