import React, { useEffect, useRef, useState } from "react";
import { Switch, Text, View } from "react-native";
import type { RuntimeResult } from "@pico/protocol/mobile";
import { usePico } from "../store";
import { Button, Card, Chips, Field, Label, s, switchColors } from "../ui";
import { confirmDelete } from "./confirmDelete";
import { saveAutomation, scheduleCron, scheduleDraft, type ScheduleKind } from "./management";

const jobStatus = { idle: "待运行", running: "运行中", failed: "失败", succeeded: "成功" };

type Job = RuntimeResult<"jobs.list">["jobs"][number];
export function Jobs() {
  const pico = usePico();
  const readVersion = useRef(0);
  const readScope = `${pico.generation}:${pico.connected}:${pico.syncRevision}`;
  const currentScope = useRef(readScope);
  currentScope.current = readScope;
  const [jobs, setJobs] = useState<readonly Job[]>([]);
  const [editing, setEditing] = useState<{ job?: Job; name: string; prompt: string }>();
  const [kind, setKind] = useState<ScheduleKind>("daily");
  const [time, setTime] = useState("09:00"),
    [weekday, setWeekday] = useState("1"),
    [advanced, setAdvanced] = useState("0 9 * * *");
  const [history, setHistory] = useState<{
    jobId: string;
    name: string;
    runs: RuntimeResult<"jobs.history">["runs"];
  }>();
  const [saving, setSaving] = useState(false);
  async function refresh() {
    if (pico.connected === false) return;
    const version = ++readVersion.current;
    const [result, runs] = await Promise.all([
      pico.request("jobs.list", {}),
      history ? pico.request("jobs.history", { jobId: history.jobId, limit: 20 }) : undefined,
    ]);
    if (version !== readVersion.current || readScope !== currentScope.current) return;
    setJobs(result.jobs);
    if (history && runs) setHistory({ ...history, runs: runs.runs });
  }
  async function openHistory(job: Job) {
    const version = ++readVersion.current;
    const result = await pico.request("jobs.history", { jobId: job.jobId, limit: 20 });
    if (version !== readVersion.current || readScope !== currentScope.current) return;
    setHistory({ jobId: job.jobId, name: job.name, runs: result.runs });
  }
  useEffect(() => {
    setEditing(undefined);
    setHistory(undefined);
    setJobs([]);
  }, [pico.generation]);
  useEffect(() => {
    if (pico.connected !== false && !pico.reason("jobs.list")) void pico.perform(refresh);
    return () => {
      ++readVersion.current;
    };
  }, [pico.generation, pico.connected, pico.syncRevision]);
  function open(job?: Job) {
    const draft = scheduleDraft(job?.schedule ?? "0 9 * * *");
    setKind(draft.kind);
    setTime(draft.time);
    setWeekday(draft.weekday);
    setAdvanced(draft.advanced);
    setHistory(undefined);
    setEditing({ job, name: job?.name ?? "", prompt: job?.prompt ?? "" });
  }
  async function mutate(task: () => Promise<unknown>) {
    if (saving) return;
    setSaving(true);
    try {
      await task();
      await refresh();
    } finally {
      setSaving(false);
    }
  }
  let cron = "",
    problem: string | undefined;
  try {
    cron = scheduleCron(kind, time, weekday, advanced);
  } catch (error) {
    problem = error instanceof Error ? error.message : "日程无效";
  }
  if (editing)
    return (
      <Card>
        <Text style={s.text}>{editing.job ? "编辑自动化" : "新建自动化"}</Text>
        <Field
          label="名称"
          value={editing.name}
          onChange={(name) => setEditing({ ...editing, name })}
        />
        <Field
          label="任务说明"
          value={editing.prompt}
          onChange={(prompt) => setEditing({ ...editing, prompt })}
          multiline
        />
        <Label>
          执行时区：{editing.job?.timeZone ?? "由电脑决定（电脑尚未返回时区标识）"}
          。时间不按手机所在地自动转换。
        </Label>
        <Chips
          values={["daily", "weekdays", "weekly", "advanced"] as const}
          value={kind}
          labels={{ daily: "每天", weekdays: "工作日", weekly: "每周", advanced: "高级 Cron" }}
          onChange={(value) => {
            if (value === "advanced" && !problem) setAdvanced(cron);
            setKind(value);
          }}
        />
        {kind === "advanced" ? (
          <Field
            label="Cron 计划规则"
            value={advanced}
            onChange={setAdvanced}
            placeholder="0 9 * * *"
          />
        ) : (
          <>
            <Field
              label="执行时间（HH:mm，电脑任务时区）"
              value={time}
              onChange={setTime}
              placeholder="09:00"
            />
            {kind === "weekly" && (
              <Chips
                values={["1", "2", "3", "4", "5", "6", "0"]}
                value={weekday}
                labels={{
                  "1": "周一",
                  "2": "周二",
                  "3": "周三",
                  "4": "周四",
                  "5": "周五",
                  "6": "周六",
                  "0": "周日",
                }}
                onChange={setWeekday}
              />
            )}
          </>
        )}
        <Label>{problem ?? `Cron：${cron}`}</Label>
        <Button
          title={saving ? "正在保存…" : "保存自动化"}
          reason={
            saving
              ? "正在保存"
              : !editing.name.trim() || !editing.prompt.trim()
                ? "填写名称和任务说明"
                : (problem ?? pico.reason(editing.job ? "jobs.update" : "jobs.create"))
          }
          onPress={() =>
            void pico.perform(() =>
              mutate(async () => {
                const params = {
                  name: editing.name.trim(),
                  prompt: editing.prompt.trim(),
                  schedule: scheduleCron(kind, time, weekday, advanced),
                };
                await saveAutomation(pico, {
                  ...params,
                  ...(editing.job ? { jobId: editing.job.jobId } : {}),
                });
                setEditing(undefined);
              }),
            )
          }
        />
        <Label>新任务默认关闭。启用和立即运行时，电脑会检查后台执行授权与凭据。</Label>
        <Button
          title="返回自动化列表"
          secondary
          reason={saving ? "正在保存" : undefined}
          onPress={() => setEditing(undefined)}
        />
      </Card>
    );
  if (history)
    return (
      <Card>
        <Text style={s.text}>{history.name} · 执行历史</Text>
        <Button title="返回自动化列表" secondary onPress={() => setHistory(undefined)} />
        {history.runs.length === 0 && <Label>暂无执行记录。</Label>}
        {history.runs.map((run) => (
          <View key={run.runId}>
            <Text style={s.text}>{run.description}</Text>
            <Label>{run.status}</Label>
          </View>
        ))}
      </Card>
    );
  return (
    <>
      <Card>
        <Text style={s.text}>当前项目自动化</Text>
        <Label>按电脑保存的计划规则执行。完成通知目前仅在手机前台同步。</Label>
        <View style={s.row}>
          <Button title="新建自动化" reason={pico.reason("jobs.create")} onPress={() => open()} />
          <Button
            title="刷新"
            secondary
            reason={saving ? "正在保存" : pico.reason("jobs.list")}
            onPress={() => void pico.perform(refresh)}
          />
        </View>
      </Card>
      {jobs.length === 0 && <Label>暂无自动化。</Label>}
      {jobs.map((job) => (
        <Card key={job.jobId}>
          <Text style={s.text}>{job.name}</Text>
          <Label>
            {job.schedule} · {jobStatus[job.status]} · 时区：{job.timeZone ?? "电脑任务时区"}
          </Label>
          <Text style={s.text}>{job.prompt}</Text>
          <View style={[s.row, { minHeight: 44 }]}>
            <Label>启用</Label>
            <Switch
              {...switchColors}
              hitSlop={8}
              accessibilityLabel={`启用 ${job.name}`}
              value={job.enabled}
              disabled={saving || !!pico.reason("jobs.setEnabled")}
              onValueChange={(enabled) =>
                void pico.perform(() =>
                  mutate(() => pico.request("jobs.setEnabled", { jobId: job.jobId, enabled })),
                )
              }
            />
          </View>
          <View style={s.row}>
            <Button
              title="编辑"
              secondary
              reason={saving ? "正在保存" : pico.reason("jobs.update")}
              onPress={() => open(job)}
            />
            <Button
              title="立即运行"
              reason={saving ? "正在保存" : pico.reason("jobs.runNow")}
              onPress={() =>
                void pico.perform(() =>
                  mutate(() => pico.request("jobs.runNow", { jobId: job.jobId })),
                )
              }
            />
            <Button
              title="历史"
              secondary
              reason={pico.reason("jobs.history")}
              onPress={() => void pico.perform(() => openHistory(job))}
            />
            <Button
              title="删除"
              secondary
              reason={saving ? "正在保存" : pico.reason("jobs.delete")}
              onPress={() =>
                confirmDelete(
                  job.name,
                  () =>
                    void pico.perform(() =>
                      mutate(() => pico.request("jobs.delete", { jobId: job.jobId })),
                    ),
                )
              }
            />
          </View>
        </Card>
      ))}
    </>
  );
}
