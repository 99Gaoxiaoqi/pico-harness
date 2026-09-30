import { Dialog } from "@astryxdesign/core/Dialog";
import { Button } from "@astryxdesign/core/Button";
import { useEffect, useRef, useState } from "react";
import type { LocalCommandResult } from "@pico/cli/command-contracts";
import type { DesktopCommandSuggestion } from "../../shared/command-policy.js";
import type { RuntimeResult, RuntimeRewindMode } from "@pico/protocol";
import type { DesktopCommandContext } from "../../preload/command-contract.js";
import { SelectField, TextField } from "../ui-controls.js";
import { isRecord } from "../runtime-projections/values.js";

export function CommandDialog({
  result,
  context,
  catalog,
  onClose,
  onCommand,
  onRewind,
}: {
  result: LocalCommandResult;
  context: DesktopCommandContext;
  catalog: readonly DesktopCommandSuggestion[];
  onClose: () => void;
  onCommand: (text: string) => void;
  onRewind: (sessionId: string, prompt?: string) => void;
}) {
  const kind = result.ui?.kind === "open-selector" ? result.ui.selector : "help";
  const readOnly = Boolean(context.running);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const data = isRecord(result.data) ? result.data : {};
  const snapshots = Array.isArray(data.snapshots) ? data.snapshots.filter(isRecord) : [];
  const [checkpointId, setCheckpointId] = useState(
    String(data.checkpointId ?? data.selectedMessageId ?? ""),
  );
  const [mode, setMode] = useState<RuntimeRewindMode>("both");
  const [preview, setPreview] = useState<RuntimeResult<"rewind.preview">>();
  const [changes, setChanges] = useState<RuntimeResult<"rewind.changes">>();
  const [path, setPath] = useState("");
  const [confirmFile, setConfirmFile] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const mutationKey = useRef(crypto.randomUUID());
  const ref = { workspacePath: context.workspacePath, sessionId: context.sessionId ?? "" };

  useEffect(() => {
    if (!checkpointId || (kind !== "rewind" && kind !== "changes")) return;
    let stale = false;
    setPending(true);
    setError("");
    setPreview(undefined);
    setChanges(undefined);
    setConfirmFile(false);
    const request =
      kind === "rewind"
        ? window.pico.runtime["rewind.preview"]({ ...ref, checkpointId })
        : window.pico.runtime["rewind.changes"]({ ...ref, checkpointId });
    void request
      .then((response) => {
        if (stale) return;
        if (!response.ok) throw new Error(response.error.message);
        if ("files" in response.value) {
          setChanges(response.value);
          setPath(response.value.files[0]?.path ?? "");
        } else setPreview(response.value);
        mutationKey.current = crypto.randomUUID();
      })
      .catch((cause: unknown) => {
        if (!stale) setError(String(cause));
      })
      .finally(() => {
        if (!stale) setPending(false);
      });
    return () => {
      stale = true;
    };
  }, [checkpointId, kind, context.workspacePath, context.sessionId, refresh]);

  async function apply() {
    if (readOnly) return;
    if (inFlight.current || pending) return;
    const file = changes?.files.find((item) => item.path === path);
    if (!preview && !file) return;
    if (file && !confirmFile) {
      setConfirmFile(true);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      if (preview) {
        const response = await window.pico.runtime["rewind.apply"]({
          ...ref,
          checkpointId,
          mode,
          expectedFingerprint: preview.fingerprint,
          idempotencyKey: mutationKey.current,
        });
        if (!response.ok) throw new Error(response.error.message);
        if (response.value.sourceSessionId !== ref.sessionId)
          throw new Error("回退返回的源会话不一致，请重新载入。");
        if (!response.value.applied) throw new Error("未应用回退，请重新预览。");
        if (live.current)
          onRewind(
            response.value.sessionId,
            String(snapshots.find((item) => item.messageId === checkpointId)?.userPrompt ?? ""),
          );
      } else if (file) {
        const response = await window.pico.runtime["rewind.restoreFile"]({
          ...ref,
          checkpointId,
          path: file.path,
          expectedFingerprint: file.fingerprint,
        });
        if (!response.ok) throw new Error(response.error.message);
        if (!response.value.restored) throw new Error("文件未恢复，请重新预览。");
        if (live.current) {
          setConfirmFile(false);
          setRefresh((value) => value + 1);
        }
      }
    } catch (cause) {
      if (live.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setConfirmFile(false);
      }
    } finally {
      inFlight.current = false;
      if (live.current) setPending(false);
    }
  }

  const title = {
    help: "命令帮助",
    model: "选择模型",
    session: "恢复历史会话",
    rewind: "回退到检查点",
    changes: "检查点文件更改",
  }[kind];
  const needle = query.toLowerCase();
  const rows =
    kind === "help"
      ? catalog.map((item) => ({
          id: item.name,
          title: `/${item.name}`,
          detail: `${item.tier === "advanced" ? "高级 · " : ""}${item.description} ${item.usage ?? ""}${item.disabledReason ? ` · ${item.disabledReason}` : ""}`,
          command: `/help ${item.name}`,
        }))
      : kind === "session" && Array.isArray(result.data)
        ? result.data.filter(isRecord).map((item) => ({
            id: String(item.id),
            title: String(item.title || item.id),
            detail: `${item.isCurrent ? "当前会话 · " : ""}${item.id}`,
            command: `/resume ${item.id}`,
          }))
        : [];
  const file = changes?.files.find((item) => item.path === path);
  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      aria-label={title}
      width="min(680px, calc(100vw - 32px))"
    >
      <section className="command-dialog" aria-busy={pending}>
        <h2>{title}</h2>
        {readOnly && (kind === "rewind" || kind === "changes") && (
          <p role="status">任务运行中，可以查看检查点；结束后才能回退或恢复文件。</p>
        )}
        {(kind === "help" || kind === "session") && (
          <>
            <TextField
              label="搜索命令或选项"
              placeholder="搜索名称或 ID…"
              value={query}
              onValueChange={setQuery}
              autoFocus
            />
            {kind === "help" && result.message && <pre>{result.message}</pre>}
            <div className="command-dialog__list">
              {rows
                .filter((row) => `${row.title} ${row.detail}`.toLowerCase().includes(needle))
                .map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className="command-dialog__choice"
                    onClick={() => onCommand(row.command)}
                  >
                    <strong>{row.title}</strong>
                    <span>{row.detail}</span>
                  </button>
                ))}
              {rows.length === 0 && <p>没有可选项。</p>}
            </div>
          </>
        )}
        {kind === "rewind" && (
          <>
            <SelectField
              label="检查点"
              value={checkpointId}
              disabled={pending}
              onValueChange={setCheckpointId}
              options={[
                { value: "", label: "选择检查点" },
                ...snapshots.map((item) => ({
                  value: String(item.messageId),
                  label: `${item.userPrompt} · ${item.changedFileCount} 个文件${item.incomplete ? "（快照不完整）" : ""}`,
                })),
              ]}
            />
            {preview && (
              <>
                <p>
                  检查点：{checkpointId} · 将回退 {preview.changes.length}{" "}
                  个文件。请确认预览和回退范围。
                </p>
                <pre className="command-dialog__diff">
                  {preview.changes
                    .map(
                      (item) =>
                        `${item.path}\n${item.patch ?? `${item.status} +${item.additions} -${item.deletions}`}`,
                    )
                    .join("\n\n") || "没有文件变更。"}
                </pre>
                <SelectField
                  label="回退范围"
                  value={mode}
                  disabled={pending}
                  onValueChange={(value) => {
                    setMode(value as RuntimeRewindMode);
                    mutationKey.current = crypto.randomUUID();
                  }}
                  options={[
                    { value: "both", label: "代码与对话" },
                    { value: "code", label: "仅代码" },
                    { value: "conversation", label: "仅对话" },
                  ]}
                />
              </>
            )}
          </>
        )}
        {kind === "changes" && changes && (
          <>
            {changes.warnings?.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
            {changes.partial && <p>部分文件的预览不可用。</p>}
            <SelectField
              label="文件"
              value={path}
              disabled={pending}
              onValueChange={(value) => {
                setPath(value);
                setConfirmFile(false);
              }}
              options={changes.files.map((item) => ({
                value: item.path,
                label: `${item.path} +${item.additions} -${item.deletions}`,
              }))}
            />
            <pre className="command-dialog__diff">
              {file?.patch || "没有文件变更。"}
              {file?.truncated ? "\n（差异已截断）" : ""}
            </pre>
            {confirmFile && (
              <p role="alert">确认将 {path} 恢复到检查点之前？这会修改工作区文件。</p>
            )}
          </>
        )}
        {pending && <p role="status">正在处理…</p>}
        {error && <p role="alert">{error}</p>}
        <div className="command-dialog__actions">
          {(kind === "rewind" || kind === "changes") && checkpointId && (
            <Button
              label="重新预览"
              variant="ghost"
              isDisabled={pending}
              onClick={() => setRefresh((value) => value + 1)}
            />
          )}
          <Button label="关闭" variant="ghost" isDisabled={pending} onClick={onClose} />
          {(preview || file) && (
            <Button
              label={preview ? "确认回退" : confirmFile ? "确认恢复此文件" : "恢复此文件"}
              isDisabled={pending || readOnly}
              onClick={() => void apply()}
            />
          )}
        </div>
      </section>
    </Dialog>
  );
}
