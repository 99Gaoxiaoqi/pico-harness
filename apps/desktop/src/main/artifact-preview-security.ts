import type { Session, WebContents } from "electron";

const guardedSessions = new WeakMap<Session, Set<number>>();

/** The shell has only local artifact subframes; browser tools own separate WebContents. */
export function installArtifactPreviewSecurity(contents: WebContents): void {
  const session = contents.session;
  let guarded = guardedSessions.get(session);
  if (!guarded) {
    guarded = new Set<number>();
    guardedSessions.set(session, guarded);
    const ids = guarded;
    session.webRequest.onBeforeRequest((details, callback) => {
      const shell = details.webContentsId !== undefined && ids.has(details.webContentsId);
      const child = details.resourceType === "subFrame" || Boolean(details.frame?.parent);
      // A destroyed/unknown frame must not get a less restrictive path.
      const unknownFrame = !details.frame && details.resourceType !== "mainFrame";
      callback({
        cancel: shell && (child || unknownFrame) && !isLocalArtifactResource(details.url),
      });
    });
  }
  guarded.add(contents.id);
  contents.once("destroyed", () => guarded?.delete(contents.id));
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame) event.preventDefault();
  });
}

export function isLocalArtifactResource(url: string): boolean {
  // Chromium's built-in PDF viewer uses its own extension origin. File, HTTP,
  // custom application protocols and external handlers must never be reachable.
  return (
    url.startsWith("blob:") ||
    url.startsWith("data:") ||
    url === "about:blank" ||
    url === "about:srcdoc" ||
    url.startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/")
  );
}
