import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { QrCode, RefreshCw, ShieldCheck } from "lucide-react";
import {
  REMOTE_DEFAULT_PERMISSIONS,
  REMOTE_PERMISSIONS,
  type RemotePermission,
} from "@pico/protocol/remote";
import type { DesktopResult } from "../../preload/contract.js";
import type {
  RemoteManagementSnapshot,
  RemotePairingQr,
  RemotePending,
  RemoteWorkspace,
} from "../../preload/remote-management-contract.js";
import { Button, InlineNotice } from "../components.js";
import { SwitchField, TextField } from "../ui-controls.js";
import { RemoteSupervisionStatus } from "../RemoteSupervisionStatus.js";
import { useRuntime } from "../runtime-context.js";
import "./mobile-connection-settings.css";

const permissionNames: Record<RemotePermission, string> = {
  "workspace.read": "读取项目与任务",
  "session.control": "发送消息、审批和控制任务",
  "workspace.write": "应用或回退文件修改",
  "terminal.control": "操作终端（电脑用户的 Shell 权限）",
  "host.admin": "管理电脑配置（模型、插件与自动化）",
};
const relayNames = {
  disabled: "已关闭",
  connecting: "正在连接",
  online: "已连接",
  reconnecting: "网络断开，正在重连",
  unauthorized: "电脑未绑定服务",
  error: "连接错误",
};
function checked<T>(items: readonly T[], value: T, enabled: boolean): T[] {
  return enabled ? [...new Set([...items, value])] : items.filter((entry) => entry !== value);
}
function unwrap<T>(result: DesktopResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

export function MobileConnectionSettingsPage() {
  const { data, actions } = useRuntime();
  const api = window.pico?.remoteManagement;
  const [snapshot, setSnapshot] = useState<RemoteManagementSnapshot>();
  const [relayUrl, setRelayUrl] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [qr, setQr] = useState<RemotePairingQr>();
  const [busy, setBusy] = useState(false);
  const [editingConfiguration, setEditingConfiguration] = useState(false);
  const configHeading = useRef<HTMLHeadingElement>(null);
  const [error, setError] = useState("");
  const initialized = useRef(false);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    if (!api) return;
    const next = unwrap(await api.snapshot({}));
    if (!alive.current) return;
    setSnapshot(next);
    if (!initialized.current) {
      initialized.current = true;
      setRelayUrl(next.configuration.relayUrl ?? "");
      setSelectedPaths(next.configuration.workspaces.map((workspace) => workspace.path));
    }
  }, [api]);
  useEffect(() => {
    alive.current = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        await refresh();
      } catch (failure) {
        if (alive.current)
          setError(failure instanceof Error ? failure.message : "无法读取手机连接状态");
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
      await refresh();
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "操作失败，请重试");
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const active = Boolean(snapshot?.running || snapshot?.enabled);
  const config = snapshot?.configuration;
  const availableWorkspaces = data.workspaces.filter(
    (workspace) => workspace.registered && workspace.trusted && !workspace.temporary,
  );
  const expired = !qr || qr.expiresAt <= Date.now();
  const showConfigForm = Boolean(snapshot && (!config?.configured || editingConfiguration));
  const canPair = Boolean(
    snapshot?.running && (config?.connectionMode !== "relay" || snapshot.relayState === "online"),
  );
  const openConfiguration = () => {
    setEditingConfiguration(true);
    configHeading.current?.scrollIntoView({ block: "center", behavior: "instant" });
    configHeading.current?.focus({ preventScroll: true });
  };
  const stateLabel = !snapshot
    ? "正在读取状态…"
    : !snapshot.running
      ? "未运行"
      : snapshot.relayState
        ? relayNames[snapshot.relayState]
        : "直连网关运行中";
  return (
    <div className="page-stack settings-page mobile-connection-settings">
      <section className="page-intro">
        <div>
          <h2>手机连接</h2>
          <p>从手机继续这台电脑上的任务。</p>
        </div>
      </section>
      {!api && <InlineNotice tone="warning">手机连接管理需要在 Pico 桌面应用中打开。</InlineNotice>}
      {error && (
        <div role="alert">
          <InlineNotice tone="warning">{error}</InlineNotice>
        </div>
      )}
      {snapshot?.issue && <InlineNotice tone="warning">{snapshot.issue}</InlineNotice>}
      <section
        className="mobile-settings-section mobile-status-section"
        aria-labelledby="mobile-status-heading"
      >
        <div className="mobile-section-heading">
          <div>
            <h3 id="mobile-status-heading">连接状态</h3>
            <div className="mobile-connection-status" role="status">
              <span
                className={`mobile-status-dot ${canPair ? "is-online" : ""}`}
                aria-hidden="true"
              />
              <strong>{stateLabel}</strong>
              <span>
                {config?.connectionMode === "direct"
                  ? "直连"
                  : config?.configured
                    ? "通过中继连接"
                    : "尚未配置"}
              </span>
            </div>
          </div>
          <div className="mobile-actions">
            <Button variant="quiet" disabled={busy || !api} onClick={() => void run(refresh)}>
              <RefreshCw size={15} aria-hidden="true" />
              刷新
            </Button>
            <SwitchField
              label="允许手机连接"
              labelHidden={false}
              checked={active}
              disabled={busy || !api || !snapshot || (!active && !config?.configured)}
              onCheckedChange={() =>
                void run(async () => {
                  if (!api) return;
                  setSnapshot(unwrap(await (active ? api.stop({}) : api.start({}))));
                  if (active) setQr(undefined);
                })
              }
            />
          </div>
        </div>
        <p className="mobile-note">保持电脑开机联网，手机才能连接。关闭连接不会停止任务。</p>
        <details className="mobile-connection-help">
          <summary>连接说明</summary>
          <div>
            <p>
              关闭窗口或退出 Pico
              后，已开启的手机连接和本机任务继续运行；电脑休眠、关机或断网时无法连接。
            </p>
            <p>手机使用电脑操作功能时，需要保持 Pico 窗口可见。</p>
            <p>
              如果提示电脑未绑定服务，请先在中继服务器完成这台电脑的部署绑定，再关闭并重新开启连接。
            </p>
            {snapshot?.runtimeLastReachableAt && (
              <p>本机服务最近可达：{new Date(snapshot.runtimeLastReachableAt).toLocaleString()}</p>
            )}
          </div>
        </details>
      </section>
      <RemoteSupervisionStatus
        supervision={snapshot?.supervision}
        running={snapshot?.running ?? false}
      />
      <section className="mobile-settings-section" aria-labelledby="mobile-pair-heading">
        <div className="mobile-section-heading">
          <h3 id="mobile-pair-heading">配对手机</h3>
          <Button
            variant={qr && !expired ? "secondary" : "primary"}
            disabled={busy || !api || !canPair}
            onClick={() =>
              void run(async () => {
                if (api) setQr(unwrap(await api.offer({})));
              })
            }
          >
            <QrCode size={16} />
            {qr && !expired ? "刷新二维码" : "连接手机"}
          </Button>
        </div>
        {qr && !expired ? (
          <div className="mobile-pairing-qr">
            <img src={qr.qrDataUrl} alt="手机配对二维码" width={256} height={256} />
            <div>
              <strong>在 Pico 手机端扫描</strong>
              <p>
                有效至 {new Date(qr.expiresAt).toLocaleTimeString()}
                。扫码后请在下方核对设备和授权范围。
              </p>
              <small>配对编号：{qr.pairingId}</small>
            </div>
          </div>
        ) : (
          <p className="mobile-note">
            {qr
              ? "二维码已过期，请重新生成。"
              : !config?.configured
                ? "先设置连接地址和授权项目，再开启手机连接。"
                : snapshot?.relayState === "unauthorized"
                  ? "这台电脑尚未完成服务绑定，请按连接说明完成部署后重试。"
                  : !canPair
                    ? "开启连接并等待服务就绪后，即可用手机扫码配对。"
                    : "用 Pico 手机端扫码，再在这台电脑确认授权。二维码 5 分钟内有效。"}
          </p>
        )}
        {!config?.configured && snapshot && (
          <Button variant="quiet" onClick={openConfiguration}>
            设置连接
          </Button>
        )}
        {snapshot?.pending.map((pending) => (
          <PendingDevice
            key={pending.pairingId}
            pending={pending}
            workspaces={config?.workspaces ?? []}
            busy={busy}
            onApprove={(permissions, workspaceIds) =>
              void run(async () => {
                if (api) {
                  setSnapshot(
                    unwrap(
                      await api.approve({
                        pairingId: pending.pairingId,
                        permissions,
                        workspaceIds,
                      }),
                    ),
                  );
                  setQr(undefined);
                }
              })
            }
            onReject={() =>
              void run(async () => {
                if (api) setSnapshot(unwrap(await api.reject({ pairingId: pending.pairingId })));
              })
            }
          />
        ))}
      </section>
      <section className="mobile-settings-section" aria-labelledby="mobile-devices-heading">
        <h3 id="mobile-devices-heading">已授权设备</h3>
        {!snapshot?.running && <p className="mobile-note">开启手机连接后可管理设备授权。</p>}
        {snapshot?.running &&
          snapshot.devices.filter((device) => !device.revokedAt).length === 0 && (
            <p className="mobile-note">还没有已授权的手机，配对后会显示在这里。</p>
          )}
        {snapshot?.devices
          .filter((device) => !device.revokedAt)
          .map((device) => (
            <article className="mobile-device" key={device.id}>
              <ShieldCheck size={20} aria-hidden="true" />
              <div>
                <strong>{device.name}</strong>
                <p>
                  {device.permissions
                    .map((permission) => permissionNames[permission] ?? permission)
                    .join(" · ")}
                </p>
                <small>
                  项目：
                  {device.workspaceIds
                    .map(
                      (id) =>
                        config?.workspaces.find((workspace) => workspace.id === id)?.name ?? id,
                    )
                    .join("、")}
                </small>
              </div>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (api) setSnapshot(unwrap(await api.revoke({ deviceId: device.id })));
                  })
                }
              >
                撤销授权
              </Button>
            </article>
          ))}
      </section>
      <section className="mobile-settings-section" aria-labelledby="mobile-config-heading">
        <div className="mobile-section-heading">
          <h3 id="mobile-config-heading" ref={configHeading} tabIndex={-1}>
            连接设置
          </h3>
          {config?.configured && (
            <Button
              variant="quiet"
              disabled={busy}
              aria-expanded={showConfigForm}
              aria-controls="mobile-config-content"
              onClick={() => setEditingConfiguration(!editingConfiguration)}
            >
              {showConfigForm ? "收起" : "编辑"}
            </Button>
          )}
        </div>
        <div id="mobile-config-content">
          {!snapshot ? (
            <p className="mobile-note">正在读取设置…</p>
          ) : !showConfigForm ? (
            <dl className="mobile-config-summary">
              <div>
                <dt>连接方式</dt>
                <dd>{config?.connectionMode === "direct" ? "HTTPS/WSS 直连" : "中继连接"}</dd>
              </div>
              {config?.relayUrl && (
                <div>
                  <dt>服务地址</dt>
                  <dd>{config.relayUrl}</dd>
                </div>
              )}
              <div>
                <dt>授权项目</dt>
                <dd>
                  {config?.workspaces.map((workspace) => workspace.name).join("、") || "尚未选择"}
                </dd>
              </div>
            </dl>
          ) : (
            <>
              {active && (
                <p className="mobile-note">先关闭上方连接开关，再编辑设置。现有任务会继续运行。</p>
              )}
              {config?.connectionMode === "direct" && (
                <InlineNotice tone="warning">
                  当前使用已有直连配置。保存下方设置将明确切换到公网 Relay；请先停止手机连接。
                </InlineNotice>
              )}
              <form
                className="mobile-config-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!api || active) return;
                  if (
                    config?.connectionMode === "direct" &&
                    !window.confirm(
                      "将此电脑的手机连接从 HTTPS/WSS 直连切换到公网 Relay？现有设备仍需遵守本机授权。",
                    )
                  )
                    return;
                  void run(async () => {
                    setSnapshot(
                      unwrap(
                        await api.configure({
                          relayUrl: relayUrl.trim(),
                          workspaces: selectedPaths.map((path) => ({ path })),
                        }),
                      ),
                    );
                    setQr(undefined);
                    setEditingConfiguration(false);
                    configHeading.current?.focus({ preventScroll: true });
                  });
                }}
              >
                <div className="mobile-field">
                  <span>Relay 服务地址</span>
                  <TextField
                    label="Relay 服务地址"
                    type="url"
                    placeholder="https://relay.example.com"
                    value={relayUrl}
                    required
                    disabled={busy || active || !api}
                    onValueChange={setRelayUrl}
                    autoComplete="off"
                  />
                </div>
                <p className="mobile-note">
                  填写部署时绑定这台电脑的中继地址。保存后，开启上方连接开关。
                </p>
                <fieldset className="mobile-workspace-picker" disabled={busy || active || !api}>
                  <legend>允许手机访问的项目</legend>
                  {availableWorkspaces.length === 0 && (
                    <p>
                      还没有已注册且信任的项目。<Link to="/settings/workspaces">管理项目</Link>
                    </p>
                  )}
                  {availableWorkspaces.map((workspace) => (
                    <label key={workspace.path}>
                      <input
                        type="checkbox"
                        checked={selectedPaths.includes(workspace.path)}
                        onChange={(event) =>
                          setSelectedPaths(
                            checked(selectedPaths, workspace.path, event.target.checked),
                          )
                        }
                      />
                      <span>
                        <strong>{workspace.name ?? workspace.path.split(/[\\/]/u).pop()}</strong>
                        <small>{workspace.path}</small>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <div className="mobile-actions">
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={
                      busy || active || !api || !relayUrl.trim() || selectedPaths.length === 0
                    }
                  >
                    保存连接设置
                  </Button>
                  <Button
                    disabled={busy || active}
                    onClick={() => void actions.registerWorkspace()}
                  >
                    添加本机项目
                  </Button>
                </div>
              </form>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
function PendingDevice({
  pending,
  workspaces,
  busy,
  onApprove,
  onReject,
}: {
  readonly pending: RemotePending;
  readonly workspaces: readonly RemoteWorkspace[];
  readonly busy: boolean;
  readonly onApprove: (permissions: RemotePermission[], workspaces: string[]) => void;
  readonly onReject: () => void;
}) {
  const [permissions, setPermissions] = useState<RemotePermission[]>([
    ...REMOTE_DEFAULT_PERMISSIONS,
  ]);
  const [workspaceIds, setWorkspaceIds] = useState<string[]>(
    workspaces.map((workspace) => workspace.id),
  );
  return (
    <article className="mobile-pending-device">
      <h4>批准设备：{pending.deviceName}</h4>
      <small>配对编号：{pending.pairingId}</small>
      <p>确认这是你的手机，并选择允许访问的项目和能力。</p>
      <fieldset disabled={busy}>
        <legend>设备权限</legend>
        {REMOTE_PERMISSIONS.map((permission) => (
          <label key={permission}>
            <input
              type="checkbox"
              checked={permissions.includes(permission)}
              onChange={(event) =>
                setPermissions(checked(permissions, permission, event.target.checked))
              }
            />
            {permissionNames[permission]}
          </label>
        ))}
      </fieldset>
      <fieldset disabled={busy}>
        <legend>项目范围</legend>
        {workspaces.map((workspace) => (
          <label key={workspace.id}>
            <input
              type="checkbox"
              checked={workspaceIds.includes(workspace.id)}
              onChange={(event) =>
                setWorkspaceIds(checked(workspaceIds, workspace.id, event.target.checked))
              }
            />
            {workspace.name}
          </label>
        ))}
      </fieldset>
      {(permissions.includes("terminal.control") || permissions.includes("host.admin")) && (
        <InlineNotice tone="warning">
          所选权限允许手机操作本机终端或修改电脑配置，请仅授予可信设备。
        </InlineNotice>
      )}
      <div className="mobile-actions">
        <Button
          variant="primary"
          disabled={
            busy || !permissions.length || !workspaceIds.length || pending.expiresAt <= Date.now()
          }
          onClick={() => onApprove(permissions, workspaceIds)}
        >
          确认设备并批准
        </Button>
        <Button disabled={busy} onClick={onReject}>
          拒绝
        </Button>
      </div>
    </article>
  );
}
