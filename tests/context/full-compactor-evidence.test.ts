import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateMessagesTokens } from "../../src/context/context-budget.js";
import {
  EvidenceArchive,
  type EvidenceArchiveReference,
} from "../../src/context/evidence-archive.js";
import { FullCompactor } from "../../src/context/full-compactor.js";
import { Session } from "../../src/engine/session.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message } from "../../src/schema/message.js";

describe("FullCompactor evidence integration", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-full-evidence-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("archives raw tool evidence before replacing the Session prefix and retains the reference in metadata", async () => {
    const session = new Session("evidence-session", workDir, { persistence: true });
    await session.recover();
    session.append(
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"a.txt"}' }],
      },
      { role: "user", toolCallId: "call-1", content: "raw evidence that must survive compaction" },
      { role: "assistant", content: "analysis complete" },
      { role: "user", content: "continue" },
    );
    await session.flushPersistence();
    const provider: LLMProvider = {
      async generate(): Promise<Message> {
        return { role: "assistant", content: "compact summary" };
      },
    };
    const archive = new EvidenceArchive({ baseDir: join(workDir, "evidence") });
    const compactor = new FullCompactor({ provider, evidenceArchive: archive });

    const ok = await compactor.compact(session, {
      inputBudgetTokens: 100_000,
      targetRetainedTokens: estimateMessagesTokens(session.getHistory().slice(-1)),
      trigger: "auto",
    });

    expect(ok).toBe(true);
    const summary = session.getHistory()[0]!;
    const references = summary.providerData?.["picoEvidenceArchives"] as
      | EvidenceArchiveReference[]
      | undefined;
    expect(references).toHaveLength(1);
    const manifest = await archive.read(references![0]!);
    expect(manifest.content.exchanges[0]!.assistant.toolCalls?.[0]!.name).toBe("read_file");
    expect(manifest.content.exchanges[0]!.results[0]!.content).toContain("must survive");
    expect(summary.content).not.toContain("raw evidence that must survive compaction");

    await session.close();
    const recovered = new Session("evidence-session", workDir, { persistence: true });
    await recovered.recover();
    const recoveredReferences = recovered.getHistory()[0]!.providerData?.[
      "picoEvidenceArchives"
    ] as EvidenceArchiveReference[] | undefined;
    expect(recoveredReferences).toEqual(references);
    await recovered.close();
  });
});
