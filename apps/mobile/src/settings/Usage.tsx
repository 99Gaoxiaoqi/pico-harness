import React, { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { JsonObject } from "@pico/protocol/mobile";
import { usePico } from "../store";
import { Button, Card, Chips, Detail, Field, Label, s } from "../ui";
import { queryWorkspaceUsage } from "./management";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function numeric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function count(value: unknown) {
  const number = numeric(value);
  return number === undefined ? "未提供" : number.toLocaleString();
}
const costs: Record<string, string> = {
  none: "暂无费用记录",
  estimated: "本地估算",
  included: "已包含",
  unknown: "费用未知",
  partial: "部分费用可估算",
};
export function Usage() {
  const pico = usePico();
  const [workspaceId, setWorkspaceId] = useState(pico.workspace?.id ?? "");
  const [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [usage, setUsage] = useState<JsonObject>();
  const [loadedLabel, setLoadedLabel] = useState("");
  const [loading, setLoading] = useState(false);
  const requestVersion = useRef(0);
  function invalidate() {
    requestVersion.current++;
    setUsage(undefined);
    setLoading(false);
  }
  async function refresh(id = workspaceId) {
    const version = ++requestVersion.current;
    setLoading(true);
    setUsage(undefined);
    try {
      const result = await queryWorkspaceUsage(
        pico,
        pico.workspaces.map((item) => item.id),
        id,
        from,
        to,
      );
      if (version !== requestVersion.current) return;
      setUsage(result.usage);
      setLoadedLabel(pico.workspaces.find((item) => item.id === id)?.label ?? "所选项目");
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }
  useEffect(() => {
    const id = pico.workspace?.id ?? "";
    setWorkspaceId(id);
    invalidate();
    if (id && !pico.reason("usage.get")) void pico.perform(() => refresh(id));
  }, [pico.generation]);
  const total = record(usage?.["total"]),
    details = record(usage?.["details"]);
  const costStatus = String(usage?.["costStatus"] ?? "unknown"),
    cost = numeric(total["costCNY"]);
  const models = Array.isArray(details["models"]) ? details["models"].map(record) : [];
  return (
    <>
      <Card>
        <Text style={s.text}>用量与费用</Text>
        <Label>只查询电脑已授权给此设备的项目，不查询整台电脑的全部项目。</Label>
        <Chips
          values={pico.workspaces.map((item) => item.id)}
          value={workspaceId}
          labels={Object.fromEntries(pico.workspaces.map((item) => [item.id, item.label]))}
          onChange={(id) => {
            setWorkspaceId(id);
            invalidate();
          }}
        />
        <Field
          label="开始日期（YYYY-MM-DD，可留空）"
          value={from}
          onChange={(value) => {
            setFrom(value);
            invalidate();
          }}
        />
        <Field
          label="结束日期（YYYY-MM-DD，可留空）"
          value={to}
          onChange={(value) => {
            setTo(value);
            invalidate();
          }}
        />
        <Label>日期边界使用手机本地时区；留空表示不限制该边界。</Label>
        <Button
          title={loading ? "正在查询…" : "查询用量"}
          reason={
            loading ? "正在查询" : !workspaceId ? "请选择已授权项目" : pico.reason("usage.get")
          }
          onPress={() => void pico.perform(() => refresh())}
        />
      </Card>
      {usage && (
        <>
          <Card>
            <Text style={s.text}>{loadedLabel}</Text>
            <Text style={s.title}>{count(total["totalTokens"])} tokens</Text>
            <Label>
              输入 {count(total["inputTokens"])} · 输出 {count(total["outputTokens"])} · 模型调用{" "}
              {count(usage["providerCallCount"])}
            </Label>
            <Text style={s.text}>
              {costs[costStatus] ?? "费用未知"}
              {(costStatus === "estimated" || costStatus === "partial") && cost !== undefined
                ? ` · ¥${cost.toFixed(4)}`
                : ""}
            </Text>
            <Label>费用为本地人民币估算，不是 Provider 账单；未知记录不按零费用处理。</Label>
            <Label>
              缓存读取 {count(total["cacheReadTokens"])} · 缓存写入{" "}
              {count(total["cacheWriteTokens"])}
            </Label>
            {numeric(usage["unknownCostRecordCount"]) !== undefined && (
              <Label>费用未知记录 {count(usage["unknownCostRecordCount"])}</Label>
            )}
          </Card>
          {models.map((model, index) => (
            <Card key={String(model["id"] ?? index)}>
              <Text style={s.text}>{String(model["name"] ?? "模型")}</Text>
              <Label>
                {count(model["totalTokens"])} tokens · {count(model["count"])} 次 ·{" "}
                {costs[String(model["costStatus"])] ?? "费用未知"}
              </Label>
            </Card>
          ))}
          {Array.isArray(details["warnings"]) &&
            details["warnings"].map((warning, index) => (
              <Label key={index}>{String(warning)}</Label>
            ))}
          <View>
            <Detail title="原始用量明细" value={usage} />
          </View>
        </>
      )}
    </>
  );
}
