import React, { useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import type { RuntimeResult, RuntimeGitReviewSource } from "@pico/protocol/mobile";
import { usePico } from "./store";
import { Button, Card, Chips, Label, s } from "./ui";
export function ReviewPanel({ sessionId }: { sessionId: string }) {
  const pico = usePico();
  const [source, setSource] = useState<RuntimeGitReviewSource>("unstaged");
  const [snapshot, setSnapshot] = useState<RuntimeResult<"git.review.snapshot">>();
  const [patch, setPatch] = useState("");
  const [runs, setRuns] = useState<RuntimeResult<"runs.list">["runs"]>([]);
  const [changes, setChanges] = useState<RuntimeResult<"changes.list">>();
  const [runId, setRunId] = useState("");
  const [checkpoints, setCheckpoints] = useState<RuntimeResult<"rewind.list">["checkpoints"]>([]);
  const [preview, setPreview] = useState<RuntimeResult<"rewind.preview">>();
  const [mode, setMode] = useState<"conversation" | "code" | "both">("both");
  async function refresh() {
    const [git, list, rewind] = await Promise.all([
      pico.request("git.review.snapshot", { source }),
      pico.request("runs.list", { sessionId }),
      pico.request("rewind.list", { sessionId }),
    ]);
    setSnapshot(git);
    setRuns(list.runs);
    setCheckpoints(rewind.checkpoints);
    setPatch("");
    setPreview(undefined);
    setChanges(undefined);
  }
  useEffect(() => {
    void pico.perform(refresh);
  }, [sessionId, pico.generation, source]);
  return (
    <View style={{ gap: 14 }}>
      <Chips
        values={["unstaged", "staged", "branch"] as const}
        value={source}
        onChange={setSource}
      />
      <Button title="刷新审查" secondary onPress={() => void pico.perform(refresh)} />
      <Card>
        <Text style={s.text}>Git · {snapshot?.branch}</Text>
        {snapshot?.files.map((file) => (
          <View key={file.path}>
            <Button
              title={`${file.path}  +${file.additions} −${file.deletions}`}
              secondary
              onPress={() =>
                void pico.perform(async () => {
                  const diff = await pico.request("git.review.diff", {
                    path: file.path,
                    source,
                    expectedRevision: snapshot.revision,
                  });
                  setPatch(diff.patch + (diff.truncated ? "\n[差异截断]" : ""));
                })
              }
            />
          </View>
        ))}
        {snapshot?.truncated && <Label>文件列表截断</Label>}
        {!!patch && (
          <Text selectable style={s.mono}>
            {patch}
          </Text>
        )}
      </Card>
      <Card>
        <Text style={s.text}>任务变更</Text>
        {runs.map((run) => (
          <Button
            key={run.runId}
            title={`${run.description.slice(0, 50)} · ${run.status}`}
            secondary
            onPress={() =>
              void pico.perform(async () => {
                setRunId(run.runId);
                setChanges(await pico.request("changes.list", { runId: run.runId }));
              })
            }
          />
        ))}
        {changes && (
          <>
            {changes.changes.map((x) => (
              <View key={String(x.path)}>
                <Button
                  title={String(x.path)}
                  secondary
                  onPress={() =>
                    void pico.perform(async () => {
                      const diff = await pico.request("changes.diff", {
                        runId,
                        path: String(x.path),
                      });
                      setPatch(diff.patch);
                    })
                  }
                />
              </View>
            ))}
            <View style={s.row}>
              <Button
                title="批准审查"
                reason={pico.reason("changes.review")}
                onPress={() =>
                  void pico.perform(() =>
                    pico.request("changes.review", {
                      runId,
                      decision: "approve",
                      expectedFingerprint: changes.fingerprint,
                    }),
                  )
                }
              />
              <Button
                title="要求修改"
                secondary
                reason={pico.reason("changes.review")}
                onPress={() =>
                  void pico.perform(() =>
                    pico.request("changes.review", {
                      runId,
                      decision: "request_changes",
                      expectedFingerprint: changes.fingerprint,
                    }),
                  )
                }
              />
              <Button
                title="应用变更"
                reason={pico.reason("changes.apply")}
                onPress={() =>
                  Alert.alert(
                    "应用这些变更？",
                    changes.changes.map((x) => String(x.path)).join("\n"),
                    [
                      { text: "返回" },
                      {
                        text: "应用",
                        onPress: () =>
                          void pico.perform(async () => {
                            await pico.request("changes.apply", {
                              runId,
                              expectedFingerprint: changes.fingerprint,
                            });
                            await refresh();
                          }),
                      },
                    ],
                  )
                }
              />
            </View>
          </>
        )}
      </Card>
      <Card>
        <Text style={s.text}>Rewind 检查点</Text>
        {checkpoints.map((x) => (
          <Button
            key={x.checkpointId}
            title={`${x.label} · ${x.changedFileCount} 文件${x.incomplete ? " · 不完整" : ""}`}
            secondary
            onPress={() =>
              void pico.perform(async () => {
                setPreview(
                  await pico.request("rewind.preview", { sessionId, checkpointId: x.checkpointId }),
                );
              })
            }
          />
        ))}
        {preview && (
          <>
            <Label>将恢复 {preview.changes.length} 个文件</Label>
            {preview.changes.map((x) => (
              <Text key={String(x.path)} style={s.text}>
                {String(x.path)}
              </Text>
            ))}
            <Chips
              values={["conversation", "code", "both"] as const}
              value={mode}
              onChange={setMode}
            />
            <Label>conversation：对话；code：代码；both：两者</Label>
            <Button
              title="确认 Rewind"
              reason={pico.reason("rewind.apply")}
              onPress={() =>
                Alert.alert("执行 Rewind？", `检查点 ${preview.checkpointId}\n范围 ${mode}`, [
                  { text: "返回" },
                  {
                    text: "恢复",
                    style: "destructive",
                    onPress: () =>
                      void pico.perform(async () => {
                        await pico.request("rewind.apply", {
                          sessionId,
                          checkpointId: preview.checkpointId,
                          expectedFingerprint: preview.fingerprint,
                          mode,
                          idempotencyKey: Crypto.randomUUID(),
                        });
                        await refresh();
                      }),
                  },
                ])
              }
            />
          </>
        )}
      </Card>
    </View>
  );
}
