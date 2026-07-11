import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type {
  WorkspaceTrustDecision,
  WorkspaceTrustPrompt,
  WorkspaceTrustPromptRequest,
} from "../security/workspace-trust.js";

export interface TerminalWorkspaceTrustPromptOptions {
  readonly input: Readable;
  readonly output: Writable;
}

/** readline 只存在于 CLI 适配层，信任业务与具体交互实现解耦。 */
export function createTerminalWorkspaceTrustPrompt(
  options: TerminalWorkspaceTrustPromptOptions,
): WorkspaceTrustPrompt {
  return {
    requestTrust: (request) => requestTrustFromTerminal(request, options),
  };
}

async function requestTrustFromTerminal(
  request: WorkspaceTrustPromptRequest,
  options: TerminalWorkspaceTrustPromptOptions,
): Promise<WorkspaceTrustDecision> {
  const readline = createInterface({ input: options.input, output: options.output });
  try {
    options.output.write(formatTrustNotice(request));
    while (true) {
      const answer = (await readline.question("请选择 [1/2]（默认 2）: ")).trim().toLowerCase();
      if (answer === "1" || answer === "trust" || answer === "yes" || answer === "y") {
        return "trust";
      }
      if (
        answer === "" ||
        answer === "2" ||
        answer === "deny" ||
        answer === "no" ||
        answer === "n"
      ) {
        return "deny";
      }
      options.output.write("无法识别该选项，请输入 1 信任或 2 退出。\n");
    }
  } finally {
    readline.close();
  }
}

function formatTrustNotice(request: WorkspaceTrustPromptRequest): string {
  const risks = request.risks.map((risk) => `  • ${risk}`).join("\n");
  const visiblePath = JSON.stringify(request.workspacePath).replace(
    /[\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );
  return `\nPico 需要信任此工作区\n\n  ${visiblePath}\n\n信任后将允许：\n${risks}\n\n只有在你信任该目录内代码和配置时才继续。\n  [1] 信任并继续\n  [2] 退出\n\n`;
}
