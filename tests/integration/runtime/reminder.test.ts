import assert from "node:assert/strict";
import { test } from "node:test";
import { ReminderInjector, ToolGuardrailController } from "@pico/runtime/reminder";

const toolCall = { id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' };

test("ReminderInjector 在第三次相同失败时注入隐藏的系统提醒并保留宿主日志端口", () => {
  const warnings: string[] = [];
  const injector = new ReminderInjector({ warn: (message) => warnings.push(message) });
  const failedResult = { toolCallId: toolCall.id, output: "ENOENT", isError: true };

  assert.equal(injector.checkAndInject(toolCall, failedResult), null);
  assert.equal(injector.checkAndInject(toolCall, failedResult), null);
  const reminder = injector.checkAndInject(toolCall, failedResult);

  assert.equal(reminder?.role, "user");
  assert.match(reminder?.content ?? "", /陷入了死循环/u);
  assert.equal(reminder?.providerData?.["picoHiddenFromTranscript"], true);
  assert.equal(warnings.length, 4);
});

test("ToolGuardrailController 在阈值后阻断重复失败，并在成功后解除阻断", () => {
  const guardrail = new ToolGuardrailController({ exactFailureWarnAt: 2, exactFailureBlockAt: 3 });
  const failedResult = { toolCallId: toolCall.id, output: "failed", isError: true };

  assert.equal(guardrail.afterCall(toolCall, failedResult), null);
  assert.match(guardrail.afterCall(toolCall, failedResult)?.content ?? "", /重复失败/u);
  guardrail.afterCall(toolCall, failedResult);
  assert.equal(guardrail.beforeCall(toolCall).allowed, false);

  assert.equal(
    guardrail.afterCall(toolCall, { toolCallId: toolCall.id, output: "ok", isError: false }),
    null,
  );
  assert.equal(guardrail.beforeCall(toolCall).allowed, true);
});
