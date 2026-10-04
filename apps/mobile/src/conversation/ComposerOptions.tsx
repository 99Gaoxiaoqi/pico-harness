import React, { useEffect, useRef, useState } from "react";
import { Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import type { RuntimeCatalogAgent, RuntimeScopedSkill } from "@pico/protocol/mobile";
import { ActionsSheet } from "../ActionsSheet";
import { Button, Busy, Label, color, s } from "../ui";
import { usePico } from "../store";
import type { useMessageComposer } from "./useMessageComposer";

const sendModes = [
  { value: "auto", label: "自动", detail: "空闲时开始新任务；运行中补充引导。" },
  { value: "steer", label: "引导", detail: "为运行中的任务补充要求；空闲时开始新任务。" },
  { value: "queue", label: "排队", detail: "有任务运行时，等当前任务结束后处理。" },
  { value: "replace", label: "替换", detail: "有任务运行时，停止当前任务并排队处理这条消息。" },
] as const;

export function ComposerOptions({
  composer,
  active = true,
  modelSummary,
  onSettings,
  sessionMenu,
  transcriptDetails,
}: {
  composer: ReturnType<typeof useMessageComposer>;
  active?: boolean;
  modelSummary: string;
  onSettings: () => void;
  sessionMenu: (onClose: () => void) => React.ReactNode;
  transcriptDetails?: React.ReactNode;
}) {
  const pico = usePico();
  const [page, setPage] = useState<
    "options" | "skills" | "agents" | "session" | "mode" | "details"
  >();
  const [skills, setSkills] = useState<readonly RuntimeScopedSkill[]>([]);
  const [agents, setAgents] = useState<readonly RuntimeCatalogAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  useEffect(() => {
    close();
    setSkills([]);
    setAgents([]);
    return () => {
      generation.current++;
    };
  }, [active, pico.host?.id, pico.workspace?.id]);
  function close() {
    generation.current++;
    setPage(undefined);
    setLoading(false);
    setError(undefined);
  }
  async function load(kind: "skills" | "agents") {
    const validScope = composer.captureSelection();
    const id = ++generation.current;
    setPage(kind);
    setLoading(true);
    setError(undefined);
    try {
      if (kind === "skills") {
        const result = await pico.request("skills.effective.list", {});
        if (id === generation.current && validScope())
          setSkills(result.skills.filter((skill) => skill.source.effective));
      } else {
        const result = await pico.request("catalog.agents", {});
        if (id === generation.current && validScope()) setAgents(result.agents);
      }
    } catch (e) {
      if (id === generation.current && validScope()) {
        setError(e instanceof Error ? e.message : "目录读取失败");
        pico.report(e);
      }
    } finally {
      if (id === generation.current && validScope()) setLoading(false);
    }
  }
  function back() {
    generation.current++;
    setLoading(false);
    setError(undefined);
    setPage("options");
  }
  const reason = !active ? "当前对话未显示" : composer.optionsReason;
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="添加与会话选项"
        accessibilityState={{ disabled: !active }}
        disabled={!active}
        style={({ pressed }) => [styles.addTarget, { opacity: !active ? 0.5 : pressed ? 0.75 : 1 }]}
        onPress={() => {
          Keyboard.dismiss();
          setPage("options");
        }}
      >
        <Text style={styles.addIcon}>＋</Text>
      </Pressable>
      <ActionsSheet
        title={
          page === "skills"
            ? "选择 Skill"
            : page === "agents"
              ? "选择 Agent"
              : page === "session"
                ? "会话操作"
                : page === "mode"
                  ? "发送方式"
                  : page === "details"
                    ? "高级记录详情"
                    : "消息选项"
        }
        open={active && !!page}
        onClose={close}
      >
        {page === "options" ? (
          <>
            <Button
              title="从相册选择"
              quiet
              reason={reason ?? (composer.selectedAgent ? "Agent 输入不支持图片" : undefined)}
              onPress={() => {
                close();
                void composer.addImage();
              }}
            />
            <Button
              title="拍照"
              quiet
              reason={reason ?? (composer.selectedAgent ? "Agent 输入不支持图片" : undefined)}
              onPress={() => {
                close();
                void composer.addImage(true);
              }}
            />
            <Button
              title="选择 Skill"
              quiet
              reason={
                reason ??
                pico.reason("skills.effective.list") ??
                (composer.selectedAgent ? "先移除 Agent" : undefined)
              }
              onPress={() => void load("skills")}
            />
            <Button
              title="选择 Agent"
              quiet
              reason={
                reason ??
                pico.reason("catalog.agents") ??
                (composer.selectedSkills.length || composer.images.length
                  ? "先移除 Skill 和图片"
                  : undefined)
              }
              onPress={() => void load("agents")}
            />
            <View style={styles.settingsGroup}>
              <Button
                title="模型与会话设置"
                quiet
                onPress={() => {
                  close();
                  onSettings();
                }}
              />
              <Label>{modelSummary}</Label>
              <Button
                title={`发送方式 · ${sendModes.find((option) => option.value === composer.mode)!.label}`}
                quiet
                onPress={() => setPage("mode")}
              />
              <Button title="会话操作" quiet onPress={() => setPage("session")} />
            </View>
          </>
        ) : page === "session" ? (
          <>
            <Button title="返回选项" quiet onPress={back} />
            {sessionMenu(close)}
            {transcriptDetails && (
              <Button title="高级记录详情" quiet onPress={() => setPage("details")} />
            )}
          </>
        ) : page === "details" ? (
          <>
            <Button title="返回会话操作" quiet onPress={() => setPage("session")} />
            {transcriptDetails}
          </>
        ) : page === "mode" ? (
          <>
            <Button title="返回选项" quiet onPress={back} />
            <Label>电脑有任务运行时，选择这条消息如何参与执行。</Label>
            {sendModes.map((option) => (
              <Pressable
                key={option.value}
                accessibilityRole="radio"
                accessibilityState={{ checked: composer.mode === option.value, disabled: !!reason }}
                disabled={!!reason}
                onPress={() => {
                  composer.setMode(option.value);
                  close();
                }}
                style={[styles.modeOption, composer.mode === option.value && styles.modeSelected]}
              >
                <Text style={[s.text, composer.mode === option.value && { color: color.accent }]}>
                  {option.label}
                  {composer.mode === option.value ? " · 已选择" : ""}
                </Text>
                <Label>{option.detail}</Label>
              </Pressable>
            ))}
          </>
        ) : (
          <>
            <Button title="返回选项" quiet onPress={back} />
            {loading ? (
              <Busy label="读取电脑目录" />
            ) : error ? (
              <>
                <Label>{error}</Label>
                <Button
                  title="重新读取"
                  secondary
                  onPress={() => void load(page! as "skills" | "agents")}
                />
              </>
            ) : page === "skills" ? (
              <>
                {!skills.length && <Label>当前工作区没有可用 Skill。</Label>}
                {skills.map((skill) => {
                  const selected = composer.selectedSkills.some(
                    (ref) => ref.name === skill.name && ref.sourceId === skill.source.sourceId,
                  );
                  return (
                    <View key={`${skill.name}/${skill.source.sourceId}`} style={styles.option}>
                      <Button
                        title={`${selected ? "已选择 · " : ""}${skill.name}`}
                        secondary
                        reason={
                          reason ??
                          (selected
                            ? "已选择"
                            : composer.selectedSkills.length >= 16
                              ? "最多选择 16 个 Skill"
                              : composer.selectedAgent
                                ? "先移除 Agent"
                                : undefined)
                        }
                        reasonDetail={false}
                        onPress={() =>
                          composer.setSelectedSkills((previous) => [
                            ...previous,
                            { name: skill.name, sourceId: skill.source.sourceId },
                          ])
                        }
                      />
                      <Text style={s.muted}>{skill.description || skill.source.sourceLabel}</Text>
                    </View>
                  );
                })}
                <Label>已选 {composer.selectedSkills.length}/16；选择后可继续输入任务。</Label>
              </>
            ) : (
              <>
                {!agents.length && <Label>当前工作区没有可用 Agent。</Label>}
                {agents.map((agent) => (
                  <View
                    key={`${agent.name}/${agent.subagentId ?? "profile"}`}
                    style={styles.option}
                  >
                    <Button
                      title={agent.name}
                      secondary
                      reason={
                        reason ??
                        (composer.selectedSkills.length || composer.images.length
                          ? "先移除 Skill 和图片"
                          : undefined)
                      }
                      onPress={() => {
                        composer.setSelectedAgent({
                          name: agent.name,
                          ...(agent.subagentId ? { subagentId: agent.subagentId } : {}),
                        });
                        close();
                      }}
                    />
                    <Text style={s.muted}>{agent.description}</Text>
                  </View>
                ))}
                <Label>选定 Agent 后，在消息框描述它需要执行的任务。</Label>
              </>
            )}
          </>
        )}
      </ActionsSheet>
    </View>
  );
}
export function ComposerReferences({
  composer,
  active = true,
}: {
  composer: ReturnType<typeof useMessageComposer>;
  active?: boolean;
}) {
  if (
    !composer.selectedSkills.length &&
    !composer.selectedAgent &&
    !composer.draftError &&
    composer.mode === "auto"
  )
    return null;
  const reason = !active ? "当前对话未显示" : composer.optionsReason;
  return (
    <View style={{ gap: 6 }}>
      {!!composer.selectedSkills.length && (
        <View style={s.row}>
          {composer.selectedSkills.map((skill, index) => (
            <Pressable
              key={`${skill.name}/${skill.sourceId ?? skill.sourcePath ?? index}`}
              accessibilityRole="button"
              accessibilityLabel={`移除 Skill ${skill.name}`}
              accessibilityState={{ disabled: !!reason }}
              disabled={!!reason}
              onPress={() =>
                composer.setSelectedSkills((previous) =>
                  previous.filter(
                    (ref) =>
                      ref.name !== skill.name ||
                      ref.sourceId !== skill.sourceId ||
                      ref.sourcePath !== skill.sourcePath,
                  ),
                )
              }
              style={styles.chip}
            >
              <Text style={styles.chipText}>Skill · {skill.name} ×</Text>
            </Pressable>
          ))}
        </View>
      )}
      {composer.selectedAgent && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`移除 Agent ${composer.selectedAgent.name}`}
          accessibilityState={{ disabled: !!reason }}
          disabled={!!reason}
          onPress={() => composer.setSelectedAgent(undefined)}
          style={[styles.chip, { alignSelf: "flex-start" }]}
        >
          <Text style={styles.chipText}>Agent · {composer.selectedAgent.name} ×</Text>
        </Pressable>
      )}
      {composer.draftError && (
        <View style={{ gap: 6 }}>
          <Label>{composer.draftError}</Label>
          <Button title="清除本地草稿" secondary onPress={() => void composer.clearDraft()} />
        </View>
      )}
      {composer.mode !== "auto" && (
        <Label>
          发送方式：{sendModes.find((option) => option.value === composer.mode)!.label} · 在 ＋
          中修改
        </Label>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  settingsGroup: { borderTopWidth: 1, borderTopColor: color.line, paddingTop: 8, gap: 4 },
  modeOption: { minHeight: 64, paddingVertical: 12, gap: 4 },
  modeSelected: { backgroundColor: color.accentSoft },
  addTarget: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  addIcon: { color: color.muted, fontSize: 24, lineHeight: 30 },
  chip: {
    minHeight: 44,
    paddingHorizontal: 10,
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: color.accentSoft,
  },
  chipText: { color: color.accentStrong, fontSize: 13 },
  option: { gap: 4, paddingVertical: 4 },
});
