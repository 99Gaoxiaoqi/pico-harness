import {
  ingestDesktopRuntimeNotification as ingestDesktopRuntimeNotificationFromHost,
  isDesktopRunBoundaryNotification,
  isDesktopTranscriptNotification,
} from "@pico/pico-host/desktop-transcript-persistence";
import type { RuntimeNotification } from "@pico/protocol";
import type { Session } from "../engine/session.js";
import { projectTranscriptEvents } from "../presentation/transcript-event-store.js";

export { isDesktopRunBoundaryNotification, isDesktopTranscriptNotification };

/** @deprecated Durable Desktop Transcript persistence now belongs to @pico/pico-host. */
export async function ingestDesktopRuntimeNotification(
  session: Session,
  notification: RuntimeNotification,
): Promise<boolean> {
  return ingestDesktopRuntimeNotificationFromHost(session, notification, projectTranscriptEvents);
}
