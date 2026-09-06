import type { AgentGraphOperator, AgentGraphWorkspacePolicy } from "./core/contracts.js";
import { agentOutputRecordIdFor, intentIdFor, operatorIdFor } from "./core/ids.js";
import type {
  CommitAgentGraphUpdateInput,
  AgentGraphRequestedScheduleCommand,
} from "../tools/agent-graph-tools.js";

/** Model intent; execution identities and schedule versions belong to the application service. */
export type AgentGraphWorkRequest =
  | {
      readonly operation: "add_work";
      readonly work: readonly ({
        readonly instruction: string;
        readonly replacesIntentId?: string;
        readonly inputIds: readonly string[];
      } & (
        | { readonly profileId: string; readonly workspace: AgentGraphWorkspacePolicy }
        | { readonly operatorId: string }
      ))[];
    }
  | {
      readonly operation: "stop";
      readonly targets: readonly ((
        | { readonly operatorId: string }
        | { readonly intentId: string }
      ) & {
        readonly reason?: string;
      })[];
    }
  | { readonly operation: "finish"; readonly resultIds: readonly string[] };

export interface CommitAgentGraphWorkInput extends Omit<
  CommitAgentGraphUpdateInput,
  "commands" | "expectedRevision" | "operationId"
> {
  readonly request: AgentGraphWorkRequest;
}

export function compileAgentGraphWork(
  input: CommitAgentGraphWorkInput,
  operationId: string,
  expectedRevision: number,
  operators: readonly AgentGraphOperator[],
): readonly AgentGraphRequestedScheduleCommand[] {
  const operatorFor = (id: string) => {
    const operator = operators.find((item) => item.operatorId === id);
    if (!operator) throw new Error(`Unknown Graph operator: ${id}. Read view_agent_graph first.`);
    return operator;
  };
  const request = input.request;
  if (request.operation === "finish") {
    return [
      {
        kind: "finish",
        ...(request.resultIds.length ? { selectedRecordIds: request.resultIds } : {}),
      },
    ];
  }
  if (request.operation === "stop") {
    return request.targets.map((target) => ({
      kind: "stop",
      target:
        "operatorId" in target
          ? {
              kind: "operator",
              operatorId: target.operatorId,
              generation: operatorFor(target.operatorId).generation,
            }
          : { kind: "intent", intentId: target.intentId },
      ...(target.reason === undefined ? {} : { reason: target.reason }),
    }));
  }
  return request.work.flatMap((work, index): readonly AgentGraphRequestedScheduleCommand[] => {
    const existing = "operatorId" in work ? operatorFor(work.operatorId) : undefined;
    const operatorId =
      existing?.operatorId ?? operatorIdFor(input.graphId, `${operationId}:${index}`);
    const intentId = intentIdFor(input.graphId, operationId, index);
    const generation = existing?.generation ?? 1;
    const intent = {
      graphId: input.graphId,
      intentId,
      operatorId,
      operatorGeneration: generation,
      instruction: work.instruction,
      expectedOutputRecordId: agentOutputRecordIdFor(input.graphId, intentId),
      inputRefs: work.inputIds.map((recordId) => ({ recordId })),
      createdAtRevision: expectedRevision + 1,
      requestedBy: input.source,
      ...(input.supervision ? { supervision: input.supervision } : {}),
      ...(work.replacesIntentId ? { replacesIntentId: work.replacesIntentId } : {}),
    };
    const stop: AgentGraphRequestedScheduleCommand[] = work.replacesIntentId
      ? [
          {
            kind: "stop",
            target: { kind: "intent", intentId: work.replacesIntentId },
            reason: "Replaced by follow-up work",
          },
        ]
      : [];
    if ("operatorId" in work) return [...stop, { kind: "activate", intent }];
    return [
      ...stop,
      {
        kind: "add",
        operator: {
          graphId: input.graphId,
          operatorId,
          generation,
          role: work.profileId,
          profileId: work.profileId,
          workspacePolicy: work.workspace,
        },
        intent,
      },
    ];
  });
}
