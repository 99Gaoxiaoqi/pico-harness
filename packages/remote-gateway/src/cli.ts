import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { stdin, stdout } from "node:process";
import qrcode from "qrcode-terminal";
import {
  REMOTE_DEFAULT_PERMISSIONS,
  REMOTE_PERMISSIONS,
  type RemotePermission,
  type RemotePairingOffer,
} from "@pico/protocol/remote";
import {
  configureRemoteGateway,
  requestGatewayControl,
  startConfiguredRemoteGateway,
} from "./server.js";
import { defaultGatewayHome, ensureGatewayHome } from "./state.js";

export interface RemoteCliOptions {
  readonly output?: (text: string) => void;
  readonly ask?: (question: string) => Promise<string>;
}
const HELP = `Pico 公网直连网关（无中转）
  pico remote configure --url https://pico.example.com:8443 --cert /path/fullchain.pem --key /path/privkey.pem --workspace /registered/project [--workspace /another] [--listen 0.0.0.0 --listen ::] [--port 8443] [--runtime-home /path/.pico]
  pico remote start
  pico remote status | doctor
  pico remote pair [--permissions workspace.read,session.control] [--workspaces id1,id2]
  pico remote devices list
  pico remote devices grant <device-id> --permissions <comma-list> --workspaces <comma-list>
  pico remote devices revoke <device-id>
所有命令可加 --home /path/.pico-remote。configure 仅接受电脑已注册工作区。
终端权限是当前电脑用户的 Shell 能力；host.admin 允许修改电脑配置。默认均关闭。
域名、可信证书、防火墙与公网入口由用户配置；doctor 不能证明外网可达。`;
export async function runRemoteCli(
  argv: readonly string[],
  options: RemoteCliOptions = {},
): Promise<number> {
  const output = options.output ?? ((text: string) => console.log(text));
  const args = [...argv];
  const flags = new Map<string, string[]>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (arg === "--help") {
      output(HELP);
      return 0;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) {
      output(`缺少 ${arg} 的值`);
      return 1;
    }
    if (
      ![
        "--home",
        "--url",
        "--cert",
        "--key",
        "--port",
        "--listen",
        "--workspace",
        "--runtime-home",
        "--permissions",
        "--workspaces",
      ].includes(arg)
    ) {
      output(`未知选项 ${arg}`);
      return 1;
    }
    flags.set(arg, [...(flags.get(arg) ?? []), value]);
  }
  const one = (flag: string): string | undefined => {
    const values = flags.get(flag);
    if (values && values.length > 1) throw new Error(`${flag} 不可重复`);
    return values?.[0];
  };
  let readline: ReturnType<typeof createInterface> | undefined;
  const ask =
    options.ask ??
    (async (question: string) => {
      if (!stdin.isTTY) throw new Error("配对批准需要交互终端，请在电脑运行命令");
      readline ??= createInterface({ input: stdin, output: stdout });
      return readline.question(question);
    });
  try {
    const home = await ensureGatewayHome(one("--home") ?? defaultGatewayHome());
    const command = positional[0];
    if (!command || command === "help") {
      output(HELP);
      return 0;
    }
    if (command === "configure") {
      const publicUrl = one("--url");
      const certificatePath = one("--cert");
      const privateKeyPath = one("--key");
      const workspacePaths = flags.get("--workspace") ?? [];
      if (!publicUrl || !certificatePath || !privateKeyPath || !workspacePaths.length)
        throw new Error("configure 需要 --url、--cert、--key 和至少一个 --workspace");
      const port = Number(one("--port") ?? (new URL(publicUrl).port || 8443));
      await configureRemoteGateway(
        {
          version: 1,
          publicUrl,
          port,
          certificatePath: resolve(certificatePath),
          privateKeyPath: resolve(privateKeyPath),
          listenHosts: flags.get("--listen") ?? ["0.0.0.0", "::"],
          workspaces: [...new Set(workspacePaths.map((path) => resolve(path)))].map((path) => ({
            id: randomUUID(),
            name: basename(path),
            path,
          })),
          ...(one("--runtime-home")
            ? { runtimeHostRootPath: resolve(one("--runtime-home")!) }
            : {}),
        },
        home,
      );
      output("远程网关配置已保存。请运行 pico remote start，再用手机蜂窝网络验证公网可达性。");
      return 0;
    }
    if (command === "start") {
      const gateway = await startConfiguredRemoteGateway({
        home,
        audit: (entry) => output(JSON.stringify(entry)),
      });
      output("Pico HTTPS/WSS 网关已启动；关闭网关不停止电脑任务。");
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          void gateway.close().then(resolve, (error: unknown) => {
            output(error instanceof Error ? error.message : "网关关闭失败");
            resolve();
          });
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }
    if (command === "status" || command === "doctor") {
      output(JSON.stringify(await requestGatewayControl(home, command), null, 2));
      return 0;
    }
    if (command === "pair") {
      const offer = (await requestGatewayControl(home, "pair.offer")) as RemotePairingOffer & {
        pairingId: string;
      };
      const { pairingId, ...qr } = offer;
      output(`请在手机扫描二维码（5 分钟有效）。配对编号：${pairingId}`);
      qrcode.generate(JSON.stringify(qr), { small: true }, output);
      let pending: { pairingId: string; deviceName: string } | undefined;
      while (Date.now() < offer.expiresAt) {
        const requests = (await requestGatewayControl(home, "pair.pending")) as {
          pairingId: string;
          deviceName: string;
        }[];
        pending = requests.find((request) => request.pairingId === pairingId);
        if (pending) break;
        await delay(500);
      }
      if (!pending) throw new Error("配对已过期，请重新运行 pico remote pair");
      const permissions = permissionFlags(one("--permissions"));
      const workspaceIds = listFlag(one("--workspaces"));
      output(
        `设备：${pending.deviceName}\n请求编号：${pairingId}\n授权：${permissions.join(", ")}\n工作区：${workspaceIds?.join(", ") ?? "本机网关已配置的工作区"}`,
      );
      const confirmed = (await ask("确认是你的手机并批准此授权？输入 yes：")).trim().toLowerCase();
      if (confirmed !== "yes") {
        await requestGatewayControl(home, "pair.reject", { pairingId });
        output("配对已拒绝。");
        return 1;
      }
      const result = await requestGatewayControl(home, "pair.approve", {
        pairingId,
        permissions,
        ...(workspaceIds ? { workspaceIds } : {}),
      });
      output(`配对已批准，请等待手机保存凭据：\n${JSON.stringify(result, null, 2)}`);
      return 0;
    }
    if (command === "devices") {
      const subcommand = positional[1];
      if (subcommand === "list") {
        output(JSON.stringify(await requestGatewayControl(home, "devices.list"), null, 2));
        return 0;
      }
      const deviceId = positional[2];
      if (!deviceId) throw new Error("需要设备 ID");
      if (subcommand === "revoke") {
        output(
          JSON.stringify(
            await requestGatewayControl(home, "devices.revoke", { deviceId }),
            null,
            2,
          ),
        );
        return 0;
      }
      if (subcommand === "grant") {
        if (!one("--permissions") || !one("--workspaces"))
          throw new Error("grant 需要显式 --permissions 与 --workspaces");
        const result = await requestGatewayControl(home, "devices.grant", {
          deviceId,
          permissions: permissionFlags(one("--permissions")),
          workspaceIds: listFlag(one("--workspaces")),
        });
        output(JSON.stringify(result, null, 2));
        return 0;
      }
    }
    throw new Error("未知 remote 命令；使用 --help 查看帮助");
  } catch (error) {
    output(error instanceof Error ? error.message : "远程网关命令失败");
    return 1;
  } finally {
    readline?.close();
  }
}
function listFlag(value: string | undefined): string[] | undefined {
  return value === undefined
    ? undefined
    : value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}
function permissionFlags(value: string | undefined): RemotePermission[] {
  const permissions = listFlag(value) ?? [...REMOTE_DEFAULT_PERMISSIONS];
  if (
    permissions.some((permission) => !REMOTE_PERMISSIONS.includes(permission as RemotePermission))
  )
    throw new Error("设备权限名称无效");
  return [...new Set(permissions)] as RemotePermission[];
}
