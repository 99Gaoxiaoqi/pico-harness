/** Platform detection for user-facing labels and shortcut rendering. */

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.startsWith("Mac");
}

export function isWindowsPlatform(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.startsWith("Win");
}
