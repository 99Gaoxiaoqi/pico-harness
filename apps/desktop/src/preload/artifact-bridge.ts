import type { IpcRenderer } from "electron";
import {
  DESKTOP_ARTIFACT_CHANNELS,
  isArtifactReference,
  type DesktopArtifactReference,
  type DesktopArtifactsApi,
} from "./artifact-contract.js";
import type { DesktopResult } from "./contract.js";

export function createArtifactBridge(
  ipcRenderer: Pick<IpcRenderer, "invoke">,
): DesktopArtifactsApi {
  const invoke = (
    channel: string,
    reference: DesktopArtifactReference,
  ): Promise<DesktopResult<void>> => {
    if (!isArtifactReference(reference))
      return Promise.resolve({
        ok: false,
        error: { code: "INVALID_ARGUMENT", message: "生成文件引用无效", retryable: false },
      });
    return ipcRenderer.invoke(channel, reference);
  };
  return Object.freeze({
    open: (reference: DesktopArtifactReference) =>
      invoke(DESKTOP_ARTIFACT_CHANNELS.open, reference),
    openInDefaultApp: (reference: DesktopArtifactReference) =>
      invoke(DESKTOP_ARTIFACT_CHANNELS.openInDefaultApp, reference),
    saveAs: (reference: DesktopArtifactReference) =>
      invoke(DESKTOP_ARTIFACT_CHANNELS.saveAs, reference),
  });
}
