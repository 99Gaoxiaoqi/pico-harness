import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
// @ts-expect-error The benchmark orchestrator is intentionally plain Node ESM.
import * as egressPolicy from "../../scripts/terminal-bench/egress-policy.mjs";

const execFileAsync = promisify(execFile);

test("Terminal-Bench validates its runtime control configuration", async () => {
  await execFileAsync("python3", ["scripts/terminal-bench/check-trial-network-lifecycle.py"], {
    cwd: process.cwd(),
    timeout: 30_000,
  });
});

test("Terminal-Bench keeps its public egress manifest and runtime policy in sync", async () => {
  const { stdout } = await execFileAsync(
    "python3",
    ["scripts/terminal-bench/check-public-egress-security.py"],
    {
      cwd: process.cwd(),
      timeout: 30_000,
    },
  );
  const runtimePolicy = JSON.parse(stdout.trim()) as Record<string, unknown>;
  assert.equal(runtimePolicy.ok, true);
  assert.deepEqual(
    {
      proxyPolicyVersion: runtimePolicy.proxyPolicyVersion,
      limits: {
        maxConnections: runtimePolicy.maxConnections,
        maxRequests: runtimePolicy.maxRequests,
        maxTotalBytes: runtimePolicy.maxTotalBytes,
        connectionTimeoutSec: runtimePolicy.connectionTimeoutSec,
        maxAuditDecisions: runtimePolicy.maxAuditDecisions,
        allowedHttpPorts: runtimePolicy.allowedHttpPorts,
        allowedConnectPorts: runtimePolicy.allowedConnectPorts,
      },
      dns: {
        mode: runtimePolicy.dnsMode,
        host: runtimePolicy.dohHost,
        endpointIps: runtimePolicy.dohEndpointIps,
        systemFallback: runtimePolicy.systemDnsFallback,
        ipv4Only: runtimePolicy.ipv4Only,
      },
    },
    {
      proxyPolicyVersion: egressPolicy.publicEgressProxyPolicyVersion,
      limits: {
        maxConnections: egressPolicy.publicEgressLimits.maxConnections,
        maxRequests: egressPolicy.publicEgressLimits.maxRequests,
        maxTotalBytes: egressPolicy.publicEgressLimits.maxTotalBytes,
        connectionTimeoutSec: egressPolicy.publicEgressLimits.connectionTimeoutSec,
        maxAuditDecisions: egressPolicy.publicEgressLimits.maxAuditDecisions,
        allowedHttpPorts: [...egressPolicy.publicEgressLimits.allowedHttpPorts],
        allowedConnectPorts: [...egressPolicy.publicEgressLimits.allowedConnectPorts],
      },
      dns: {
        mode: egressPolicy.publicEgressDnsPolicy.mode,
        host: egressPolicy.publicEgressDnsPolicy.host,
        endpointIps: [...egressPolicy.publicEgressDnsPolicy.endpointIps],
        systemFallback: egressPolicy.publicEgressDnsPolicy.systemFallback,
        ipv4Only: egressPolicy.publicEgressDnsPolicy.ipv4Only,
      },
    },
  );
});
