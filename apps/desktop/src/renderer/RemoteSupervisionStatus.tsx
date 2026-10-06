import type { RemoteSupervisionSnapshot } from "../preload/remote-management-contract.js";

const phases: Record<RemoteSupervisionSnapshot["phase"], string> = {
  running: "已运行",
  stopped: "已停止",
  recovering: "正在恢复",
  updating: "正在更新",
  blocked: "需要处理",
};
const registrations: Record<RemoteSupervisionSnapshot["registration"], string> = {
  registered: "已登记",
  missing: "未登记",
  unsupported: "当前构建不支持系统后台恢复",
};
const issues: Record<NonNullable<RemoteSupervisionSnapshot["issueCode"]>, string> = {
  installation_missing:
    "已登记的应用文件不存在。请从应用的新位置打开 Pico 一次，重新登记后台启动位置。",
  registration_missing: "系统后台恢复尚未登记。请关闭并重新开启手机连接。",
  startup_timeout: "后台服务启动超时。请检查应用安装和连接设置后重试。",
};
export function RemoteSupervisionStatus({
  supervision,
  running,
}: {
  readonly supervision?: RemoteSupervisionSnapshot;
  readonly running: boolean;
}) {
  if (!supervision) return null;
  const lastExit = supervision.lastExit;
  const exitReason = !lastExit
    ? "尚无退出记录"
    : lastExit.signal
      ? `信号 ${lastExit.signal}`
      : typeof lastExit.code === "number"
        ? `退出码 ${lastExit.code}`
        : "未记录退出码或信号";
  return (
    <section className="mobile-settings-section" aria-labelledby="mobile-supervision-heading">
      <h3 id="mobile-supervision-heading">后台运行</h3>
      <dl className="mobile-config-summary">
        <div>
          <dt>系统恢复</dt>
          <dd>
            {supervision.backend === "launchd"
              ? "macOS 登录会话"
              : supervision.backend === "task-scheduler"
                ? "Windows 登录会话"
                : "未启用系统恢复"}
          </dd>
        </div>
        <div>
          <dt>系统注册</dt>
          <dd>{registrations[supervision.registration]}</dd>
        </div>
        <div>
          <dt>运行阶段</dt>
          <dd>
            {phases[supervision.phase]} · {running ? "本机连接已确认" : "本机连接未就绪"}
          </dd>
        </div>
        <div>
          <dt>用户设置</dt>
          <dd>{supervision.desiredRunning ? "保持运行" : "已关闭"}</dd>
        </div>
        <div>
          <dt>预期版本</dt>
          <dd>{supervision.registeredBuildId ?? "尚未登记"}</dd>
        </div>
        <div>
          <dt>实际版本</dt>
          <dd>{supervision.runningBuildId ?? (running ? "当前服务未提供版本" : "服务未运行")}</dd>
        </div>
        <div>
          <dt>最近退出</dt>
          <dd>
            {exitReason}
            {lastExit && (
              <>
                {" "}
                · {new Date(lastExit.at).toLocaleString()}
                {lastExit.buildId && <> · 版本 {lastExit.buildId}</>}
              </>
            )}
          </dd>
        </div>
      </dl>
      <p className="mobile-note">
        {supervision.scope === "user-session"
          ? "后台恢复作用于当前用户的登录会话。注销后手机连接停止；允许连接时，下次登录会自动恢复。"
          : "当前构建没有系统后台恢复；退出进程后需要手动重新开启连接。"}
      </p>
      {supervision.issueCode && (
        <p className="mobile-note" role="status">
          {issues[supervision.issueCode]}
        </p>
      )}
    </section>
  );
}
