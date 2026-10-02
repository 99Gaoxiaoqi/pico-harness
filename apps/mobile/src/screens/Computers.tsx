import React, { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { usePico } from "../store";
import { Button, Card, Field, Label, s, color } from "../ui";

export function Computers() {
  const pico = usePico();
  const [pairing, setPairing] = useState(false);
  const [scanner, setScanner] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [raw, setRaw] = useState("");
  const [name, setName] = useState("我的手机");
  const [busy, setBusy] = useState(false);
  async function pair(value: string) {
    if (busy) return;
    setBusy(true);
    setScanner(false);
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
              title="解除配对"
              quiet
              onPress={() =>
                Alert.alert(
                  "解除这台电脑的配对？",
                  "手机将移除凭据，并尝试撤销电脑上的设备授权。",
                  [
                    { text: "返回" },
                    {
                      text: "解除",
                      style: "destructive",
                      onPress: () => void pico.perform(() => pico.remove(host)),
                    },
                  ],
                )
              }
            />
          </View>
        </Card>
      ))}
      {!pico.hosts.length && (
        <Card>
          <Text style={s.text}>把电脑上的 Pico 带到手机</Text>
          <Label>在电脑启动网关并运行 pico remote pair，扫描二维码。手机可使用蜂窝网络。</Label>
        </Card>
      )}
      <Button title="配对新电脑" onPress={() => setPairing(!pairing)} />
      {pairing && (
        <Card>
          <Field label="手机名称" value={name} onChange={setName} />
          <Button
            title="扫描电脑二维码"
            reason={busy ? "等待电脑批准" : undefined}
            onPress={() => {
              if (!permission?.granted) void requestPermission().then((x) => setScanner(x.granted));
              else setScanner(true);
            }}
          />
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
            reason={busy ? "请在电脑确认" : !raw ? "扫描或粘贴配对内容" : undefined}
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
