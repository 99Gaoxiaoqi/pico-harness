import type { ReactNode } from "react";

// Pico menu glyphs share a 24px grid and rounded 1.6px strokes.
const glyphs: Readonly<Record<string, ReactNode>> = {
  help: (
    <>
      <path d="M5 4h10a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3V5a1 1 0 0 1 1-1Zm-1 12h14M9 8h4M9 11h2" />
    </>
  ),
  goal: (
    <>
      <path d="M6 21V4m0 1c4-3 7 3 12 0v9c-5 3-8-3-12 0M3 21h6" />
    </>
  ),
  resume: (
    <>
      <path d="M7 3h10a3 3 0 0 1 3 3v11M4 7h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
      <path d="m8 11 5 3-5 3Z" />
    </>
  ),
  compact: (
    <>
      <path d="M6 10h12M6 14h12M12 2v5m-3-3 3 3 3-3M12 22v-5m-3 3 3-3 3 3" />
    </>
  ),
  rewind: (
    <>
      <path d="M8 5 3 10l5 5M3 10h12a5 5 0 0 1 0 10h-4M21 3v8" />
      <circle cx="21" cy="3" r="1" />
    </>
  ),
  changes: (
    <>
      <path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10l-7-7Zm0 0v7h7M8 14h3M9.5 12.5v3M14 18h3" />
    </>
  ),
  model: (
    <>
      <path d="m12 3 9 5v9l-9 5-9-5V8l9-5Zm0 10L3 8m9 5 9-5m-9 5v9M7.5 5.5l9 5V19" />
    </>
  ),
  thinking: (
    <>
      <path d="M8 16c0-3-3-3-3-7a7 7 0 0 1 14 0c0 4-3 4-3 7M8 17h8M9 20h6M10 23h4M9 10l3 2 3-2m-3 2v5" />
    </>
  ),
  plan: (
    <>
      <path d="M8 4h10a2 2 0 0 1 2 2v14H8M4 6l1 1 2-3M4 12l1 1 2-3M4 18l1 1 2-3M11 8h6M11 14h6" />
    </>
  ),
  swarm: (
    <>
      <circle cx="12" cy="5" r="3" />
      <circle cx="5" cy="18" r="3" />
      <circle cx="19" cy="18" r="3" />
      <path d="m10 8-3 7m7-7 3 7M8 18h8" />
    </>
  ),
  graph: (
    <>
      <rect x="2" y="9" width="6" height="6" rx="2" />
      <rect x="16" y="2" width="6" height="6" rx="2" />
      <rect x="16" y="16" width="6" height="6" rx="2" />
      <path d="M8 12h3c3 0 1-7 5-7m-5 7c3 0 1 7 5 7" />
    </>
  ),
  new: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <path d="M7 12h10m-5-5v10" />
    </>
  ),
  rename: (
    <>
      <path d="m5 15 11-11 4 4L9 19l-5 1 1-5Zm8-8 4 4M4 23h16" />
    </>
  ),
  fork: (
    <>
      <path d="M12 21v-8c0-4-7-3-7-9m7 9c0-4 7-3 7-9M2 7l3-3 3 3m8 0 3-3 3 3" />
    </>
  ),
  status: (
    <>
      <rect x="3" y="14" width="4" height="7" rx="1" />
      <rect x="10" y="9" width="4" height="12" rx="1" />
      <rect x="17" y="3" width="4" height="18" rx="1" />
    </>
  ),
  context: (
    <>
      <path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5" />
    </>
  ),
  steer: (
    <>
      <path d="M3 7h6m4 0h8M3 17h12m4 0h2" />
      <circle cx="11" cy="7" r="2" />
      <circle cx="17" cy="17" r="2" />
    </>
  ),
  queue: (
    <>
      <path d="M3 5h12M3 10h9M3 15h6M11 19h10m-4-4 4 4-4 4" />
    </>
  ),
  replace: (
    <>
      <path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" />
    </>
  ),
  operations: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" />
    </>
  ),
  hooks: (
    <>
      <path d="M7 3v5m10-5v5M5 8h14v3a7 7 0 0 1-14 0V8Zm7 10v4" />
    </>
  ),
  "add-dir": (
    <>
      <path d="M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7ZM8 14h8m-4-4v8" />
    </>
  ),
  skill: (
    <>
      <path d="m12 2 8 5v10l-8 5-8-5V7l8-5Zm0 0v7m8-2-8 2-8-2m8 2 4 3-4 3-4-3 4-3Zm0 6v7" />
    </>
  ),
  agent: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="5" />
      <path d="M8 9h1m6 0h1M8 15c2 2 6 2 8 0M12 2v2" />
    </>
  ),
  argument: (
    <>
      <path d="M5 4v9a4 4 0 0 0 4 4h11m-5-5 5 5-5 5" />
    </>
  ),
  command: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="4" />
      <path d="m6 9 3 3-3 3m7 0h5" />
    </>
  ),
};

export function CommandIcon({ name, className }: { name: string; className?: string }) {
  return (
    <svg
      className={className}
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {glyphs[name] ?? glyphs.command}
    </svg>
  );
}
