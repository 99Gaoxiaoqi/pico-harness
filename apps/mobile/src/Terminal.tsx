import React, { useEffect, useRef, useState } from "react";
import { Alert, AppState, ScrollView, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import { randomUUID } from "expo-crypto";
import {
  TERMINAL_STREAM_RUNTIME_CAPABILITY,
  type RuntimeTerminalFrame,
  type RuntimeTerminalSession,
} from "@pico/protocol/mobile";
import { usePico } from "./store";
import { Button, Card, Label, s, color } from "./ui";
import { terminalTheme } from "./palette";
import { TerminalOutputQueue } from "./terminal-output";
import { terminalInputChunks } from "./terminal-input";
import html from "./terminal.generated";

export function TerminalPanel({ sessionId }: { sessionId: string }) {
  const pico = usePico();
  const [terminals, setTerminals] = useState<readonly RuntimeTerminalSession[]>([]);
  const [terminal, setTerminal] = useState<RuntimeTerminalSession>();
  const [ready, setReady] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const ref = useRef<WebView>(null);
  const position = useRef<{ epoch: string; sequence: number } | undefined>(undefined);
  const active = useRef(true);
  const outputQueue = useRef(
    new TerminalOutputQueue((message) => ref.current?.postMessage(JSON.stringify(message))),
  );
  const recoverOutput = useRef<(() => void) | undefined>(undefined);
  const control = useRef<RuntimeTerminalSession | undefined>(undefined);
  const inputQueue = useRef(Promise.resolve());
  const inputBudget = useRef({ bytes: 0, count: 0 });
  const inputCapacityPaused = useRef(false);
  const [capacityPaused, setCapacityPaused] = useState(false);
  const [pendingControls, setPendingControls] = useState(0);
  const inputGeneration = useRef(0);
  const displayGeneration = useRef(0);
  const inputBlocked = useRef(false);
  const desiredSize = useRef<{ cols: number; rows: number } | undefined>(undefined);
  const lastResize = useRef<string | undefined>(undefined);
  const [blocked, setBlocked] = useState(false);
  const listVersion = useRef(0);
  const readScope = `${pico.generation}:${pico.connected}:${pico.syncRevision}:${sessionId}`;
  const currentScope = useRef(readScope);
  currentScope.current = readScope;
  const identity = `${pico.generation}:${sessionId}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const live = useRef({ foreground, connected: pico.connected, identity });
  live.current = { foreground, connected: pico.connected, identity };
  async function list() {
    if (pico.connected === false) return;
    const version = ++listVersion.current;
    const result = await pico.request("terminal.list", { sessionId });
    if (active.current && version === listVersion.current && readScope === currentScope.current) {
      setTerminals(result.terminals);
      setTerminal(
        (current) =>
          current && result.terminals.find((item) => item.terminalId === current.terminalId),
      );
    }
  }
  function output(data: string, reset = false) {
    if (!outputQueue.current.push(data, reset)) {
      position.current = undefined;
      pico.report(new Error("终端输出过快，正在重新获取可用尾部"));
      recoverOutput.current?.();
    }
  }
  async function ensureTerminalStream() {
    const ping = await pico.request("runtime.ping", {});
    if (!ping.capabilities.includes(TERMINAL_STREAM_RUNTIME_CAPABILITY)) {
      throw new Error("电脑端尚不支持终端实时推送，请更新电脑端并重新连接");
    }
  }
  useEffect(() => {
    active.current = true;
    setTerminal(undefined);
    setTerminals([]);
    setReady(false);
    outputQueue.current.ready(false);
    outputQueue.current.clear();
    position.current = undefined;
    const app = AppState.addEventListener("change", (state) => {
      live.current.foreground = state === "active";
      setForeground(state === "active");
    });
    return () => {
      active.current = false;
      inputGeneration.current++;
      app.remove();
    };
  }, [sessionId, pico.generation]);
  useEffect(() => {
    if (pico.connected !== false) void pico.perform(list);
    return () => {
      ++listVersion.current;
    };
  }, [sessionId, pico.generation, pico.connected, pico.syncRevision]);
  useEffect(() => {
    control.current = terminal;
  }, [terminal]);
  useEffect(() => {
    inputGeneration.current++;
    inputBlocked.current = false;
    inputCapacityPaused.current = false;
    setCapacityPaused(false);
    setPendingControls(0);
    lastResize.current = undefined;
    setBlocked(false);
    position.current = undefined;
    output("", true);
    if (!terminal) {
      setReady(false);
      outputQueue.current.ready(false);
      outputQueue.current.clear();
    }
  }, [terminal?.terminalId]);
  useEffect(() => {
    if (!terminal || !foreground || !pico.connected || !pico.client) return;
    const streamId = randomUUID();
    let current = true;
    let attaching = false;
    let requested = false;
    let events: RuntimeTerminalFrame[] = [];
    let eventCharacters = 0;
    let streamAvailable = false;
    let attachedTerminal = terminal;
    let confirmedEpoch = position.current?.epoch;
    const oldEpochs = new Set<string>();
    const valid = () =>
      current &&
      active.current &&
      readScope === currentScope.current &&
      live.current.foreground &&
      live.current.connected;
    const updateTerminal = (value: RuntimeTerminalSession) => {
      attachedTerminal = value;
      control.current = value;
      setTerminal(value);
      setTerminals((items) =>
        items.map((item) => (item.terminalId === value.terminalId ? value : item)),
      );
    };
    function apply(event: RuntimeTerminalFrame) {
      position.current = { epoch: event.resourceEpoch, sequence: event.sequence };
      if (event.kind === "output") output(event.data);
      else if (control.current) {
        updateTerminal({
          ...control.current,
          sequence: event.sequence,
          status: event.status === "stopped" ? "exited" : event.status,
          ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        });
      }
    }
    function consume() {
      const cursor = position.current;
      if (!cursor) return;
      if (
        events.some(
          (event) => event.resourceEpoch !== cursor.epoch && !oldEpochs.has(event.resourceEpoch),
        )
      ) {
        position.current = undefined;
        inputGeneration.current++;
        requested = true;
        return;
      }
      events = events
        .filter((event) => event.resourceEpoch === cursor.epoch && event.sequence > cursor.sequence)
        .sort((a, b) => a.sequence - b.sequence);
      eventCharacters = events.reduce(
        (size, event) => size + (event.kind === "output" ? event.data.length : 0),
        0,
      );
      while (events.length && valid()) {
        const event = events[0]!;
        if (event.sequence <= position.current!.sequence) {
          events.shift();
          continue;
        }
        if (event.sequence !== position.current!.sequence + 1) {
          requested = true;
          break;
        }
        events.shift();
        eventCharacters -= event.kind === "output" ? event.data.length : 0;
        apply(event);
        if (!position.current) break;
      }
    }
    async function attach() {
      requested = true;
      if (attaching || !valid()) return;
      attaching = true;
      try {
        if (!streamAvailable) {
          await ensureTerminalStream();
          if (!valid()) return;
          streamAvailable = true;
        }
        let attempts = 0;
        while (requested && valid() && ++attempts <= 3) {
          requested = false;
          const cursor = position.current;
          const display = displayGeneration.current;
          const bufferedAtStart = new Set(events);
          const result = await pico.request("terminal.attach", {
            sessionId,
            terminalId: terminal!.terminalId,
            streamId,
            ...(cursor ? { afterSequence: cursor.sequence } : {}),
            maxBytes: 32 * 1024,
          });
          if (!valid()) return;
          if (display !== displayGeneration.current) {
            position.current = undefined;
            requested = true;
            continue;
          }
          if (cursor && cursor.epoch !== result.resourceEpoch) {
            oldEpochs.add(cursor.epoch);
            position.current = undefined;
            inputGeneration.current++;
            requested = true;
            continue;
          }
          if (confirmedEpoch && confirmedEpoch !== result.resourceEpoch)
            oldEpochs.add(confirmedEpoch);
          confirmedEpoch = result.resourceEpoch;
          events = events.filter((event) => {
            if (event.resourceEpoch !== result.resourceEpoch && bufferedAtStart.has(event)) {
              oldEpochs.add(event.resourceEpoch);
              return false;
            }
            return true;
          });
          const reset = !cursor || cursor.epoch !== result.resourceEpoch || result.truncated;
          position.current = { epoch: result.resourceEpoch, sequence: result.sequence };
          updateTerminal(result.terminal);
          sendReadonly();
          if (desiredSize.current) resize(desiredSize.current.cols, desiredSize.current.rows);
          output(result.snapshot, reset);
          if (result.truncated) pico.report(new Error("终端输出缓冲区已截断，当前显示可用尾部"));
          consume();
        }
        if (requested && valid()) {
          requested = false;
          pico.report(new Error("终端输出序号缺口尚未补齐，请刷新终端"));
        }
      } catch (error) {
        if (valid()) pico.report(error);
      } finally {
        attaching = false;
      }
    }
    const subscription = pico.client.subscribeTerminalFrames((event) => {
      if (
        !valid() ||
        event.streamId !== streamId ||
        event.sessionId !== sessionId ||
        event.terminalId !== terminal.terminalId ||
        oldEpochs.has(event.resourceEpoch)
      )
        return;
      const cursor = position.current;
      if (cursor && cursor.epoch === event.resourceEpoch && event.sequence <= cursor.sequence)
        return;
      events.push(event);
      eventCharacters += event.kind === "output" ? event.data.length : 0;
      if (events.length > 256 || eventCharacters > 128 * 1024) {
        events = [];
        eventCharacters = 0;
        position.current = undefined;
        pico.report(new Error("终端输出过快，正在重新获取可用尾部"));
        void attach();
      } else if (!attaching) {
        if (!cursor || cursor.epoch !== event.resourceEpoch) {
          position.current = undefined;
          inputGeneration.current++;
          void attach();
        } else {
          consume();
          if (requested) void attach();
        }
      }
    });
    recoverOutput.current = () => void attach();
    void attach();
    return () => {
      current = false;
      subscription.dispose();
      recoverOutput.current = undefined;
      inputGeneration.current++;
      const t = attachedTerminal;
      if (t)
        void pico
          .request("terminal.detach", {
            sessionId,
            terminalId: t.terminalId,
            resourceEpoch: t.resourceEpoch,
            streamId,
          })
          .catch(() => undefined);
    };
  }, [
    terminal?.terminalId,
    foreground,
    pico.connected,
    pico.syncRevision,
    pico.generation,
    pico.client,
  ]);
  useEffect(() => {
    if (!foreground || !pico.connected) inputGeneration.current++;
  }, [foreground, pico.connected]);
  useEffect(() => {
    if (ready) sendReadonly();
  }, [
    ready,
    terminal?.status,
    terminal?.controlAllowed,
    blocked,
    capacityPaused,
    foreground,
    pico.connected,
  ]);
  function sendReadonly() {
    ref.current?.postMessage(
      JSON.stringify({
        type: "readonly",
        value:
          control.current?.status !== "running" ||
          control.current.controlAllowed !== true ||
          inputBlocked.current ||
          inputCapacityPaused.current ||
          !live.current.foreground ||
          !live.current.connected ||
          !position.current,
      }),
    );
  }
  async function create() {
    await ensureTerminalStream();
    if (!active.current || identity !== currentIdentity.current) return;
    const streamId = randomUUID();
    const x = await pico.request("terminal.create", { sessionId, cols: 80, rows: 24, streamId });
    try {
      if (!active.current || identity !== currentIdentity.current) return;
      setTerminal(x.terminal);
      await list();
    } finally {
      if (identity === currentIdentity.current)
        await pico
          .request("terminal.detach", {
            sessionId,
            terminalId: x.terminal.terminalId,
            resourceEpoch: x.resourceEpoch,
            streamId,
          })
          .catch(() => undefined);
    }
  }
  function input(data: string) {
    const t = control.current;
    const cursor = position.current;
    if (
      !t ||
      t.status !== "running" ||
      !cursor ||
      !live.current.foreground ||
      !live.current.connected ||
      inputBlocked.current ||
      inputCapacityPaused.current
    )
      return;
    if (t.controlAllowed !== true) {
      pico.report(new Error("此终端由其他客户端创建，手机仅可查看"));
      return;
    }
    const generation = inputGeneration.current;
    // Keep keystrokes in order; a lost response discards queued input, never resends it.
    for (const chunk of terminalInputChunks(data)) {
      if (
        !enqueueControl(async () => {
          if (!canControl(t, cursor.epoch, generation)) return;
          try {
            await pico.request("terminal.input", {
              sessionId,
              terminalId: t.terminalId,
              resourceEpoch: cursor.epoch,
              data: chunk.data,
            });
          } catch (error) {
            if (
              !active.current ||
              identity !== currentIdentity.current ||
              t.terminalId !== control.current?.terminalId ||
              control.current.status !== "running"
            )
              return;
            inputGeneration.current++;
            inputBlocked.current = true;
            setBlocked(true);
            pico.report(
              new Error(
                `终端输入结果未确认，不会自动重发。请检查输出后恢复输入。${error instanceof Error ? error.message : ""}`,
              ),
            );
          }
        }, chunk.bytes)
      )
        break;
    }
  }
  function enqueueControl(task: () => Promise<void>, bytes = 0) {
    if (inputCapacityPaused.current) return false;
    const budget = inputBudget.current;
    if (budget.count >= 128 || budget.bytes + bytes > 256 * 1024) {
      inputCapacityPaused.current = true;
      setCapacityPaused(true);
      setPendingControls(budget.count);
      pico.report(
        new Error(
          "终端输入队列已满，后续输入已暂停。请等待已接纳的输入完成，检查输出后恢复输入；超过上限的内容不会自动重发。",
        ),
      );
      return false;
    }
    budget.count++;
    budget.bytes += bytes;
    inputQueue.current = inputQueue.current.then(async () => {
      try {
        await task();
      } finally {
        budget.count--;
        budget.bytes -= bytes;
        if (active.current && inputCapacityPaused.current) setPendingControls(budget.count);
      }
    });
    return true;
  }
  function canControl(t: RuntimeTerminalSession, epoch: string, generation: number) {
    return (
      active.current &&
      generation === inputGeneration.current &&
      identity === live.current.identity &&
      live.current.foreground &&
      live.current.connected &&
      !inputBlocked.current &&
      control.current?.terminalId === t.terminalId &&
      control.current.controlAllowed === true &&
      control.current.status === "running" &&
      position.current?.epoch === epoch &&
      control.current.resourceEpoch === epoch
    );
  }
  function resize(cols: number, rows: number) {
    desiredSize.current = { cols, rows };
    const t = control.current;
    const cursor = position.current;
    const generation = inputGeneration.current;
    if (
      !t ||
      !cursor ||
      !t.resizeSupported ||
      t.status !== "running" ||
      !canControl(t, cursor.epoch, generation)
    )
      return;
    const dimensions = `${t.terminalId}:${cursor.epoch}:${cols}:${rows}`;
    enqueueControl(async () => {
      if (!canControl(t, cursor.epoch, generation) || lastResize.current === dimensions) return;
      lastResize.current = dimensions;
      try {
        await pico.request("terminal.resize", {
          sessionId,
          terminalId: t.terminalId,
          resourceEpoch: cursor.epoch,
          cols,
          rows,
        });
      } catch (error) {
        if (lastResize.current === dimensions) lastResize.current = undefined;
        if (canControl(t, cursor.epoch, generation)) pico.report(error);
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
          <Button
            title="刷新"
            secondary
            onPress={() =>
              void pico.perform(async () => {
                await list();
                recoverOutput.current?.();
              })
            }
          />
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
      {(blocked || capacityPaused) && (
        <Card>
          <Text style={s.text}>
            {blocked
              ? "部分输入结果未确认。后续输入已暂停，请检查终端输出。"
              : "终端输入队列已满，后续输入已暂停。已接纳的输入仍会完成；超过上限的内容未发送，请检查输出。"}
          </Text>
          <Button
            title="已检查输出，恢复输入"
            reason={pendingControls > 0 ? "等待已接纳的输入完成" : undefined}
            onPress={() => {
              if (inputBudget.current.count > 0) return;
              inputGeneration.current++;
              inputBlocked.current = false;
              inputCapacityPaused.current = false;
              setBlocked(false);
              setCapacityPaused(false);
              if (desiredSize.current) resize(desiredSize.current.cols, desiredSize.current.rows);
            }}
          />
        </Card>
      )}
      {terminal ? (
        <>
          <WebView
            ref={ref}
            style={{ flex: 1, minHeight: 350, backgroundColor: color.bg }}
            containerStyle={{ backgroundColor: color.bg }}
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
                  displayGeneration.current++;
                  inputGeneration.current++;
                  position.current = undefined;
                  outputQueue.current.restart();
                  setReady(true);
                  ref.current?.postMessage(JSON.stringify({ type: "theme", theme: terminalTheme }));
                  sendReadonly();
                  recoverOutput.current?.();
                } else if (message.type === "written" && Number.isInteger(message.id)) {
                  outputQueue.current.written(message.id);
                } else if (message.type === "overflow") {
                  position.current = undefined;
                  pico.report(new Error("终端输出过快，正在重新获取可用尾部"));
                  recoverOutput.current?.();
                } else if (message.type === "input" && typeof message.data === "string")
                  void input(message.data);
                else if (
                  message.type === "resize" &&
                  Number.isInteger(message.cols) &&
                  Number.isInteger(message.rows) &&
                  message.cols > 0 &&
                  message.rows > 0
                )
                  resize(message.cols, message.rows);
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
                  terminal.status !== "running"
                    ? "终端进程未在运行"
                    : terminal.controlAllowed !== true
                      ? "其他客户端的终端仅可读"
                      : blocked || capacityPaused
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
                terminal.status !== "running"
                  ? "终端进程未在运行"
                  : terminal.controlAllowed !== true
                    ? "其他客户端的终端仅可读"
                    : blocked || capacityPaused
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
