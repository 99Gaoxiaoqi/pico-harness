// 4.3 REST 端点矩阵 + 共享引擎装配。
//
// 把 main.ts 原本内联的 serve() 抽出,扩展为 RESTful 端点:
//   POST   /sessions                创建会话(body: {workDir?}) → {sessionId}
//   GET    /sessions/:id            会话状态(length/createdAt/epoch 等)
//   POST   /sessions/:id/messages   发消息触发 run(body: {prompt, planMode?, maxTurns?}) → run 结果
//   POST   /approvals/:taskId       approve/reject/modify(body: {action, reason?, modifiedContent?})
//   GET    /tools                   可用工具列表(经 registry.getAvailableTools)
//
// 设计原则:极简。每个请求独立引擎实例(等价于 main.ts 原 serve 语义),
// 复用进程级 GoalManager / BackgroundManager 单例。HTTP 与 WS 各司其职:
// HTTP 处理一次性请求/控制类操作,WS(见 ws.ts)处理流式推送。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { GoalManager } from "../engine/goal-manager.js";
import { AgentEngine } from "../engine/loop.js";
import { globalSessionManager } from "../engine/session.js";
import { Compactor } from "../context/compactor.js";
import { ToolResultArtifactStore } from "../context/artifact-store.js";
import { createContextBudget, estimateTokenBudgetAsChars } from "../context/context-budget.js";
import { TerminalReporter } from "../engine/reporter.js";
import { createProvider, type ProviderKind } from "../provider/factory.js";
import { resolveProviderProfile } from "../provider/profile.js";
import { resolveThinkingEffort, type ThinkingEffort } from "../provider/thinking.js";
import { buildDefaultToolRegistry } from "../tools/default-registry.js";
import { BackgroundManager } from "../tools/background-manager.js";
import { PromptComposer } from "../context/composer.js";
import {
  globalApprovalManager,
  globalApprovalPolicy,
  type ApprovalNotifier,
} from "../approval/manager.js";
import { computeApprovalDiff } from "../approval/diff.js";
import type { MiddlewareFunc } from "../tools/registry.js";
import {
  DelegationManager,
  DelegateStatusTool,
} from "../tools/delegation-manager.js";
import { createSubagentRegistryFactory } from "../tools/delegation-registry.js";
import { DelegateTaskTool, SpawnSubagentTool } from "../tools/subagent.js";
import { createToolResultObservationProcessor } from "../tools/tool-result-observation.js";
import { ToolRegistry } from "../tools/registry-impl.js";
import { ReadFileTool, BashTool } from "../tools/registry-impl.js";
import { SkillLoader, SkillViewTool } from "../context/skill.js";
import { Tracer } from "../observability/trace.js";

/** HTTP 入口共享的引擎装配配置(由 main.ts --serve 注入) */
export interface ServerOptions {
  /** 进程级默认 provider 协议 */
  kind: ProviderKind;
  /** 应用层两阶段慢思考开关 */
  enableThinking: boolean;
  /** 模型原生思考强度 */
  thinkingEffort: ThinkingEffort;
  /** Plan Mode 默认开关 */
  planMode: boolean;
  /** Tracing 开关 */
  traceEnabled: boolean;
  /** 监听端口 */
  port: number;
  /** 工作区根(默认 process.cwd()) */
  workDir?: string;
  /** 进程级共享 BackgroundManager(可选;不传则自建) */
  backgroundManager?: BackgroundManager;
  /** 进程级共享 GoalManager(可选;不传则自建) */
  goalManager?: GoalManager;
}

/**
 * 终端通知器:HTTP/CLI 模式回退,把审批请求打印到控制台。
 * 4.3:与 main.ts 原 terminalNotifier 等价(就地定义,不耦合 main.ts)。
 */
const terminalNotifier: ApprovalNotifier = (notice) => {
  console.warn(`\n\x1b[31m[需要审批 TaskID: ${notice.taskId}]\x1b[0m ${notice.message}\n`);
  if (notice.diff) {
    console.warn(`\x1b[33m${notice.diff}\x1b[0m\n`);
  }
};

/** 构建上下文压缩器(防 OOM 物理防线) */
function buildCompactor(kind: ProviderKind, model: string): Compactor {
  const protocol = kind === "claude" ? "claude" : "openai";
  const profile = resolveProviderProfile(protocol, model);
  const budget = createContextBudget(profile);
  return new Compactor({
    maxChars: estimateTokenBudgetAsChars(budget.inputBudgetTokens),
    retainLastMsgs: 6,
  });
}

function buildObservationProcessor(workDir: string) {
  const store = new ToolResultArtifactStore({ baseDir: join(workDir, ".claw", "artifacts") });
  return createToolResultObservationProcessor({ store });
}

/** 构建子智能体只读注册表(爆炸半径限制) */
function buildReadOnlyRegistry(workDir: string): ToolRegistry {
  const registry = new ToolRegistry({ truncateResults: false });
  registry.register(new ReadFileTool(workDir));
  registry.register(new BashTool(workDir, undefined, { allowBackground: false }));
  registry.register(new SkillViewTool(new SkillLoader(workDir)));
  return registry;
}

function buildApprovalMiddleware(notifier: ApprovalNotifier, workDir: string): MiddlewareFunc {
  return async (call) => {
    return globalApprovalPolicy.decide("http", call, async () => {
      const diff = await computeApprovalDiff(call.name, call.arguments, workDir);
      return globalApprovalManager.waitForApproval(
        call.id,
        call.name,
        call.arguments,
        notifier,
        diff,
      );
    });
  };
}

/**
 * 共享的引擎装配 helper:为一次 run 构建 provider/registry/engine。
 * 每个 HTTP 消息请求独立实例,收集最终 assistant 回复。
 * 返回 { engine, reporter, collected } 供调用方 await engine.run(session)。
 *
 * 与 main.ts 原 serve() 内部装配逻辑等价( GoalManager / BackgroundManager 单例
 * 由 serverOptions 注入,跨请求复用)。
 */
export async function assembleEngine(
  opts: ServerOptions,
  options: {
    workDir: string;
    goalManager: GoalManager;
    backgroundManager: BackgroundManager;
    requestThinkingEffort: ThinkingEffort;
    requestPlanMode?: boolean;
    maxTurns?: number;
  },
): Promise<{ engine: AgentEngine; collected: string[] }> {
  const { workDir, goalManager, backgroundManager, requestThinkingEffort, requestPlanMode, maxTurns } =
    options;
  const effectivePlanMode = requestPlanMode ?? opts.planMode;
  const modelName =
    process.env.LLM_MODEL ?? (opts.kind === "openai" ? "glm-5.2" : "claude-3-5-sonnet");
  const systemPrompt = effectivePlanMode
    ? undefined
    : await new PromptComposer(workDir, false, { goalManager }).build();

  const collected: string[] = [];
  const reporter = new (class extends TerminalReporter {
    override onMessage(content: string): void {
      collected.push(content);
    }
  })();

  const provider = createProvider(opts.kind, undefined, requestThinkingEffort);
  const registry = buildDefaultToolRegistry(workDir, { backgroundManager, goalManager });
  registry.use(buildApprovalMiddleware(terminalNotifier, workDir));
  const engine = new AgentEngine({
    provider,
    registry,
    workDir,
    enableThinking: opts.enableThinking,
    thinkingEffort: requestThinkingEffort,
    planMode: effectivePlanMode,
    systemPrompt,
    goalManager,
    compactor: buildCompactor(opts.kind, modelName),
    observationProcessor: buildObservationProcessor(workDir),
    reporter,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    tracer: opts.traceEnabled ? new Tracer() : undefined,
  });

  // 注册 Hermes 风格委派工具 + spawn_subagent 兼容入口
  const manager = new DelegationManager();
  const registryFactory = createSubagentRegistryFactory({
    workDir,
    runner: engine,
    manager,
  });
  registry.register(new DelegateTaskTool(engine, registryFactory, manager, {}));
  registry.register(new DelegateStatusTool(manager));
  registry.register(new SpawnSubagentTool(engine, buildReadOnlyRegistry(workDir)));

  return { engine, collected };
}

/** 读取请求 body 为字符串 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** 发送 JSON 响应 */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** 从 URL path 解析路由参数(/sessions/:id → { id }) */
function matchRoute(
  urlPath: string,
  method: string,
): { kind: "createSession" } | { kind: "getSession"; id: string } | {
  kind: "sendMessage";
  id: string;
} | { kind: "approve"; taskId: string } | { kind: "tools" } | { kind: "unknown" } {
  const path = urlPath.split("?")[0]!;
  if (method === "POST" && path === "/sessions") return { kind: "createSession" };
  if (method === "GET" && path === "/tools") return { kind: "tools" };
  const sessionMatch = /^\/sessions\/([^/]+)$/.exec(path);
  if (sessionMatch && method === "GET") return { kind: "getSession", id: sessionMatch[1]! };
  const messageMatch = /^\/sessions\/([^/]+)\/messages$/.exec(path);
  if (messageMatch && method === "POST")
    return { kind: "sendMessage", id: messageMatch[1]! };
  const approvalMatch = /^\/approvals\/([^/]+)$/.exec(path);
  if (approvalMatch && method === "POST") return { kind: "approve", taskId: approvalMatch[1]! };
  return { kind: "unknown" };
}

/**
 * 启动 HTTP RESTful 服务(4.3 REST 端点矩阵)。
 * 返回已启动的 http.Server,供调用方 hold 住进程生命周期 + 关联 WS 升级。
 */
export async function startHttpServer(opts: ServerOptions): Promise<Server> {
  const workDir = opts.workDir ?? process.cwd();
  const goalManager = opts.goalManager ?? new GoalManager();
  const backgroundManager = opts.backgroundManager ?? new BackgroundManager();
  // 自增计数器:生成 URL 安全的 sessionId(无 / : \ 等破坏路由的字符)
  let sessionCounter = 0;

  const server = createServer(async (req, res) => {
    const urlPath = req.url ?? "/";
    const route = matchRoute(urlPath, req.method ?? "GET");

    try {
      switch (route.kind) {
        // ----------------------------------------------------------------
        // POST /sessions → 创建 session
        // ----------------------------------------------------------------
        case "createSession": {
          const body = await readBody(req);
          let parsed: { workDir?: string } = {};
          if (body) parsed = JSON.parse(body) as { workDir?: string };
          // sessionId 必须是 URL 安全的(无 / : \ 等),否则 GET /sessions/:id 路由会断。
          // 用自增计数 + 时间戳,保证进程内唯一且可作文件名片段。
          const sessionId = `http-${Date.now().toString(36)}-${(++sessionCounter).toString(36)}`;
          await globalSessionManager.getOrCreate(sessionId, parsed.workDir ?? workDir);
          sendJson(res, 201, { sessionId });
          return;
        }

        // ----------------------------------------------------------------
        // GET /sessions/:id → 会话状态
        // ----------------------------------------------------------------
        case "getSession": {
          const session = globalSessionManager.get(route.id);
          if (!session) {
            sendJson(res, 404, { error: `会话不存在: ${route.id}` });
            return;
          }
          sendJson(res, 200, {
            sessionId: session.id,
            workDir: session.workDir,
            length: session.length,
            createdAt: session.createdAt.toISOString(),
            updatedAt: session.updatedAt.toISOString(),
            conversationId: session.conversationId,
            epoch: session.recordStore?.getEpoch() ?? 0,
          });
          return;
        }

        // ----------------------------------------------------------------
        // POST /sessions/:id/messages → 发消息触发 run
        // ----------------------------------------------------------------
        case "sendMessage": {
          const session = globalSessionManager.get(route.id);
          if (!session) {
            sendJson(res, 404, { error: `会话不存在: ${route.id}` });
            return;
          }
          const body = await readBody(req);
          const parsed = JSON.parse(body) as {
            prompt?: string;
            planMode?: boolean;
            maxTurns?: number;
            thinkingEffort?: string;
          };
          if (!parsed.prompt) {
            sendJson(res, 400, { error: "缺少 prompt 字段" });
            return;
          }
          const requestThinkingEffort = parsed.thinkingEffort
            ? resolveThinkingEffort(parsed.thinkingEffort)
            : opts.thinkingEffort;
          const { engine, collected } = await assembleEngine(opts, {
            workDir,
            goalManager,
            backgroundManager,
            requestThinkingEffort,
            ...(parsed.planMode !== undefined ? { requestPlanMode: parsed.planMode } : {}),
            ...(parsed.maxTurns !== undefined ? { maxTurns: parsed.maxTurns } : {}),
          });
          session.append({ role: "user", content: parsed.prompt });
          const newMessages = await session.serialize(() => engine.run(session));
          // collected 仅含 onMessage 回调的纯文本;补上新增消息总数
          sendJson(res, 200, {
            reply: collected.join("\n"),
            sessionId: session.id,
            newMessageCount: newMessages.length,
          });
          return;
        }

        // ----------------------------------------------------------------
        // POST /approvals/:taskId → approve/reject/modify
        // ----------------------------------------------------------------
        case "approve": {
          const body = await readBody(req);
          const parsed = JSON.parse(body) as {
            action: "approve" | "reject" | "modify";
            reason?: string;
            modifiedContent?: string;
          };
          const reason = parsed.reason ?? parsed.action;
          let ok: boolean;
          if (parsed.action === "modify") {
            if (!parsed.modifiedContent) {
              sendJson(res, 400, { error: "modify 动作需要 modifiedContent 字段" });
              return;
            }
            ok = globalApprovalManager.resolveApprovalWithModify(
              route.taskId,
              reason,
              parsed.modifiedContent,
            );
          } else {
            ok = globalApprovalManager.resolveApproval(
              route.taskId,
              parsed.action === "approve",
              reason,
            );
          }
          if (!ok) {
            sendJson(res, 404, { error: `找不到对应的审批任务: ${route.taskId}` });
            return;
          }
          sendJson(res, 200, { taskId: route.taskId, action: parsed.action });
          return;
        }

        // ----------------------------------------------------------------
        // GET /tools → 可用工具列表
        // ----------------------------------------------------------------
        case "tools": {
          const registry = buildDefaultToolRegistry(workDir, { backgroundManager, goalManager });
          sendJson(res, 200, { tools: registry.getAvailableTools() });
          return;
        }

        default:
          sendJson(res, 404, {
            error:
              "未知路由。可用端点: POST /sessions, GET /sessions/:id, " +
              "POST /sessions/:id/messages, POST /approvals/:taskId, GET /tools",
          });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: msg });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(opts.port, () => resolve());
  });
  return server;
}
