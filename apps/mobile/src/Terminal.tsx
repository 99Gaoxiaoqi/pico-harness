import React, { useEffect, useRef, useState } from "react";
import { Alert, AppState, ScrollView, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import type { RuntimeTerminalSession } from "@pico/protocol/mobile";
import { usePico } from "./store";
import { SerialPoller } from "./core";
import { Button, Card, Label, s, color } from "./ui";
import html from "./terminal.generated";

export function TerminalPanel({ sessionId }: { sessionId: string }) {
  const pico = usePico();
  const [terminals, setTerminals] = useState<readonly RuntimeTerminalSession[]>([]);
  const [terminal, setTerminal] = useState<RuntimeTerminalSession>();
  const [ready, setReady] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const ref = useRef<WebView>(null);
  const poller = useRef(new SerialPoller());
  const position = useRef<{ epoch: string; sequence: number } | undefined>(undefined);
  const active = useRef(true);
  const pendingOutput = useRef<{ data: string; reset: boolean }[]>([]);
  const control = useRef<RuntimeTerminalSession | undefined>(undefined);
  const inputQueue = useRef(Promise.resolve());
  const inputGeneration = useRef(0);
  const inputBlocked = useRef(false);
  const [blocked, setBlocked] = useState(false);
  async function list() {
    const result = await pico.request("terminal.list", { sessionId });
    if (active.current) setTerminals(result.terminals);
  }
  function output(data: string, reset = false) {
    if (!ready) {
      pendingOutput.current.push({ data, reset });
      return;
    }
    ref.current?.postMessage(JSON.stringify({ type: "output", data, reset }));
  }
  useEffect(() => {
    active.current = true;
    setTerminal(undefined);
    setTerminals([]);
    position.current = undefined;
    void pico.perform(list);
    const app = AppState.addEventListener("change", (state) => setForeground(state === "active"));
    return () => {
      active.current = false;
      inputGeneration.current++;
      app.remove();
      poller.current.stop();
      const t = control.current;
      if (t)
        void pico
          .request("terminal.detach", {
            sessionId,
            terminalId: t.terminalId,
            resourceEpoch: t.resourceEpoch,
          })
          .catch(() => undefined);
    };
  }, [sessionId, pico.generation]);
  useEffect(() => {
    control.current = terminal;
    inputGeneration.current++;
    inputBlocked.current = false;
    setBlocked(false);
    position.current = undefined;
    pendingOutput.current = [];
    if (ready) ref.current?.postMessage(JSON.stringify({ type: "output", data: "", reset: true }));
  }, [terminal?.terminalId]);
  useEffect(() => {
    if (!terminal || !foreground || !pico.connected) return;
    let current = true;
    poller.current.start(async () => {
      const result = await pico.request("terminal.attach", {
        sessionId,
        terminalId: terminal.terminalId,
        ...(position.current ? { afterSequence: position.current.sequence } : {}),
        maxBytes: 32 * 1024,
      });
      if (!current) return;
      const reset = !position.current || position.current.epoch !== result.resourceEpoch;
      position.current = { epoch: result.resourceEpoch, sequence: result.sequence };
      control.current = result.terminal;
      if (reset) setTerminal(result.terminal);
      output(result.snapshot, reset);
      if (result.truncated) pico.report(new Error("终端输出缓冲区已截断，当前显示可用尾部"));
    }, pico.report);
    return () => {
      current = false;
      poller.current.stop();
      const t = control.current;
      if (t)
        void pico
          .request("terminal.detach", {
            sessionId,
            terminalId: t.terminalId,
            resourceEpoch: t.resourceEpoch,
          })
          .catch(() => undefined);
    };
  }, [terminal?.terminalId, foreground, pico.connected, pico.generation, ready]);
  useEffect(() => {
    if (!foreground || !pico.connected) inputGeneration.current++;
  }, [foreground, pico.connected]);
  useEffect(() => {
    if (ready)
      ref.current?.postMessage(
        JSON.stringify({
          type: "readonly",
          value: terminal?.controlAllowed !== true || blocked || !foreground || !pico.connected,
        }),
      );
  }, [ready, terminal?.controlAllowed, blocked, foreground, pico.connected]);
  async function create() {
    const x = await pico.request("terminal.create", { sessionId, cols: 80, rows: 24 });
    if (!active.current) return;
    setTerminal(x.terminal);
    await list();
  }
  function input(data: string) {
    const t = control.current;
    const cursor = position.current;
    if (!t || !cursor || !foreground || !pico.connected || inputBlocked.current) return;
    if (t.controlAllowed !== true) {
      pico.report(new Error("此终端由其他客户端创建，手机仅可查看"));
      return;
    }
    const generation = inputGeneration.current;
    // Keep keystrokes in order; a lost response discards queued input, never resends it.
    inputQueue.current = inputQueue.current.then(async () => {
      if (!active.current || generation !== inputGeneration.current || inputBlocked.current) return;
      try {
        await pico.request("terminal.input", {
          sessionId,
          terminalId: t.terminalId,
          resourceEpoch: cursor.epoch,
          data,
        });
      } catch (error) {
        if (!active.current || generation !== inputGeneration.current) return;
        inputBlocked.current = true;
        setBlocked(true);
        pico.report(
          new Error(
            `终端输入结果未确认，不会自动重发。请检查输出后恢复输入。${error instanceof Error ? error.message : ""}`,
          ),
        );
      }
    });
  }
  return (
    <View style={{ flex: 1, gap: 12 }}>
      <Card>
        <View style={s.row}>
          <Button
            title="新建终端"
            reason={pico.reason("terminal.create")}
            onPress={() => void pico.perform(create)}
          />
          <Button title="刷新" secondary onPress={() => void pico.perform(list)} />
        </View>
        <Label>终端运行在电脑用户权限下。关闭页面仅断开显示。</Label>
        <ScrollView horizontal>
          <View style={s.row}>
            {terminals.map((t) => (
              <Button
                key={t.terminalId}
                title={`${t.terminalId.slice(0, 8)} · ${t.status}`}
                secondary
                onPress={() => setTerminal(t)}
              />
            ))}
          </View>
        </ScrollView>
        {terminal && (
          <Label>
            {terminal.capability} · resize {terminal.resizeSupported ? "支持" : "不支持"} ·{" "}
            {terminal.status} · {terminal.controlAllowed === true ? "可控制" : "仅查看"}
          </Label>
        )}
      </Card>
      {blocked && (
        <Card>
          <Text style={s.text}>部分输入结果未确认。后续输入已暂停，请检查终端输出。</Text>
          <Button
            title="已检查输出，恢复输入"
            onPress={() => {
              inputBlocked.current = false;
              setBlocked(false);
            }}
          />
        </Card>
      )}
      {terminal ? (
        <>
          <WebView
            ref={ref}
            style={{ flex: 1, minHeight: 350, backgroundColor: color.bg }}
            source={{ html }}
            originWhitelist={["about:blank"]}
            javaScriptEnabled
            mixedContentMode="never"
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
            onMessage={(event) => {
              try {
                const message = JSON.parse(event.nativeEvent.data);
                if (message.type === "ready") {
                  setReady(true);
                  for (const out of pendingOutput.current)
                    ref.current?.postMessage(JSON.stringify({ type: "output", ...out }));
                  pendingOutput.current = [];
                } else if (message.type === "input" && typeof message.data === "string")
                  void input(message.data);
                else if (
                  message.type === "resize" &&
                  terminal.resizeSupported &&
                  terminal.controlAllowed === true &&
                  Number.isInteger(message.cols) &&
                  Number.isInteger(message.rows) &&
                  position.current
                )
                  void pico.perform(() =>
                    pico.request("terminal.resize", {
                      sessionId,
                      terminalId: terminal.terminalId,
                      resourceEpoch: position.current!.epoch,
                      cols: message.cols,
                      rows: message.rows,
                    }),
                  );
              } catch (error) {
                pico.report(error);
              }
            }}
          />
          <View style={s.row}>
            {[
              ["Esc", "\x1b"],
              ["Tab", "\t"],
              ["Ctrl-C", "\x03"],
              ["Ctrl-D", "\x04"],
              ["↑", "\x1b[A"],
              ["↓", "\x1b[B"],
              ["←", "\x1b[D"],
              ["→", "\x1b[C"],
            ].map(([name, data]) => (
              <Button
                key={name}
                title={name!}
                secondary
                reason={
                  terminal.controlAllowed !== true
                    ? "其他客户端的终端仅可读"
                    : blocked
                      ? "请先检查输出并恢复输入"
                      : pico.reason("terminal.input")
                }
                onPress={() => void input(data!)}
              />
            ))}
            <Button
              title="键盘"
              secondary
              reason={
                terminal.controlAllowed !== true
                  ? "其他客户端的终端仅可读"
                  : blocked
                    ? "请先检查输出并恢复输入"
                    : pico.reason("terminal.input")
              }
              onPress={() => ref.current?.postMessage(JSON.stringify({ type: "focus" }))}
            />
            <Button
              title="结束进程"
              secondary
              reason={
                terminal.controlAllowed === true
                  ? pico.reason("terminal.stop")
                  : "其他客户端的终端仅可读"
              }
              onPress={() =>
                Alert.alert("结束终端进程？", terminal.terminalId, [
                  { text: "返回" },
                  {
                    text: "结束",
                    style: "destructive",
                    onPress: () =>
                      void pico.perform(async () => {
                        await pico.request("terminal.stop", {
                          sessionId,
                          terminalId: terminal.terminalId,
                          resourceEpoch: position.current?.epoch ?? terminal.resourceEpoch,
                        });
                        await list();
                        setTerminal(undefined);
                      }),
                  },
                ])
              }
            />
          </View>
        </>
      ) : (
        <Text style={s.muted}>选择或创建终端。支持横屏和系统复制粘贴。</Text>
      )}
    </View>
  );
}
