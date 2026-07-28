import { stdin } from "node:process";
import { runHeadlessOneShotJson } from "../../src/internal/headless-one-shot-runner.js";

const chunks: Buffer[] = [];
for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
const raw = Buffer.concat(chunks).toString("utf8");
let providerCalls = 0;

await runHeadlessOneShotJson(raw, {
  env: {},
  providerFactory: () => ({
    async generate() {
      providerCalls++;
      if (providerCalls === 1) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "read-before-trace-kill",
              name: "read_file",
              arguments: JSON.stringify({ path: process.env["TRACE_KILL_SECRET_PATH"] }),
            },
          ],
        };
      }
      return { role: "assistant", content: "done" };
    },
  }),
  beforeTraceSanitize: () => {
    process.stderr.write("TRACE_EXPORTED\n");
    return new Promise(() => undefined);
  },
});
