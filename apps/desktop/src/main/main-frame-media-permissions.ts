import type { WebContents } from "electron";

/** Passive media may enter fullscreen only in the trusted application main frame. */
export function installMainFrameMediaPermissions(contents: WebContents): void {
  const allowed = (
    requester: WebContents | null,
    permission: string,
    details: {
      isMainFrame: boolean;
      requestingUrl?: string;
    },
  ): boolean => {
    if (
      requester !== contents ||
      permission !== "fullscreen" ||
      !details.isMainFrame ||
      !details.requestingUrl ||
      contents.isDestroyed()
    )
      return false;
    try {
      const requested = new URL(details.requestingUrl);
      const current = new URL(contents.getURL());
      requested.hash = "";
      current.hash = "";
      return requested.href === current.href;
    } catch {
      return false;
    }
  };
  contents.session.setPermissionRequestHandler((requester, permission, callback, details) => {
    callback(allowed(requester, permission, details));
  });
  contents.session.setPermissionCheckHandler((requester, permission, _origin, details) =>
    allowed(requester, permission, details),
  );
}
