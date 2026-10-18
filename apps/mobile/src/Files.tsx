import React, { useEffect, useRef, useState } from "react";
import { Image, Text, View } from "react-native";
import * as Sharing from "expo-sharing";
import { WebView } from "react-native-webview";
import { VideoView, useVideoPlayer } from "expo-video";
import type { RuntimeSessionArtifact } from "@pico/protocol/mobile";
import { usePico } from "./store";
import { clearArtifactCache, downloadArtifact } from "./artifact-cache";
import { Busy, Button, Card, Detail, Label, s } from "./ui";

export function FilesPanel({ sessionId }: { sessionId: string }) {
  const pico = usePico();
  const [files, setFiles] = useState<RuntimeSessionArtifact[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [revision, setRevision] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<{
    file: RuntimeSessionArtifact;
    uri: string;
    text?: string;
  }>();
  const lifecycle = useRef(0);
  const generation = useRef(pico.generation);
  generation.current = pico.generation;
  const readVersion = useRef(0);
  const readScope = `${pico.generation}:${pico.connected}:${pico.syncRevision}:${sessionId}`;
  const currentScope = useRef(readScope);
  currentScope.current = readScope;
  const [progress, setProgress] = useState<Record<string, string>>({});
  async function load(more = false) {
    if (pico.connected === false) return;
    const version = ++readVersion.current;
    const isCurrent = () => version === readVersion.current && readScope === currentScope.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await pico.request("session.artifacts.query", {
        sessionId,
        action: "list",
        limit: 30,
        ...(more && cursor ? { cursor, revision } : {}),
      });
      if (!isCurrent()) return;
      setFiles((old) =>
        more
          ? [...old, ...(result.artifacts as RuntimeSessionArtifact[])]
          : (result.artifacts as RuntimeSessionArtifact[]),
      );
      setCursor(typeof result.nextCursor === "string" ? result.nextCursor : undefined);
      setRevision(Number(result.revision));
      setLoaded(true);
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }
  useEffect(() => {
    lifecycle.current++;
    setPreview(undefined);
    setFiles([]);
    setProgress({});
    setCursor(undefined);
    setRevision(undefined);
    setLoaded(false);
    setLoading(false);
    setError(undefined);
    return () => {
      lifecycle.current++;
    };
  }, [sessionId, pico.generation]);
  useEffect(() => {
    if (pico.connected !== false) void pico.perform(() => load());
    else setLoading(false);
    return () => {
      ++readVersion.current;
    };
  }, [sessionId, pico.generation, pico.connected, pico.syncRevision]);
  async function download(artifact: RuntimeSessionArtifact, share = false) {
    const capturedGeneration = pico.generation;
    const capturedLifecycle = lifecycle.current;
    const assertCurrent = () => {
      if (capturedGeneration !== generation.current || capturedLifecycle !== lifecycle.current)
        throw new Error("连接或会话已切换，取消旧文件交付");
    };
    const client = pico.client;
    const workspace = pico.workspace;
    if (!client || !workspace) throw new Error("尚未连接");
    const target = await downloadArtifact({
      client,
      scopeId: pico.host!.id,
      workspaceId: workspace.id,
      sessionId,
      artifact,
      assertCurrent,
      onProgress: (text) => {
        if (capturedGeneration === generation.current && capturedLifecycle === lifecycle.current)
          setProgress((old) => ({ ...old, [artifact.artifactId]: text }));
      },
    });
    assertCurrent();
    if (share) {
      if (!(await Sharing.isAvailableAsync())) throw new Error("系统分享不可用");
      assertCurrent();
      await Sharing.shareAsync(target.uri, { mimeType: artifact.mimeType });
    } else {
      const text =
        (artifact.mimeType.startsWith("text/") || artifact.mimeType.includes("json")) &&
        artifact.sizeBytes <= 1024 * 1024
          ? await target.text()
          : undefined;
      assertCurrent();
      setPreview({ file: artifact, uri: target.uri, ...(text !== undefined ? { text } : {}) });
    }
  }
  return (
    <View style={{ gap: 14 }}>
      <View style={s.row}>
        <Button
          title="刷新文件"
          secondary
          reason={loading ? "正在读取文件" : pico.reason("session.artifacts.query")}
          onPress={() => void pico.perform(() => load())}
        />
        <Button
          title="清空文件缓存"
          secondary
          onPress={() =>
            void pico.perform(async () => {
              setPreview(undefined);
              clearArtifactCache();
              setProgress({});
            })
          }
        />
      </View>
      {pico.connected === false ? (
        <Card>
          <Text style={s.text}>连接已断开</Text>
          <Label>
            {loaded ? "仍显示上次的文件。" : "暂时无法读取文件。"}重新连接后会自动更新。
          </Label>
        </Card>
      ) : error ? (
        <Card>
          <Text style={s.text}>{loaded ? "更新失败，仍显示上次的文件" : "文件暂时无法加载"}</Text>
          <Label>{error}</Label>
          <Button title="重试加载" secondary onPress={() => void pico.perform(() => load())} />
        </Card>
      ) : loading ? (
        <Busy label={loaded ? "正在更新文件…" : "正在加载文件…"} />
      ) : loaded && files.length === 0 ? (
        <Card>
          <Text style={s.text}>还没有文件</Text>
          <Label>本次会话生成的图片、文档和其他成果会显示在这里。</Label>
        </Card>
      ) : null}
      {files.map((file) => (
        <Card key={file.artifactId}>
          <Text style={s.text}>{file.title.trim() || "未命名文件"}</Text>
          <Label>{fileDescription(file)}</Label>
          <View style={s.row}>
            <Button
              title="预览"
              reason={pico.reason("session.artifacts.query")}
              onPress={() => void pico.perform(() => download(file))}
            />
            <Button
              title="保存 / 分享"
              secondary
              reason={pico.reason("session.artifacts.query")}
              onPress={() => void pico.perform(() => download(file, true))}
            />
          </View>
          {progress[file.artifactId] && <Label>{progress[file.artifactId]}</Label>}
          <Detail title="文件信息" value={file} />
        </Card>
      ))}
      {cursor && (
        <Button
          title="加载更多文件"
          secondary
          reason={loading ? "正在读取文件" : pico.reason("session.artifacts.query")}
          onPress={() => void pico.perform(() => load(true))}
        />
      )}
      {preview && (
        <Card>
          <Text style={s.text}>{preview.file.title}</Text>
          {preview.file.mimeType.startsWith("image/") ? (
            <Image
              source={{ uri: preview.uri }}
              style={{ height: 300, width: "100%", resizeMode: "contain" }}
            />
          ) : preview.file.mimeType.startsWith("video/") ? (
            <VideoPreview uri={preview.uri} />
          ) : preview.file.mimeType === "text/html" && preview.text !== undefined ? (
            <WebView
              style={{ height: 400 }}
              source={{ html: safeStaticHtml(preview.text) }}
              javaScriptEnabled={false}
              originWhitelist={["about:blank"]}
              mixedContentMode="never"
              allowFileAccess={false}
              allowUniversalAccessFromFileURLs={false}
              allowFileAccessFromFileURLs={false}
              onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
            />
          ) : preview.text !== undefined ? (
            <Text selectable style={s.mono}>
              {preview.text}
            </Text>
          ) : (
            <Label>此格式请通过系统分享打开（PDF 使用系统预览）。</Label>
          )}
          <Button title="关闭预览" secondary onPress={() => setPreview(undefined)} />
        </Card>
      )}
    </View>
  );
}
function fileDescription(file: RuntimeSessionArtifact) {
  const formats: Record<string, string> = {
    "application/pdf": "PDF 文档",
    "application/json": "JSON 数据",
    "text/plain": "文本文件",
    "text/markdown": "Markdown 文档",
    "text/html": "网页",
    "text/csv": "CSV 表格",
    "application/zip": "ZIP 压缩包",
    "image/png": "PNG 图片",
    "image/jpeg": "JPEG 图片",
    "image/webp": "WebP 图片",
    "image/gif": "GIF 图片",
    "video/mp4": "MP4 视频",
    "audio/mpeg": "MP3 音频",
  };
  const format =
    formats[file.mimeType] ??
    (file.mimeType.startsWith("image/")
      ? "图片"
      : file.mimeType.startsWith("video/")
        ? "视频"
        : file.mimeType.startsWith("audio/")
          ? "音频"
          : file.mimeType.startsWith("text/")
            ? "文本文件"
            : "文件");
  const bytes = file.sizeBytes;
  const size =
    bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${format} · ${size}`;
}
function VideoPreview({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri);
  return (
    <VideoView
      player={player}
      style={{ height: 260, width: "100%" }}
      fullscreenOptions={{ enable: true }}
      nativeControls
    />
  );
}
export function safeStaticHtml(html: string) {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${html}</body></html>`;
}
