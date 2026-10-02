import React, { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import type { RuntimeResult } from "@pico/protocol/mobile";
import { usePico } from "../store";
import { Button, Card, Field, Label, s } from "../ui";
import { confirmDelete } from "./confirmDelete";

export function Jobs() {
  const pico = usePico();
  const [jobs, setJobs] = useState<RuntimeResult<"jobs.list">["jobs"]>([]);
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [schedule, setSchedule] = useState("");
  const [history, setHistory] = useState<RuntimeResult<"jobs.history">["runs"]>();
  async function refresh() {
    setJobs((await pico.request("jobs.list", {})).jobs);
  }
  useEffect(() => {
    void pico.perform(refresh);
  }, [pico.generation]);
  return (
    <>
      <Card>
        <Text style={s.text}>{editing ? "编辑自动化" : "新建自动化"}</Text>
        <Field label="名称" value={name} onChange={setName} />
        <Field label="任务说明" value={prompt} onChange={setPrompt} multiline />
        <Field label="Cron 日程" value={schedule} onChange={setSchedule} placeholder="0 9 * * *" />
        <Button
          title="保存"
          reason={
            !name || !prompt || !schedule
              ? "填写名称、任务和日程"
              : pico.reason(editing ? "jobs.update" : "jobs.create")
          }
          onPress={() =>
            void pico.perform(async () => {
              if (editing)
                await pico.request("jobs.update", { jobId: editing, name, prompt, schedule });
              else await pico.request("jobs.create", { name, prompt, schedule, enabled: false });
              setEditing(undefined);
              setName("");
              setPrompt("");
              setSchedule("");
              await refresh();
            })
          }
        />
        <Label>新任务默认关闭；电脑会重新检查后台执行授权与凭据。</Label>
      </Card>
      {jobs.map((job) => (
        <Card key={job.jobId}>
          <Text style={s.text}>{job.name}</Text>
          <Label>
            {job.schedule} · {job.status}
          </Label>
          <Text style={s.text}>{job.prompt}</Text>
          <View style={s.row}>
            <Label>启用</Label>
            <Switch
              value={job.enabled}
              disabled={!!pico.reason("jobs.setEnabled")}
              onValueChange={(enabled) =>
                void pico.perform(async () => {
                  await pico.request("jobs.setEnabled", { jobId: job.jobId, enabled });
                  await refresh();
                })
              }
            />
            <Button
              title="编辑"
              secondary
              onPress={() => {
                setEditing(job.jobId);
                setName(job.name);
                setPrompt(job.prompt);
                setSchedule(job.schedule);
              }}
            />
            <Button
              title="立即运行"
              reason={pico.reason("jobs.runNow")}
              onPress={() =>
                void pico.perform(() => pico.request("jobs.runNow", { jobId: job.jobId }))
              }
            />
            <Button
              title="历史"
              secondary
              onPress={() =>
                void pico.perform(async () =>
                  setHistory(
                    (await pico.request("jobs.history", { jobId: job.jobId, limit: 20 })).runs,
                  ),
                )
              }
            />
            <Button
              title="删除"
              secondary
              reason={pico.reason("jobs.delete")}
              onPress={() =>
                confirmDelete(
                  job.name,
                  () =>
                    void pico.perform(async () => {
                      await pico.request("jobs.delete", { jobId: job.jobId });
                      await refresh();
                    }),
                )
              }
            />
          </View>
        </Card>
      ))}
      {history && (
        <Card>
          <Text style={s.text}>执行历史</Text>
          {history.map((run) => (
            <Text key={run.runId} style={s.text}>
              {run.description} · {run.status}
            </Text>
          ))}
        </Card>
      )}
    </>
  );
}
