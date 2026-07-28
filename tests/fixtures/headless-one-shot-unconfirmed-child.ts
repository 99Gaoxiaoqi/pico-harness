import { stdin, stdout } from "node:process";
import { runHeadlessOneShotJson } from "../../src/internal/headless-one-shot-runner.js";

const chunks: Buffer[] = [];
for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
const raw = Buffer.concat(chunks).toString("utf8");
const mode = process.env["HEADLESS_CHILD_MODE"];

const outcome = await runHeadlessOneShotJson(raw, {
  env: {},
  executeRuntime: () => {
    process.stderr.write("RUNTIME_STARTED\n");
    return new Promise(() => undefined);
  },
});

if (mode === "timeout") {
  stdout.write(`${JSON.stringify(outcome.result)}\n`, () => process.exit(outcome.exitCode));
}
