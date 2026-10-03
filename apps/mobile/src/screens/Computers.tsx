import React, { useEffect, useState } from "react";
import { Alert, AppState, Linking, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { usePico } from "../store";
import { Button, Card, Field, Label, s, color } from "../ui";
import { inspectHostLocalData } from "../local-data";
import type { SavedHost } from "../core";

export function Computers() {
  const pico = usePico();
  const [pairing, setPairing] = useState(false);
  const [scanner, setScanner] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [raw, setRaw] = useState("");
  const [name, setName] = useState("我的手机");
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const off = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        setScanner(false);
        setRaw("");
      }
    });
    return () => off.remove();
  }, []);
  async function confirmClear(host: SavedHost, unlink: boolean) {
    const status = await inspectHostLocalData(host.id);
    const title = unlink ? "解除配对并清除本机数据？" : "清除这台电脑的本机数据？";
    const description = [
      "将删除该电脑的本机草稿、图片、发送和审阅恢复记录、可归属的成果缓存；电脑会话、任务和终端保留。",
      unlink
        ? "同时移除本机凭据，并尝试撤销电脑上的设备授权。"
        : "保留设备凭据，清理完成后可手动连接。",
      status.hasUnconfirmed
        ? "还有结果未确认的操作，电脑可能已执行。建议先查看状态；仍清除会永久放弃本机恢复记录，不会撤销或重新提交操作。"
        : "此操作无法撤回。",
      status.legacyCache ? "无法辨认归属的旧版成果缓存会保留，可在设置中单独清空。" : "",
    ]
      .filter(Boolean)
      .join("\n");
    Alert.alert(title, description, [
      { text: "返回", style: "cancel" },
      ...(status.hasUnconfirmed
        ? [{ text: "先查看电脑状态", onPress: () => void pico.connect(host) }]
        : []),
      {
        text: status.hasUnconfirmed ? "放弃恢复并清除" : "确认清除",
        style: "destructive",
        onPress: () =>
          void pico.perform(async () => {
            if (unlink) await pico.remove(host, status.hasUnconfirmed);
            else {
              const result = await pico.clearLocalData(host, status.hasUnconfirmed);
              Alert.alert(
                "本机数据已清除",
                result.legacyCacheRemaining
                  ? "本机凭据保留。旧版成果缓存仍保留，可在设置中单独清空。"
                  : "本机凭据保留，可手动连接；电脑任务与文件保留。",
              );
            }
          }),
      },
    ]);
  }
  async function pair(value: string) {
    if (busy) return;
    setBusy(true);
    setScanner(false);
    setRaw("");
    try {
      await pico.pair(value, name);
      setPairing(false);
      setRaw("");
    } catch (e) {
      pico.report(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Text style={styles.sectionTitle}>我的电脑</Text>
      {pico.hosts.map((host) => (
        <Card key={host.id}>
          <Text style={s.text}>{host.name}</Text>
          <Label>{host.baseUrl}</Label>
          <View style={s.row}>
            <Button
              title={pico.host?.id === host.id ? "重新连接" : "连接"}
              onPress={() => void pico.connect(host)}
            />
            <Button
              title="清除本机数据"
              quiet
              onPress={() => void pico.perform(() => confirmClear(host, false))}
            />
            <Button
              title="解除配对并清除"
              quiet
              onPress={() => void pico.perform(() => confirmClear(host, true))}
            />
          </View>
        </Card>
      ))}
      {(!pico.hosts.length || help) && (
        <Card>
          <Text style={s.text}>配对准备</Text>
          <Label>1. 在电脑启动 Pico，确认项目已注册并信任。</Label>
          <Label>
            2. 准备手机网络可达的公网 HTTPS 地址与系统信任的证书，配置网关后运行 pico remote
            start，保持电脑唤醒。
          </Label>
          <Label>3. 在电脑另开终端运行 pico remote pair，扫描或粘贴完整配对内容。</Label>
          <Label>4. 在电脑核对手机名称与权限并批准；手机完成确认后，电脑才会出现在列表中。</Label>
          <Label>
            pico remote doctor
            仅检查电脑本机，不能证明蜂窝网络已连通。域名、端口、路由器和地址族也须可达。
          </Label>
        </Card>
      )}
      <Button
        title={help ? "收起配对帮助" : "配对与连接帮助"}
        quiet
        onPress={() => setHelp(!help)}
      />
      {pico.pairing && (
        <Card>
          <Text style={s.text}>
            {pico.pairing.phase === "approval" ? "等待电脑批准" : "等待配对确认"}
          </Text>
          <Label>
            {pico.pairing.publicUrl} · {pico.pairing.deviceName}
          </Label>
          <Label>
            原申请有效至 {new Date(pico.pairing.expiresAt).toLocaleTimeString()}
            。回到前台会继续原申请；网络失败后可再次核对，无需重复批准。
          </Label>
          <Button
            title="继续原配对"
            reason={busy ? "正在处理原申请" : undefined}
            onPress={() => void pico.perform(pico.resumePairing)}
          />
          <Button
            title="取消并清除本机申请"
            quiet
            onPress={() =>
              Alert.alert(
                "取消配对？",
                "清除手机待确认记录并尝试撤销已领取授权。未确认或无法远程撤销的设备请在电脑检查；原临时授予仍按期限失效。",
                [
                  { text: "返回", style: "cancel" },
                  {
                    text: "取消配对",
                    style: "destructive",
                    onPress: () => {
                      setRaw("");
                      setScanner(false);
                      setPairing(false);
                      void pico.perform(pico.cancelPairing);
                    },
                  },
                ],
              )
            }
          />
        </Card>
      )}
      <Button
        title="配对新电脑"
        reason={pico.pairing ? "请先继续或取消原申请" : undefined}
        onPress={() => setPairing(!pairing)}
      />
      {pairing && (
        <Card>
          <Field label="手机名称" value={name} onChange={setName} />
          <Button
            title="扫描电脑二维码"
            reason={busy || pico.pairing ? "请先处理原申请" : undefined}
            onPress={() => {
              if (permission?.granted) setScanner(true);
              else
                void pico.perform(async () => {
                  const result = await requestPermission();
                  setScanner(result.granted);
                });
            }}
          />
          {permission && !permission.granted && (
            <View style={{ gap: 6 }}>
              <Label>相机未获授权，仍可粘贴配对内容。可在系统设置中允许相机。</Label>
              <Button
                title="打开系统权限设置"
                secondary
                onPress={() => void pico.perform(() => Linking.openSettings())}
              />
            </View>
          )}
          {scanner && (
            <CameraView
              style={{ height: 280, borderRadius: 14 }}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => void pair(data)}
            />
          )}
          <Field
            label="或粘贴配对内容"
            value={raw}
            onChange={setRaw}
            multiline
            placeholder="电脑配对命令输出的 JSON"
          />
          <Button
            title={busy ? "等待电脑批准…" : "提交配对"}
            reason={
              busy || pico.pairing
                ? "请在电脑确认，或取消原申请"
                : !raw
                  ? "扫描或粘贴配对内容"
                  : undefined
            }
            onPress={() => void pair(raw)}
          />
          <Label>使用系统信任的 HTTPS 证书。配对有效期 5 分钟。</Label>
        </Card>
      )}
      {pico.host && (
        <Card>
          <Text style={s.text}>已授权工作区</Text>
          {pico.workspaces.map((w) => (
            <Button key={w.id} title={w.label} secondary onPress={() => pico.chooseWorkspace(w)} />
          ))}
          {!pico.workspaces.length && <Label>电脑尚未授权工作区，请在电脑调整设备授权。</Label>}
          <Button title="断开电脑" quiet onPress={pico.disconnect} />
        </Card>
      )}
    </>
  );
}
const styles = StyleSheet.create({
  sectionTitle: { color: color.text, fontSize: 20, fontWeight: "600", letterSpacing: -0.3 },
});
