#!/usr/bin/env node
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { startRelayServer, requestRelayControl } from "./index.js";
import { RelayError } from "./state.js";

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      home: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      gateway: { type: "string" },
      ttl: { type: "string" },
      "allow-private-bind": { type: "boolean" },
      "trust-proxy": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !positionals[0]) {
    console.log(
      "pico-relay serve [--home PATH] [--host 127.0.0.1] [--port 8787]\npico-relay invite [--home PATH] [--ttl SECONDS]\npico-relay revoke --gateway ID [--home PATH]",
    );
    return;
  }
  const home = resolve(
    values.home ?? process.env.PICO_RELAY_HOME ?? join(homedir(), ".pico-relay"),
  );
  if (positionals[0] === "serve") {
    const server = await startRelayServer({
      home,
      host: values.host ?? "127.0.0.1",
      port: Number(values.port ?? "8787"),
      allowPrivateBind: values["allow-private-bind"] ?? false,
      trustProxy: values["trust-proxy"] ?? false,
    });
    console.log(`Pico relay listening at ${server.origin}`);
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void server.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    return;
  }
  if (positionals[0] === "invite") {
    console.log(
      JSON.stringify(
        await requestRelayControl(
          home,
          "invite",
          values.ttl ? { ttlMs: Number(values.ttl) * 1000 } : {},
        ),
      ),
    );
    return;
  }
  if (positionals[0] === "revoke" && values.gateway) {
    console.log(
      JSON.stringify(await requestRelayControl(home, "revoke", { gatewayId: values.gateway })),
    );
    return;
  }
  throw new RelayError("INVALID_COMMAND");
}
void main().catch((error: unknown) => {
  console.error(`Pico relay: ${error instanceof RelayError ? error.code : "COMMAND_FAILED"}`);
  process.exitCode = 1;
});
