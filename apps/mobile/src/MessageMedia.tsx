import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  SafeAreaProvider,
  SafeAreaView,
  initialWindowMetrics,
} from "react-native-safe-area-context";
import { useVideoPlayer, VideoView } from "expo-video";
import * as Sharing from "expo-sharing";
import { File } from "expo-file-system";
import type { RuntimeMediaReference } from "@pico/protocol/mobile";
import { usePico } from "./store";
import { resolveMediaArtifact } from "./media";
import { downloadArtifact } from "./artifact-cache";
import { Button, color, Label, s } from "./ui";

const Context = createContext<
  | {
      key: string;
      active: boolean;
      load: (
        ref: RuntimeMediaReference,
        signal: AbortSignal,
        progress: (text: string) => void,
      ) => Promise<string>;
    }
  | undefined
>(undefined);

export function MessageMediaProvider({
  sessionId,
  active,
  children,
}: {
  sessionId: string;
  active: boolean;
  children: React.ReactNode;
}) {
  const pico = usePico();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => sub.remove();
  }, []);
  const key = `${pico.host?.id}/${pico.workspace?.id}/${sessionId}/${pico.generation}`;
  const current = useRef(key);
  current.current = key;
  const value = useMemo(() => {
    let reads = 0;
    const waiting: (() => void)[] = [];
    return {
      key,
      active: active && foreground && pico.connected,
      load: (
        reference: RuntimeMediaReference,
        signal: AbortSignal,
        progress: (text: string) => void,
      ) =>
        new Promise<string>((resolve, reject) => {
          const check = () => {
            if (current.current !== key || signal.aborted)
              throw new Error("连接或会话已切换，取消媒体读取");
          };
          const start = () => {
            signal.removeEventListener("abort", cancel);
            try {
              check();
            } catch (error) {
              reject(error);
              return;
            }
            reads++;
            void (async () => {
              const artifact = await resolveMediaArtifact(pico, sessionId, reference);
              check();
              if (!pico.client || !pico.workspace || !pico.host) throw new Error("尚未连接");
              const file = await downloadArtifact({
                client: pico.client,
                scopeId: pico.host.id,
                workspaceId: pico.workspace.id,
                sessionId,
                artifact,
                media: reference,
                signal,
                assertCurrent: check,
                onProgress: progress,
              });
              check();
              return file.uri;
            })()
              .then(resolve, reject)
              .finally(() => {
                reads--;
                waiting.shift()?.();
              });
          };
          const cancel = () => {
            const index = waiting.indexOf(start);
            if (index >= 0) waiting.splice(index, 1);
            reject(new Error("媒体读取已取消"));
          };
          if (reads < 2) start();
          else {
            waiting.push(start);
            signal.addEventListener("abort", cancel, { once: true });
          }
        }),
    };
  }, [key, active, foreground, pico.connected]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function MessageMedia({
  reference,
  visible = true,
}: {
  reference: RuntimeMediaReference;
  visible?: boolean;
}) {
  const context = useContext(Context);
  const pico = usePico();
  const [state, setState] = useState<{ key: string; uri?: string; error?: string }>();
  const [progress, setProgress] = useState("加载中…");
  const [expanded, setExpanded] = useState(false);
  const [requested, setRequested] = useState(false);
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([
    context?.key,
    reference.artifactId,
    reference.digest,
    reference.mimeType,
    reference.kind,
    reference.sizeBytes,
  ]);
  const ready = state?.key === key ? state : undefined;
  const active = !!context?.active && visible;
  const shareScope = useRef<{ key: string; active: boolean } | undefined>(undefined);
  shareScope.current = { key, active: !!context?.active };
  useEffect(
    () => () => {
      shareScope.current = undefined;
    },
    [],
  );
  useEffect(() => {
    setExpanded(false);
    setRequested(false);
  }, [key]);
  useEffect(() => {
    if (!context?.active) setExpanded(false);
  }, [context?.active]);
  useEffect(() => {
    if (active && ready?.uri && !new File(ready.uri).exists) setState(undefined);
  }, [active, ready?.uri]);
  useEffect(() => {
    if (
      !context ||
      !active ||
      (reference.kind === "video" && !requested) ||
      ready?.uri ||
      ready?.error
    )
      return;
    const controller = new AbortController();
    setProgress("加载中…");
    void context
      .load(reference, controller.signal, (text) => {
        if (!controller.signal.aborted) setProgress(text);
      })
      .then((uri) => {
        if (!controller.signal.aborted) setState({ key, uri });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({ key, error: error instanceof Error ? error.message : "媒体加载失败" });
      });
    return () => controller.abort();
  }, [context, key, active, requested, retry, ready?.uri, ready?.error]);
  const share = async () => {
    const assertShareCurrent = () => {
      if (shareScope.current?.key !== key || !shareScope.current.active)
        throw new Error("连接或会话已切换，取消旧媒体分享");
    };
    if (!ready?.uri) return;
    assertShareCurrent();
    if (!(await Sharing.isAvailableAsync())) throw new Error("系统分享不可用");
    assertShareCurrent();
    await Sharing.shareAsync(ready.uri, { mimeType: reference.mimeType });
  };
  return (
    <View style={styles.card}>
      {ready?.uri ? (
        reference.kind === "image" ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`查看大图：${reference.alt || "图片"}`}
            onPress={() => setExpanded(true)}
          >
            <Image
              source={{ uri: ready.uri }}
              accessibilityLabel={reference.alt || "生成的图片"}
              resizeMode="contain"
              style={styles.image}
              onError={() => setState({ key, error: "此设备无法显示该图片，可在文件页下载" })}
            />
          </Pressable>
        ) : (
          <InlineVideo
            uri={ready.uri}
            active={active}
            onError={(error) => setState({ key, error })}
          />
        )
      ) : ready?.error ? (
        <View style={{ gap: 8 }}>
          <Text style={s.muted}>{ready.error}</Text>
          <Button
            title="重新加载媒体"
            quiet
            onPress={() => {
              setState(undefined);
              setRequested(true);
              setRetry((x) => x + 1);
            }}
          />
        </View>
      ) : reference.kind === "video" && !requested ? (
        <View style={styles.videoPlaceholder}>
          <Text style={s.text}>{reference.alt || "生成的视频"}</Text>
          <Button
            title="播放视频"
            secondary
            reason={!context?.active ? "连接恢复后可播放" : undefined}
            onPress={() => setRequested(true)}
          />
        </View>
      ) : (
        <View style={styles.loading}>
          <ActivityIndicator color={color.accent} />
          <Label>{progress}</Label>
        </View>
      )}
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <Text numberOfLines={2} style={[s.muted, { flex: 1 }]}>
          {reference.alt || (reference.kind === "image" ? "图片" : "视频")}
        </Text>
        {ready?.uri && <Button title="分享" quiet onPress={() => void pico.perform(share)} />}
      </View>
      <Modal
        visible={expanded && !!ready?.uri && !!context?.active}
        animationType="fade"
        presentationStyle="fullScreen"
        onRequestClose={() => setExpanded(false)}
      >
        <SafeAreaProvider initialMetrics={initialWindowMetrics}>
          <SafeAreaView style={{ flex: 1, backgroundColor: color.bg }}>
            <View style={[s.row, { justifyContent: "space-between", paddingHorizontal: 12 }]}>
              <Button title="关闭大图" quiet onPress={() => setExpanded(false)} />
              <Button title="分享图片" quiet onPress={() => void pico.perform(share)} />
            </View>
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ flexGrow: 1 }}
              minimumZoomScale={1}
              maximumZoomScale={4}
              centerContent
            >
              <Image
                source={{ uri: ready?.uri }}
                resizeMode="contain"
                style={{ flex: 1, width: "100%", minHeight: 400 }}
                accessibilityLabel={reference.alt || "图片大图"}
              />
            </ScrollView>
            <Text style={[s.muted, { padding: 16 }]}>{reference.alt}</Text>
          </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
    </View>
  );
}

function InlineVideo({
  uri,
  active,
  onError,
}: {
  uri: string;
  active: boolean;
  onError: (text: string) => void;
}) {
  const pico = usePico();
  const video = useRef<VideoView>(null);
  const player = useVideoPlayer(uri, (instance) => {
    instance.play();
  });
  useEffect(() => {
    if (player.status === "error")
      onError("此设备不支持该视频编码，可在文件页下载并用系统播放器打开");
    if (!active) player.pause();
  }, [active, player]);
  useEffect(() => {
    const listener = player.addListener("statusChange", (event) => {
      if (event.status === "error")
        onError("此设备不支持该视频编码，可在文件页下载并用系统播放器打开");
    });
    return () => listener.remove();
  }, [player, onError]);
  return (
    <View style={{ gap: 4 }}>
      <VideoView
        ref={video}
        player={player}
        style={styles.video}
        nativeControls
        fullscreenOptions={{ enable: true }}
        allowsPictureInPicture={false}
      />
      <Button
        title="全屏播放"
        quiet
        reason={!active ? "返回此消息后可播放" : undefined}
        onPress={() =>
          void pico.perform(async () => {
            if (player.duration > 0 && player.currentTime >= player.duration)
              player.currentTime = 0;
            await video.current?.enterFullscreen();
            player.play();
          })
        }
      />
    </View>
  );
}
const styles = StyleSheet.create({
  card: {
    backgroundColor: color.panel,
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: 12,
    overflow: "hidden",
    padding: 10,
    gap: 4,
    width: "100%",
    marginVertical: 6,
  },
  image: { width: "100%", height: 230, borderRadius: 6 },
  video: { width: "100%", height: 220 },
  videoPlaceholder: { height: 150, alignItems: "center", justifyContent: "center", gap: 12 },
  loading: { minHeight: 150, alignItems: "center", justifyContent: "center", gap: 12 },
});
