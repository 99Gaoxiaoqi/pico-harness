import React, { useEffect, useMemo, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ReviewRequestStorage } from "./review-request-storage";
import { isTerminalRunStatus, type RuntimeResult } from "@pico/protocol/mobile";
import { errorText } from "./core";
import { MobileReview } from "./review-controller";
import { usePico } from "./store";
import { Button, Card, Chips, Detail, Field, Label, color, s } from "./ui";

export function ReviewPanel({
  sessionId,
  onReturnToConversation,
  onSession,
}: {
  sessionId: string;
  onReturnToConversation?: () => void;
  onSession?: (sessionId: string) => void;
}) {
  const pico = usePico();
  const latest = useRef(pico);
  latest.current = pico;
  const returnToConversation = useRef(onReturnToConversation);
  returnToConversation.current = onReturnToConversation;
  const switchSession = useRef(onSession);
  switchSession.current = onSession;
  const [comment, setComment] = useState("");
  const controller = useMemo(
    () =>
      new MobileReview(
        {
          request: (method, params, workspaceId) =>
            latest.current.request(method, params, workspaceId),
        },
        pico.workspace?.id ?? "",
        sessionId,
        () => {
          setComment("");
          returnToConversation.current?.();
        },
        {
          recoveryStorage: new ReviewRequestStorage(
            AsyncStorage,
            JSON.stringify([pico.host?.id, pico.workspace?.id, sessionId]),
            () => Crypto.randomUUID(),
          ),
          canRetry: () => !!latest.current.capabilities?.features.reviewIdempotency?.available,
        },
      ),
    [pico.host?.id, pico.workspace?.id, sessionId],
  );
  const [projection, setProjection] = useState({ controller, state: controller.state });
  const view = projection.controller === controller ? projection.state : controller.state;
  const [runPicker, setRunPicker] = useState(false);
  const [filePicker, setFilePicker] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [checkpoints, setCheckpoints] = useState<RuntimeResult<"rewind.list">["checkpoints"]>([]);
  const [preview, setPreview] = useState<RuntimeResult<"rewind.preview">>();
  const [mode, setMode] = useState<"conversation" | "code" | "both">("both");
  const [rewindLoading, setRewindLoading] = useState(false);
  const [rewindBusy, setRewindBusy] = useState(false);
  const [rewindError, setRewindError] = useState<string>();
  const rewindVersion = useRef(0);
  const rewindMutation = useRef(false);
  const rewindMutationVersion = useRef(0);

  useEffect(
    () => controller.subscribe((state) => setProjection({ controller, state })),
    [controller],
  );
  useEffect(() => {
    controller.suspend();
    if (pico.connected) {
      controller.resume();
      void controller.refresh();
    }
    return () => controller.suspend();
  }, [controller, pico.generation, pico.connected]);
  useEffect(() => {
    setComment(view.recovery?.message ?? "");
    setRunPicker(false);
    setFilePicker(false);
  }, [controller, view.runId, view.recovery]);
  useEffect(() => {
    rewindVersion.current++;
    rewindMutation.current = false;
    rewindMutationVersion.current++;
    setPreview(undefined);
    setCheckpoints([]);
    setRewindError(undefined);
    setRewindLoading(false);
    setRewindBusy(false);
    return () => {
      rewindVersion.current++;
    };
  }, [controller, pico.generation, pico.connected]);
  useEffect(() => {
    if (advanced && pico.connected) void refreshRewind();
  }, [advanced, controller, pico.generation, pico.connected]);

  async function refreshRewind() {
    if (!controller.active) return;
    const version = ++rewindVersion.current;
    setRewindLoading(true);
    setPreview(undefined);
    setRewindError(undefined);
    try {
      const result = await latest.current.request(
        "rewind.list",
        { sessionId },
        controller.workspaceId,
      );
      if (version === rewindVersion.current && controller.active)
        setCheckpoints(result.checkpoints);
    } catch (error) {
      if (version === rewindVersion.current && controller.active) setRewindError(errorText(error));
    } finally {
      if (version === rewindVersion.current && controller.active) setRewindLoading(false);
    }
  }
  async function previewRewind(checkpointId: string) {
    if (!controller.active || rewindMutation.current || controller.state.pending) return;
    const version = ++rewindVersion.current;
    setPreview(undefined);
    setRewindLoading(true);
    setRewindError(undefined);
    try {
      const result = await latest.current.request(
        "rewind.preview",
        { sessionId, checkpointId },
        controller.workspaceId,
      );
      if (version === rewindVersion.current && controller.active) setPreview(result);
    } catch (error) {
      if (version === rewindVersion.current && controller.active) setRewindError(errorText(error));
    } finally {
      if (version === rewindVersion.current && controller.active) setRewindLoading(false);
    }
  }
  function confirmRewind() {
    if (!preview) return;
    const target = preview;
    const selectedMode = mode;
    const version = rewindVersion.current;
    Alert.alert("执行 Rewind？", `检查点 ${target.checkpointId}\n范围 ${selectedMode}`, [
      { text: "返回" },
      {
        text: "恢复",
        style: "destructive",
        onPress: () => void applyRewind(target, selectedMode, version),
      },
    ]);
  }
  async function applyRewind(
    target: RuntimeResult<"rewind.preview">,
    selectedMode: "conversation" | "code" | "both",
    previewVersion: number,
  ) {
    if (
      !controller.active ||
      previewVersion !== rewindVersion.current ||
      rewindMutation.current ||
      controller.state.pending
    )
      return;
    const version = ++rewindVersion.current;
    rewindMutation.current = true;
    const mutationVersion = ++rewindMutationVersion.current;
    setRewindBusy(true);
    setRewindError(undefined);
    try {
      const result = await latest.current.request(
        "rewind.apply",
        {
          sessionId,
          checkpointId: target.checkpointId,
          expectedFingerprint: target.fingerprint,
          mode: selectedMode,
          idempotencyKey: Crypto.randomUUID(),
        },
        controller.workspaceId,
      );
      if (version !== rewindVersion.current || !controller.active) return;
      setPreview(undefined);
      if (switchSession.current) switchSession.current(result.sessionId);
      else await Promise.all([controller.refresh(), refreshRewind()]);
    } catch (error) {
      if (version === rewindVersion.current && controller.active) {
        setPreview(undefined);
        setRewindError(errorText(error));
      }
    } finally {
      if (controller.active && mutationVersion === rewindMutationVersion.current) {
        rewindMutation.current = false;
        setRewindBusy(false);
      }
    }
  }
  function submit(decision: "approve" | "request_changes" | "apply") {
    if (!rewindMutation.current) void controller.submit(decision, comment);
  }

  const terminalRuns = view.runs
    .filter((run) => isTerminalRunStatus(run.status))
    .sort((a, b) => b.startedAt - a.startedAt);
  const selectedRun = terminalRuns.find((run) => run.runId === view.runId);
  const activeCount = view.runs.length - terminalRuns.length;
  const files =
    view.source === "run" ? (view.changes?.changes ?? []) : (view.snapshot?.files ?? []);
  const selectedFile = files.find((file) => file.path === view.path) ?? files[0];
  const actionReason =
    rewindBusy || view.pending
      ? "正在提交，请等待电脑确认"
      : view.unknown
        ? "原审阅结果未确认，请使用原操作重试"
        : view.loading || view.diffLoading
          ? "正在读取审阅内容"
          : view.stale || view.error
            ? "请刷新审阅后重试"
            : !view.changes || !view.runId
              ? "请选择可审阅的已结束运行"
              : undefined;
  const readReason = rewindBusy || view.pending ? "正在提交，请等待电脑确认" : undefined;

  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 7 }}>
        <Text style={s.title}>审阅改动</Text>
        <Label>文件已在电脑工作区。批准记录审阅结果，不会再次保存代码。</Label>
      </View>
      <Chips
        values={["运行变更", "工作区 Git"] as const}
        value={view.source === "run" ? "运行变更" : "工作区 Git"}
        onChange={(value) => {
          if (rewindMutation.current) return;
          setFilePicker(false);
          void controller.selectSource(value === "运行变更" ? "run" : "git");
        }}
      />
      <Button
        title={view.loading ? "正在读取审阅…" : "刷新审阅"}
        quiet
        reason={
          readReason ?? pico.reason(view.source === "run" ? "runs.list" : "git.review.snapshot")
        }
        onPress={() => {
          if (!rewindMutation.current) void controller.refresh(true);
        }}
      />
      {view.unknown && (
        <View style={{ gap: 8 }}>
          <Notice warning>原审阅结果未确认。刷新、重连或重开页面会保留原操作和评论。</Notice>
          {view.recovery && (
            <Button
              title="使用原操作重试确认"
              reason={
                readReason ??
                (!pico.capabilities?.features.reviewIdempotency?.available
                  ? "电脑未声明审阅幂等能力，请先升级电脑宿主并核对原对话"
                  : pico.reason("changes.review"))
              }
              onPress={() => {
                if (!rewindMutation.current) void controller.retryUnknown();
              }}
            />
          )}
        </View>
      )}
      {view.error && <Notice warning>{view.error}</Notice>}
      {view.notice && <Notice>{view.notice}</Notice>}
      {view.source === "run" ? (
        <View style={{ gap: 8 }}>
          <Button
            title={
              selectedRun
                ? `${runStatus(selectedRun.status)} · ${selectedRun.description.slice(0, 60)} ${runPicker ? "▴" : "▾"}`
                : "选择已结束运行 ▾"
            }
            secondary
            reason={readReason ?? pico.reason("runs.list")}
            onPress={() => setRunPicker(!runPicker)}
          />
          {selectedRun && (
            <Label>
              {new Date(selectedRun.startedAt).toLocaleString()} · {selectedRun.runId}
            </Label>
          )}
          {activeCount > 0 && <Label>{activeCount} 个运行尚未结束，暂不可审阅。</Label>}
          {!view.loading && terminalRuns.length === 0 && (
            <Label>当前会话没有已结束的运行。失败或取消的运行也可以审阅可验证的更改。</Label>
          )}
          {runPicker &&
            terminalRuns.map((run) => (
              <Button
                key={run.runId}
                title={`${runStatus(run.status)} · ${run.description.slice(0, 60)}`}
                secondary
                reason={readReason}
                onPress={() => {
                  setRunPicker(false);
                  setFilePicker(false);
                  void controller.selectRun(run.runId);
                }}
              />
            ))}
        </View>
      ) : (
        <View style={{ gap: 9 }}>
          <Chips
            values={["未暂存", "已暂存", "分支概览"] as const}
            value={
              view.gitSource === "unstaged"
                ? "未暂存"
                : view.gitSource === "staged"
                  ? "已暂存"
                  : "分支概览"
            }
            onChange={(value) => {
              if (!rewindMutation.current)
                void controller.selectGitSource(
                  value === "未暂存" ? "unstaged" : value === "已暂存" ? "staged" : "branch",
                );
            }}
          />
          <Label>当前分支 · {view.snapshot?.branch || "未命名"}</Label>
          {view.gitSource === "branch" && (
            <Label>概览包含已暂存和未暂存的文件。选择具体来源后查看差异。</Label>
          )}
          {view.snapshot?.truncated && <Label>文件列表已截断。</Label>}
        </View>
      )}
      {view.source === "git" && view.gitSource === "branch" ? (
        <Card>
          {files.map((file, index) => (
            <Text key={`${index}/${file.path}`} style={s.text}>
              {String(file.path)} · +{String(file.additions)} −{String(file.deletions)}
            </Text>
          ))}
          {!view.loading && files.length === 0 && <Label>当前没有 Git 变更。</Label>}
        </Card>
      ) : (
        <View style={{ gap: 10 }}>
          {selectedFile && (
            <>
              <Button
                title={`${String(selectedFile.path)} ${filePicker ? "▴" : "▾"}`}
                secondary
                reason={readReason}
                onPress={() => setFilePicker(!filePicker)}
              />
              <Label>
                {files.indexOf(selectedFile) + 1} / {files.length} 文件 · +
                {String(selectedFile.additions)} −{String(selectedFile.deletions)}
              </Label>
            </>
          )}
          {filePicker &&
            files.map((file) => (
              <Button
                key={String(file.path)}
                title={`${String(file.path)} · +${String(file.additions)} −${String(file.deletions)}`}
                secondary
                reason={
                  readReason ??
                  (view.stale
                    ? "请先刷新审阅"
                    : pico.reason(view.source === "run" ? "changes.diff" : "git.review.diff"))
                }
                onPress={() => {
                  setFilePicker(false);
                  void controller.readFile(String(file.path));
                }}
              />
            ))}
          {view.diffLoading && <Label>正在读取文件差异…</Label>}
          {view.diff && (
            <PatchView
              key={`${view.source}/${view.runId ?? view.gitSource}/${view.diff.path}`}
              patch={view.diff.patch}
              truncated={view.diff.truncated}
            />
          )}
          {!view.loading &&
            !view.error &&
            files.length === 0 &&
            (view.source === "git" || view.changes) && <Label>没有可审阅的文件变更。</Label>}
        </View>
      )}
      {view.source === "run" && (
        <View style={styles.composer}>
          <Field
            label="修改意见"
            value={comment}
            onChange={setComment}
            multiline
            placeholder="说明希望修改什么，例如：保留重试次数，只调整超时提示。"
          />
          <Label>提交成功后回到原对话，Pico 会继续修改。</Label>
          <Button
            title={view.pending === "request_changes" ? "正在提交意见…" : "请求修改"}
            reason={
              actionReason ?? (!comment.trim() ? "请填写修改意见" : pico.reason("changes.review"))
            }
            onPress={() => submit("request_changes")}
          />
          <Button
            title={view.pending === "approve" ? "正在批准…" : "批准审阅"}
            secondary
            reason={actionReason ?? pico.reason("changes.review")}
            onPress={() => submit("approve")}
          />
        </View>
      )}
      <Button
        title={advanced ? "收起高级操作 ▴" : "高级操作 · 核验与 Rewind ▾"}
        quiet
        reason={readReason}
        onPress={() => setAdvanced(!advanced)}
      />
      {advanced && (
        <View style={{ gap: 16 }}>
          {view.source === "run" && (
            <Card>
              <Text style={s.text}>核验当前更改</Text>
              <Label>核验已审阅内容是否仍为当前文件，并记录确认；不会再次写入或暂存代码。</Label>
              <Button
                title={view.pending === "apply" ? "正在核验…" : "核验并确认"}
                secondary
                reason={actionReason ?? pico.reason("changes.apply")}
                onPress={() => {
                  const target = controller.state;
                  Alert.alert(
                    "核验当前更改？",
                    "文件已经在电脑工作区。此操作不会再次保存或暂存代码。",
                    [
                      { text: "返回" },
                      {
                        text: "确认核验",
                        onPress: () => {
                          if (controller.state === target && controller.active) submit("apply");
                        },
                      },
                    ],
                  );
                }}
              />
              <Detail
                title="审阅目标与指纹"
                value={{ runId: view.runId, fingerprint: view.changes?.fingerprint }}
              />
            </Card>
          )}
          <Card>
            <Text style={s.text}>Rewind 检查点</Text>
            <Label>预览后选择恢复范围。代码恢复会真的改变电脑文件。</Label>
            <Button
              title="刷新检查点"
              secondary
              reason={readReason ?? (rewindBusy ? "正在恢复" : pico.reason("rewind.list"))}
              onPress={() => void refreshRewind()}
            />
            {rewindLoading && <Label>正在读取检查点…</Label>}
            {rewindError && <Notice warning>{rewindError}</Notice>}
            {checkpoints.map((checkpoint) => (
              <Button
                key={checkpoint.checkpointId}
                title={`${checkpoint.label} · ${checkpoint.changedFileCount} 文件${checkpoint.incomplete ? " · 不完整" : ""}`}
                secondary
                reason={readReason ?? (rewindBusy ? "正在恢复" : pico.reason("rewind.preview"))}
                onPress={() => void previewRewind(checkpoint.checkpointId)}
              />
            ))}
            {preview && (
              <>
                <Label>
                  检查点 {preview.checkpointId} · 将恢复 {preview.changes.length} 个文件
                </Label>
                {preview.changes.map((file) => (
                  <Text key={String(file.path)} style={s.text}>
                    {String(file.path)}
                  </Text>
                ))}
                <Chips
                  values={["conversation", "code", "both"] as const}
                  value={mode}
                  onChange={setMode}
                />
                <Label>conversation：对话；code：代码；both：两者</Label>
                <Button
                  title={rewindBusy ? "正在恢复…" : "确认 Rewind"}
                  reason={readReason ?? (rewindBusy ? "正在恢复" : pico.reason("rewind.apply"))}
                  onPress={confirmRewind}
                />
              </>
            )}
          </Card>
        </View>
      )}
    </View>
  );
}

function runStatus(status: string) {
  return status === "succeeded" ? "已完成" : status === "failed" ? "失败" : "已取消";
}
function Notice({ children, warning = false }: { children: React.ReactNode; warning?: boolean }) {
  return (
    <View
      style={[styles.notice, { backgroundColor: warning ? color.warningSoft : color.accentSoft }]}
    >
      <Text style={[s.text, { color: warning ? color.warning : color.accentStrong }]}>
        {children}
      </Text>
    </View>
  );
}
function PatchView({ patch, truncated }: { patch: string; truncated: boolean }) {
  const [limit, setLimit] = useState(160);
  const lines = patch.split("\n");
  return (
    <View style={{ gap: 8 }}>
      <ScrollView horizontal style={styles.patch} contentContainerStyle={{ minWidth: "100%" }}>
        <View style={{ flex: 1, paddingVertical: 10 }}>
          {lines.slice(0, limit).map((line, index) => {
            const added = line.startsWith("+") && !line.startsWith("+++");
            const removed = line.startsWith("-") && !line.startsWith("---");
            return (
              <Text
                key={index}
                selectable
                style={[
                  s.mono,
                  styles.patchLine,
                  {
                    backgroundColor: added
                      ? color.accentSoft
                      : removed
                        ? color.dangerSoft
                        : "transparent",
                    color: added ? color.accentStrong : removed ? color.danger : color.text,
                  },
                ]}
              >
                {line || " "}
              </Text>
            );
          })}
        </View>
      </ScrollView>
      {!patch && <Label>此文件没有可显示的文本差异。</Label>}
      {lines.length > limit && (
        <Button
          title={`继续显示差异（${limit} / ${lines.length} 行）`}
          quiet
          onPress={() => setLimit(limit + 160)}
        />
      )}
      {truncated && <Label>Host 返回的差异已截断，当前内容不是完整文件差异。</Label>}
    </View>
  );
}
const styles = StyleSheet.create({
  composer: { gap: 10, paddingTop: 16, borderTopWidth: 1, borderTopColor: color.line },
  notice: { padding: 12, borderRadius: 8 },
  patch: { borderWidth: 1, borderColor: color.line, borderRadius: 9, backgroundColor: color.panel },
  patchLine: { paddingHorizontal: 12, paddingVertical: 2, minHeight: 22 },
});
