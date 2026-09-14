import assert from "node:assert/strict";
import test from "node:test";

import { FileIndex, listFileSuggestions } from "@pico/pico-host/file-index";

test("Pico Host FileIndex preserves discovery fallback, filtering and cache invalidation", async () => {
  let calls = 0;
  const index = FileIndex.create({
    cwd: "/virtual/workspace",
    commandRunner: async (command) => {
      calls++;
      assert.equal(command, "git");
      return "src/z.ts\nsrc/a.ts\nnode_modules/hidden.ts\nsrc\\win.ts\n";
    },
  });

  assert.deepEqual(await index.query("@src"), ["src/a.ts", "src/win.ts", "src/z.ts"]);
  assert.deepEqual(await index.query('@"src/a"'), ["src/a.ts"]);
  assert.equal(calls, 1, "queries within the cache window must reuse one discovery snapshot");
  index.markDirty();
  await index.query("");
  assert.equal(calls, 2);

  const commands: string[] = [];
  const fallback = await listFileSuggestions({
    cwd: "/virtual/workspace",
    commandRunner: async (command) => {
      commands.push(command);
      if (command === "git") throw new Error("not a repository");
      return "docs/readme.md\ndist/generated.js\n";
    },
  });
  assert.deepEqual(commands, ["git", "rg"]);
  assert.deepEqual(fallback, ["docs/readme.md"]);
});
