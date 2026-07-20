export const NODE_RUNTIME_SUPPORT_LABEL = "Node 22.13+、24.3+ 或 26.x";

const SUPPORTED_NODE_RELEASES = new Map([
  [22, 13],
  [24, 3],
  [26, 0],
]);

export function isSupportedNodeVersion(version: string): boolean {
  const normalized = version.startsWith("v") ? version.slice(1) : version;
  const [major = Number.NaN, minor = Number.NaN] = normalized
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  const minimumMinor = SUPPORTED_NODE_RELEASES.get(major);
  return minimumMinor !== undefined && minor >= minimumMinor;
}
