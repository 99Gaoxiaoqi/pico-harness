import React, { useEffect, useRef, useState } from "react";
import { Image, Text, View } from "react-native";
import { File, Directory, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as Crypto from "expo-crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { WebView } from "react-native-webview";
import { VideoView, useVideoPlayer } from "expo-video";
import type { RuntimeSessionArtifact } from "@pico/protocol/mobile";
import { usePico } from "./store";
import { assertArtifactIntegrity } from "./core";
import { Button, Card, Detail, Label, s } from "./ui";
const cache = new Directory(Paths.cache, "pico-artifacts");

export function FilesPanel({ sessionId }: { sessionId: string }) {
  const pico = usePico();
  const [files, setFiles] = useState<RuntimeSessionArtifact[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [revision, setRevision] = useState<number>();
  const [preview, setPreview] = useState<{
    file: RuntimeSessionArtifact;
    uri: string;
    text?: string;
  }>();
  const lifecycle = useRef(0);
  const generation = useRef(pico.generation);
  generation.current = pico.generation;
  const [progress, setProgress] = useState<Record<string, string>>({});
  async function load(more = false) {
    const result = await pico.request("session.artifacts.query", {
      sessionId,
      action: "list",
      limit: 30,
      ...(more && cursor ? { cursor, revision } : {}),
    });
    setFiles((old) =>
      more
        ? [...old, ...(result.artifacts as RuntimeSessionArtifact[])]
        : (result.artifacts as RuntimeSessionArtifact[]),
    );
    setCursor(typeof result.nextCursor === "string" ? result.nextCursor : undefined);
    setRevision(Number(result.revision));
  }
  useEffect(() => {
    lifecycle.current++;
    setPreview(undefined);
    setFiles([]);
    setProgress({});
    setCursor(undefined);
    void pico.perform(() => load());
    return () => {
      lifecycle.current++;
    };
  }, [sessionId, pico.generation]);
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
    await cache.create({ idempotent: true, intermediates: true });
    const file = new File(cache, `${Crypto.randomUUID()}.partial`);
    const target = new File(
      cache,
      `${artifact.digest}-${artifact.title.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 100)}`,
    );
    try {
      setProgress((old) => ({ ...old, [artifact.artifactId]: "下载中…" }));
      await File.downloadFileAsync(
        client.artifactUrl(workspace.id, sessionId, artifact.artifactId),
        file,
        {
          headers: client.authorizationHeaders(),
          onProgress: ({ bytesWritten, totalBytes }) => {
            if (
              capturedGeneration !== generation.current ||
              capturedLifecycle !== lifecycle.current
            )
              return;
            setProgress((old) => ({
              ...old,
              [artifact.artifactId]: `${Math.round(bytesWritten / 1024)} KiB${totalBytes > 0 ? ` / ${Math.round(totalBytes / 1024)} KiB` : ""}`,
            }));
          },
        },
      );
      assertCurrent();
      setProgress((old) => ({ ...old, [artifact.artifactId]: "校验 SHA-256…" }));
      const hash = sha256.create();
      const handle = file.open();
      let size = 0;
      try {
        while (size < file.size) {
          const chunk = handle.readBytes(Math.min(64 * 1024, file.size - size));
          if (chunk.length === 0) throw new Error("文件读取提前结束");
          hash.update(chunk);
          size += chunk.length;
          if (size % (1024 * 1024) === 0) await Promise.resolve();
        }
      } finally {
        handle.close();
      }
      assertCurrent();
      assertArtifactIntegrity(artifact, size, bytesToHex(hash.digest()));
      if (target.exists) await target.delete();
      await file.move(target);
      setProgress((old) => ({ ...old, [artifact.artifactId]: "下载完成 · 校验通过" }));
      assertCurrent();
      if (share) {
        if (!(await Sharing.isAvailableAsync())) throw new Error("系统分享不可用");
        await Sharing.shareAsync(target.uri, { mimeType: artifact.mimeType });
      } else {
        const text =
          (artifact.mimeType.startsWith("text/") || artifact.mimeType.includes("json")) &&
          artifact.sizeBytes <= 1024 * 1024
            ? await target.text()
            : undefined;
        setPreview({ file: artifact, uri: target.uri, ...(text !== undefined ? { text } : {}) });
      }
    } catch (error) {
      if (file.exists) await file.delete();
      throw error;
    }
  }
  return (
    <View style={{ gap: 14 }}>
      <View style={s.row}>
        <Button title="刷新文件" secondary onPress={() => void pico.perform(() => load())} />
        <Button
          title="清空文件缓存"
          secondary
          onPress={() =>
            void pico.perform(async () => {
              setPreview(undefined);
              if (cache.exists) await cache.delete();
              setProgress({});
            })
          }
        />
      </View>
      {files.map((file) => (
        <Card key={file.artifactId}>
          <Text style={s.text}>{file.title}</Text>
          <Label>
            {file.mimeType} · {(file.sizeBytes / 1024).toFixed(1)} KiB
          </Label>
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
          <Detail value={file} />
        </Card>
      ))}
      {cursor && (
        <Button
          title="加载更多文件"
          secondary
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
