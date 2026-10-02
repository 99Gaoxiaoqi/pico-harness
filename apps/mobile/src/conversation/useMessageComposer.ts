import { useEffect, useRef, useState, type SetStateAction } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import * as Crypto from "expo-crypto";
import type { RuntimeInputAttachment, RuntimeSkillReference } from "@pico/protocol/mobile";
import type { TranscriptReplicaView } from "@pico/transcript-replica";
import { validateAttachments } from "../core";
import { usePico } from "../store";
import {
  DraftRepository,
  draftKey,
  emptyDraft,
  draftInput,
  draftSendReason,
  submitDraft,
  type ComposerAgent,
  type ComposerDraft,
  type ComposerMode,
  type DraftScope,
} from "./draft";

const drafts = new DraftRepository(AsyncStorage);
const canonicalName = (name: string) => name.normalize("NFKC").toLowerCase();
type LoadedDraft = { scope: string; ready: boolean; value: ComposerDraft; error?: string };

export function useMessageComposer({
  sessionId,
  sessionReady,
  activeRun,
  refreshTranscript,
  onSession,
}: {
  sessionId: string;
  sessionReady: boolean;
  activeRun: TranscriptReplicaView["activeRun"];
  refreshTranscript: () => Promise<void> | undefined;
  onSession: (id: string) => void;
}) {
  const pico = usePico();
  const scope: DraftScope = {
    hostId: pico.host?.id ?? "",
    workspaceId: pico.workspace?.id ?? "",
    sessionId,
  };
  const selection = useRef("");
  const renderSelection = draftKey(scope);
  selection.current = renderSelection;
  const [loaded, setLoaded] = useState<LoadedDraft>(() => ({
    scope: "",
    ready: false,
    value: emptyDraft(""),
  }));
  const currentDraft = useRef(loaded);
  currentDraft.current = loaded;
  const [sending, setSending] = useState(false);
  const [pickingImage, setPickingImage] = useState(false);
  const sendLock = useRef<string | undefined>(undefined);
  const picking = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const selected = draftKey(scope);
    let live = true;
    const initial: LoadedDraft = { scope: selected, ready: false, value: emptyDraft("") };
    currentDraft.current = initial;
    setLoaded(initial);
    setSending(false);
    setPickingImage(false);
    if (scope.hostId && scope.workspaceId) {
      void drafts.load(scope).then(
        (saved) => {
          if (!live || selection.current !== selected) return;
          const restored = {
            scope: selected,
            ready: true,
            value: saved ?? emptyDraft(Crypto.randomUUID()),
          };
          currentDraft.current = restored;
          setLoaded(restored);
        },
        (error: unknown) => {
          if (!live || selection.current !== selected) return;
          const failed = { ...initial, error: "草稿恢复失败，请重试或明确清除本地草稿" };
          currentDraft.current = failed;
          setLoaded(failed);
          pico.report(error);
        },
      );
    }
    return () => {
      live = false;
    };
  }, [pico.host?.id, pico.workspace?.id, sessionId]);
  const draftReady = loaded.scope === selection.current && loaded.ready;
  const value = loaded.scope === selection.current ? loaded.value : emptyDraft("");
  const frozen = !!value.pending;
  const uncertain = frozen && !sending;
  const draftError = loaded.scope === renderSelection ? loaded.error : undefined;
  const current = (selected: string) => mounted.current && selection.current === selected;
  const busy = () =>
    sendLock.current === selection.current || picking.current === selection.current;
  function apply(value: ComposerDraft) {
    const next = { scope: renderSelection, ready: true, value };
    currentDraft.current = next;
    setLoaded(next);
  }
  function change(patch: Partial<ComposerDraft>) {
    const previous = currentDraft.current;
    if (
      !current(renderSelection) ||
      previous.scope !== renderSelection ||
      !previous.ready ||
      previous.value.pending ||
      busy()
    )
      return;
    const updated = { ...previous.value, ...patch };
    try {
      draftInput(updated);
      // Enqueue immediately; navigation/unmount never cancels the last keystroke.
      const operation = drafts.save(scope, updated);
      apply(updated);
      const selected = renderSelection;
      void operation.catch((error) => {
        if (current(selected)) pico.report(error);
      });
    } catch (error) {
      pico.report(error);
    }
  }
  function setText(update: SetStateAction<string>) {
    change({
      text: typeof update === "function" ? update(currentDraft.current.value.text) : update,
    });
  }
  function setMode(update: SetStateAction<ComposerMode>) {
    change({
      mode: typeof update === "function" ? update(currentDraft.current.value.mode) : update,
    });
  }
  function setSelectedSkills(
    update:
      | readonly RuntimeSkillReference[]
      | ((previous: readonly RuntimeSkillReference[]) => readonly RuntimeSkillReference[]),
  ) {
    const skills =
      typeof update === "function" ? update(currentDraft.current.value.skills) : update;
    change({
      skills: [...skills],
      ...(activeRun && skills.length && ["auto", "steer"].includes(currentDraft.current.value.mode)
        ? { mode: "queue" as const }
        : {}),
    });
  }
  function setSelectedAgent(agent: ComposerAgent | undefined) {
    change({
      agent,
      ...(activeRun && agent && ["auto", "steer"].includes(currentDraft.current.value.mode)
        ? { mode: "queue" as const }
        : {}),
    });
  }
  async function addImage(camera = false) {
    const selected = renderSelection;
    if (!current(selected) || !draftReady || busy() || frozen) return;
    if (value.agent) return pico.report(new Error("Agent 输入不支持图片，请先移除 Agent"));
    picking.current = selected;
    setPickingImage(true);
    try {
      const before = currentDraft.current.value;
      if (before.images.length >= 4) throw new Error("最多选择 4 张图片");
      if (camera) {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) throw new Error("需要相机权限");
        if (!current(selected)) return;
      }
      const selectedImage = camera
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"] })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"] });
      if (selectedImage.canceled || !current(selected)) return;
      let image: RuntimeInputAttachment | undefined;
      for (const width of [1024, 768, 512, 320, 192]) {
        const result = await manipulateAsync(
          selectedImage.assets[0]!.uri,
          [{ resize: { width } }],
          {
            compress: 0.55,
            format: SaveFormat.JPEG,
            base64: true,
          },
        );
        if (!result.base64) continue;
        const candidate: RuntimeInputAttachment = {
          type: "image_base64",
          mimeType: "image/jpeg",
          data: result.base64,
        };
        try {
          validateAttachments([...before.images, candidate]);
          image = candidate;
          break;
        } catch {
          /* shrink */
        }
      }
      if (!image) throw new Error("图片无法压缩至剩余附件预算");
      if (current(selected)) {
        const updated = { ...currentDraft.current.value, images: [...before.images, image] };
        await drafts.save(scope, updated);
        if (current(selected)) apply(updated);
      }
    } catch (error) {
      if (current(selected)) pico.report(error);
    } finally {
      if (picking.current === selected) picking.current = undefined;
      if (current(selected)) setPickingImage(false);
    }
  }
  async function validateReferences(draft: ComposerDraft) {
    if (draft.skills.length) {
      const effective = await pico.request("skills.effective.list", {}, scope.workspaceId);
      const paths = draft.skills.some((skill) => skill.sourcePath)
        ? (await pico.request("catalog.skills", {}, scope.workspaceId)).skills
        : [];
      for (const reference of draft.skills) {
        const skill = effective.skills.find(
          (x) => x.source.effective && canonicalName(x.name) === canonicalName(reference.name),
        );
        const path = paths.find((x) => canonicalName(x.name) === canonicalName(reference.name));
        if (
          !skill ||
          (reference.sourceId !== undefined && reference.sourceId !== skill.source.sourceId) ||
          (reference.sourcePath !== undefined && reference.sourcePath !== path?.sourcePath)
        )
          throw new Error(`Skill ${reference.name} 已移除或来源已变化，请重新选择`);
      }
    }
    if (draft.agent) {
      const { agents } = await pico.request("catalog.agents", {}, scope.workspaceId);
      if (
        !agents.some(
          (x) => x.name === draft.agent!.name && x.subagentId === draft.agent!.subagentId,
        )
      )
        throw new Error(`Agent ${draft.agent.name} 已不可用，请重新选择`);
    }
  }
  const optionsReason = !draftReady
    ? (draftError ?? "正在恢复草稿")
    : sending
      ? "正在发送"
      : frozen
        ? "先确认待处理请求"
        : pickingImage
          ? "正在处理图片"
          : undefined;
  const sendReason = !draftReady
    ? (draftError ?? "正在恢复草稿")
    : sending || pickingImage
      ? "正在处理输入"
      : !sessionReady
        ? "正在补齐会话"
        : (pico.reason("session.send") ?? draftSendReason(value, !!activeRun));
  async function send() {
    if (!current(renderSelection) || sendReason || busy()) return;
    const selected = renderSelection;
    const before = currentDraft.current.value;
    const reason = draftSendReason(before, !!activeRun);
    if (reason) return pico.report(new Error(reason));
    sendLock.current = selected;
    setSending(true);
    let attempted = false;
    let request = before.pending;
    try {
      if (!request) {
        await validateReferences(before);
        if (!current(selected)) return;
        request = {
          sessionId,
          input: draftInput(before),
          behavior: before.mode,
          idempotencyKey: before.idempotencyKey,
          ...(activeRun ? { expectedRunId: activeRun.runId } : {}),
        };
      }
      const admitted = { ...before, pending: request };
      const result = await submitDraft(drafts, scope, before, request, async (original) => {
        if (!current(selected)) {
          const error = new Error("会话已切换，消息尚未发送") as Error & { outcome: string };
          error.outcome = "not_executed";
          throw error;
        }
        attempted = true;
        apply(admitted);
        return pico.request("session.send", original, scope.workspaceId);
      });
      if (current(selected)) {
        apply(emptyDraft(Crypto.randomUUID()));
        onSession(result.session.sessionId);
      }
    } catch (error) {
      if (current(selected)) {
        const notExecuted =
          !attempted ||
          (error instanceof Error && "outcome" in error && error.outcome === "not_executed");
        if (notExecuted && (!before.pending || attempted)) {
          const editable = { ...before, pending: undefined, idempotencyKey: Crypto.randomUUID() };
          apply(editable);
          void drafts.save(scope, editable).catch(pico.report);
        } else if (!attempted && before.pending) apply(before);
        else if (request) apply({ ...before, pending: request });
        pico.report(error);
        if (attempted) await refreshTranscript()?.catch(pico.report);
      }
    } finally {
      if (sendLock.current === selected) sendLock.current = undefined;
      if (current(selected)) setSending(false);
    }
  }
  function captureSelection() {
    const selected = renderSelection;
    return () => current(selected);
  }
  async function clearDraft() {
    if (!current(renderSelection) || busy()) return;
    const selected = renderSelection;
    sendLock.current = selected;
    setSending(true);
    try {
      await drafts.clear(scope);
      if (current(selected)) apply(emptyDraft(Crypto.randomUUID()));
    } catch (error) {
      if (current(selected)) pico.report(error);
    } finally {
      if (sendLock.current === selected) sendLock.current = undefined;
      if (current(selected)) setSending(false);
    }
  }
  function removeImage(index: number) {
    change({ images: value.images.filter((_, i) => index !== i) });
  }
  return {
    text: value.text,
    setText,
    sending,
    pickingImage,
    images: value.images,
    mode: value.mode,
    setMode,
    uncertain,
    frozen,
    addImage,
    send,
    clearDraft,
    removeImage,
    captureSelection,
    draftReady,
    draftError,
    selectedSkills: value.skills,
    selectedAgent: value.agent,
    setSelectedSkills,
    setSelectedAgent,
    optionsReason,
    sendReason,
  };
}
