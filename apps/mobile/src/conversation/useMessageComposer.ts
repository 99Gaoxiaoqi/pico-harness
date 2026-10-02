import { useEffect, useRef, useState } from "react";
import * as ImagePicker from "expo-image-picker";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import * as Crypto from "expo-crypto";
import type { RuntimeInputAttachment } from "@pico/protocol/mobile";
import type { RemoteParams } from "@pico/protocol/remote";
import type { TranscriptReplicaView } from "@pico/transcript-replica";
import { validateAttachments } from "../core";
import { usePico } from "../store";

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
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const picking = useRef(false);
  const [pickingImage, setPickingImage] = useState(false);
  const [images, setImages] = useState<RuntimeInputAttachment[]>([]);
  const [mode, setMode] = useState<"auto" | "steer" | "queue" | "replace">("auto");
  const [key, setKey] = useState(() => Crypto.randomUUID());
  const [uncertain, setUncertain] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const pendingSend = useRef<RemoteParams<"session.send"> | undefined>(undefined);
  const selection = useRef("");
  selection.current = `${pico.host?.id}/${pico.workspace?.id}/${sessionId}`;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setText("");
    setImages([]);
    setUncertain(false);
    setFrozen(false);
    setKey(Crypto.randomUUID());
    setSending(false);
    pendingSend.current = undefined;
  }, [sessionId, pico.host?.id, pico.workspace?.id]);
  async function addImage(camera = false) {
    const selectedContext = selection.current;
    if (picking.current || sending || frozen) return;
    picking.current = true;
    setPickingImage(true);
    try {
      if (images.length >= 4) throw new Error("最多选择 4 张图片");
      if (camera) {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (!permission.granted) throw new Error("需要相机权限");
      }
      const selected = camera
        ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"] })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"] });
      if (selected.canceled || !mounted.current || selection.current !== selectedContext) return;
      let image: RuntimeInputAttachment | undefined;
      for (const width of [1024, 768, 512, 320, 192]) {
        const result = await manipulateAsync(selected.assets[0]!.uri, [{ resize: { width } }], {
          compress: 0.55,
          format: SaveFormat.JPEG,
          base64: true,
        });
        if (!result.base64) continue;
        const candidate: RuntimeInputAttachment = {
          type: "image_base64",
          mimeType: "image/jpeg",
          data: result.base64,
        };
        try {
          validateAttachments([...images, candidate]);
          image = candidate;
          break;
        } catch {
          /* shrink */
        }
      }
      if (!image) throw new Error("图片无法压缩至剩余附件预算");
      if (mounted.current && selection.current === selectedContext) setImages([...images, image]);
    } catch (error) {
      if (mounted.current && selection.current === selectedContext) pico.report(error);
    } finally {
      picking.current = false;
      if (mounted.current) setPickingImage(false);
    }
  }
  async function send() {
    if (sending || picking.current || !sessionReady || !pico.connected) return;
    const selectedContext = selection.current;
    const current = () => mounted.current && selection.current === selectedContext;
    setSending(true);
    try {
      if (!pendingSend.current) {
        validateAttachments(images);
        pendingSend.current = {
          sessionId,
          input: { kind: "text", text, ...(images.length ? { attachments: [...images] } : {}) },
          behavior: mode,
          idempotencyKey: key,
          ...(activeRun ? { expectedRunId: activeRun.runId } : {}),
        };
      }
      const result = await pico.request("session.send", pendingSend.current);
      if (!current()) return;
      pendingSend.current = undefined;
      setText("");
      setImages([]);
      setKey(Crypto.randomUUID());
      setUncertain(false);
      setFrozen(false);
      onSession(result.session.sessionId);
    } catch (error) {
      if (!current()) return;
      const notExecuted =
        error instanceof Error && "outcome" in error && error.outcome === "not_executed";
      if (notExecuted) {
        pendingSend.current = undefined;
        setUncertain(false);
        setFrozen(false);
        setKey(Crypto.randomUUID());
      } else {
        setUncertain(true);
        setFrozen(true);
      }
      pico.report(error);
      await refreshTranscript()?.catch(pico.report);
    } finally {
      if (current()) setSending(false);
    }
  }
  function captureSelection() {
    const selectedContext = selection.current;
    return () => mounted.current && selection.current === selectedContext;
  }
  function clearDraft() {
    pendingSend.current = undefined;
    setText("");
    setImages([]);
    setUncertain(false);
    setFrozen(false);
    setKey(Crypto.randomUUID());
  }
  function removeImage(index: number) {
    if (!frozen && !sending && !picking.current) setImages(images.filter((_, i) => index !== i));
  }

  return {
    text,
    setText,
    sending,
    pickingImage,
    images,
    mode,
    setMode,
    uncertain,
    frozen,
    addImage,
    send,
    clearDraft,
    removeImage,
    captureSelection,
  };
}
