import React, { useEffect, useRef, useState } from "react";
import { Switch, Text, View } from "react-native";
import * as Crypto from "expo-crypto";
import type { RuntimeMemoryPageInfo, RuntimeResult } from "@pico/protocol/mobile";
import { usePico } from "../store";
import { Button, Card, Chips, Field, Label, s, switchColors } from "../ui";
import { confirmDelete } from "./confirmDelete";

type Item = RuntimeResult<"memory.list">["items"][number];
export function Memory({ section = "content" }: { section?: "content" | "policy" }) {
  const pico = usePico();
  const [items, setItems] = useState<readonly Item[]>([]);
  const [settings, setSettings] = useState<RuntimeResult<"memory.settings.get">["settings"]>();
  const [scope, setScope] = useState<"all" | "global" | "workspace">("all");
  const [state, setState] = useState<"active" | "archived">("active");
  const [editor, setEditor] = useState<{ item?: Item; text: string }>();
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pageInfo, setPageInfo] = useState<RuntimeMemoryPageInfo>();
  const [notice, setNotice] = useState("");
  const requestEpoch = useRef(0);
  const loadingRef = useRef(false);
  const context = `${pico.generation}:${pico.connected}:${pico.syncRevision}:${section}:${state}`;
  const contextRef = useRef(context);
  contextRef.current = context;
  const method = section === "policy" ? "memory.settings.get" : "memory.list";
  async function refresh() {
    if (pico.connected === false || context !== contextRef.current) return;
    const epoch = ++requestEpoch.current;
    const requestedContext = context;
    const isCurrent = () =>
      epoch === requestEpoch.current && requestedContext === contextRef.current;
    loadingRef.current = true;
    setLoading(true);
    setNotice("");
    if (section === "content") {
      setItems([]);
      setPageInfo(undefined);
    }
    try {
      if (section === "policy") {
        const result = await pico.request("memory.settings.get", {});
        if (isCurrent()) setSettings(result.settings);
      } else {
        const paged = pico.capabilities?.features["memoryPagination"]?.available === true;
        const result = await pico.request("memory.list", {
          ...(paged ? { paged: true as const } : {}),
          limit: 50,
          lifecycleStates: [state],
        });
        if (isCurrent()) {
          setItems(result.items);
          setPageInfo(result.pageInfo);
        }
      }
    } catch (error) {
      if (isCurrent()) throw error;
    } finally {
      if (isCurrent()) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }
  async function loadMore() {
    if (pico.connected === false || !pageInfo?.nextCursor || loadingRef.current) return;
    const epoch = requestEpoch.current;
    const requestedContext = context;
    const revision = pageInfo.revision;
    const isCurrent = () =>
      epoch === requestEpoch.current && requestedContext === contextRef.current;
    loadingRef.current = true;
    setLoading(true);
    try {
      const result = await pico.request("memory.list", {
        paged: true,
        cursor: pageInfo.nextCursor,
        lifecycleStates: [state],
        limit: 50,
      });
      if (!isCurrent()) return;
      if (!result.pageInfo || result.pageInfo.revision !== revision) {
        await refresh();
        return;
      }
      setItems((current) => [...current, ...result.items]);
      setPageInfo(result.pageInfo);
    } catch (error) {
      if (
        isCurrent() &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "CONFLICT"
      ) {
        await refresh();
        if (requestedContext === contextRef.current) setNotice("记忆已改变，已重新加载当前列表。");
      } else if (isCurrent()) throw error;
    } finally {
      if (isCurrent()) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    setEditor(undefined);
    setItems([]);
    setSettings(undefined);
    setPageInfo(undefined);
    setNotice("");
    loadingRef.current = false;
    setLoading(false);
  }, [pico.generation, section, state]);
  useEffect(() => {
    loadingRef.current = false;
    setLoading(false);
    if (pico.connected !== false && !pico.reason(method)) void pico.perform(refresh);
    return () => {
      requestEpoch.current++;
    };
  }, [pico.generation, pico.connected, pico.syncRevision, section, state]);
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
  if (section === "policy")
    return (
      <Card>
        <Text style={s.text}>全局记忆策略</Text>
        <Label>对这台电脑的所有项目生效。当前项目仅用于访问授权，不是独立的项目策略。</Label>
        <Button
          title="刷新策略"
          secondary
          reason={saving ? "正在保存" : pico.reason(method)}
          onPress={() => void pico.perform(refresh)}
        />
        {settings &&
          (["enabled", "autoExtract", "recallEnabled"] as const).map((key) => (
            <View key={key} style={[s.row, { minHeight: 44, justifyContent: "space-between" }]}>
              <Text style={s.text}>
                {{ enabled: "启用记忆", autoExtract: "自动提取", recallEnabled: "对话中召回" }[key]}
              </Text>
              <Switch
                {...switchColors}
                hitSlop={8}
                accessibilityLabel={
                  {
                    enabled: "启用全局记忆",
                    autoExtract: "全局自动提取",
                    recallEnabled: "全局对话召回",
                  }[key]
                }
                value={settings[key]}
                disabled={saving || !!pico.reason("memory.settings.update")}
                onValueChange={(value) =>
                  void pico.perform(() =>
                    mutate(async () => {
                      await pico.request("memory.settings.update", {
                        [key]: value,
                        expectedVersion: settings.version,
                        idempotencyKey: Crypto.randomUUID(),
                      });
                    }),
                  )
                }
              />
            </View>
          ))}
        {pico.reason("memory.settings.update") && (
          <Label>{pico.reason("memory.settings.update")}</Label>
        )}
      </Card>
    );
  if (editor)
    return (
      <Card>
        <Text style={s.text}>{editor.item ? "编辑记忆" : "新增当前项目记忆"}</Text>
        <Label>
          {editor.item?.scopeType === "global"
            ? "作用范围：全局"
            : `作用范围：当前项目（${pico.workspace?.label ?? "所选项目"}）`}
          。保存不会改变作用范围。
        </Label>
        <Field
          label="记忆内容"
          value={editor.text}
          onChange={(text) => setEditor({ ...editor, text })}
          multiline
        />
        <Button
          title={saving ? "正在保存…" : "保存记忆"}
          reason={
            saving
              ? "正在保存"
              : !editor.text.trim()
                ? "请输入内容"
                : pico.reason(editor.item ? "memory.update" : "memory.create")
          }
          onPress={() =>
            void pico.perform(() =>
              mutate(async () => {
                if (editor.item)
                  await pico.request("memory.update", {
                    itemId: editor.item.itemId,
                    content: editor.text.trim(),
                    expectedVersion: editor.item.version,
                    idempotencyKey: Crypto.randomUUID(),
                  });
                else await pico.request("memory.create", { text: editor.text.trim() });
                setEditor(undefined);
              }),
            )
          }
        />
        <Button
          title="返回记忆列表"
          secondary
          reason={saving ? "正在保存" : undefined}
          onPress={() => setEditor(undefined)}
        />
      </Card>
    );
  const visible = items.filter(
    (item) => item.lifecycleState === state && (scope === "all" || item.scopeType === scope),
  );
  return (
    <>
      <Card>
        <Text style={s.text}>全局 + 当前项目</Text>
        <Label>仅包含全局和当前项目的记忆，不包含其他项目。新建内容保存到当前项目。</Label>
        <Label>
          {pageInfo
            ? `已加载 ${items.length} / ${pageInfo.counts.total} 条`
            : `已加载 ${items.length} 条，总数未知；更新电脑端可加载更多`}
          {scope !== "all" ? `；当前范围已加载 ${visible.length} 条` : ""}
        </Label>
        {notice ? <Label>{notice}</Label> : null}
        <Chips
          values={["all", "global", "workspace"] as const}
          value={scope}
          labels={{ all: "全部范围", global: "全局", workspace: "当前项目" }}
          onChange={setScope}
        />
        <Chips
          values={["active", "archived"] as const}
          value={state}
          labels={{ active: "生效中", archived: "已归档" }}
          onChange={setState}
        />
        <View style={s.row}>
          <Button
            title="新增记忆"
            reason={pico.reason("memory.create")}
            onPress={() => setEditor({ text: "" })}
          />
          <Button
            title="刷新"
            secondary
            reason={saving ? "正在保存" : loading ? "正在加载" : pico.reason(method)}
            onPress={() => void pico.perform(refresh)}
          />
        </View>
      </Card>
      {visible.length === 0 && (
        <Label>
          {loading
            ? "正在加载记忆…"
            : pageInfo?.nextCursor
              ? "已加载的记忆中没有当前范围的条目，可继续加载。"
              : "当前筛选下没有记忆。"}
        </Label>
      )}
      {visible.map((item) => (
        <Card key={item.itemId}>
          <Text style={s.text}>{item.content}</Text>
          <Label>
            {item.scopeType === "global" ? "全局" : "当前项目"} ·{" "}
            {item.lifecycleState === "active" ? "生效中" : "已归档"}
          </Label>
          <View style={s.row}>
            <Button
              title="编辑"
              secondary
              reason={saving ? "正在保存" : pico.reason("memory.update")}
              onPress={() => setEditor({ item, text: item.content })}
            />
            <Button
              title={item.lifecycleState === "active" ? "归档" : "恢复"}
              secondary
              reason={saving ? "正在保存" : pico.reason("memory.update")}
              onPress={() =>
                void pico.perform(() =>
                  mutate(() =>
                    pico.request("memory.update", {
                      itemId: item.itemId,
                      expectedVersion: item.version,
                      lifecycleState: item.lifecycleState === "active" ? "archived" : "active",
                      idempotencyKey: Crypto.randomUUID(),
                    }),
                  ),
                )
              }
            />
            <Button
              title="删除"
              secondary
              reason={saving ? "正在保存" : pico.reason("memory.delete")}
              onPress={() =>
                confirmDelete(
                  "记忆",
                  () =>
                    void pico.perform(() =>
                      mutate(() =>
                        pico.request("memory.delete", {
                          itemId: item.itemId,
                          expectedVersion: item.version,
                          idempotencyKey: Crypto.randomUUID(),
                        }),
                      ),
                    ),
                )
              }
            />
          </View>
        </Card>
      ))}
      {pageInfo?.nextCursor && (
        <Button
          title={loading ? "正在加载…" : "加载更多记忆"}
          secondary
          reason={loading ? "正在加载" : saving ? "正在保存" : pico.reason(method)}
          onPress={() => void pico.perform(loadMore)}
        />
      )}
    </>
  );
}
