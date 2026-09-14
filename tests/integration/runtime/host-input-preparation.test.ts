import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { preparePromptForMessage } from "@pico/pico-host/input/prepare-prompt";
import { initializeProjectEntrypoints } from "@pico/pico-host/input/project-initializer";
import { renderSkillActivation } from "@pico/pico-host/input/skill-activation";

test("Host initializes once and prepares file, skill, agent and image input together", async (context) => {
  const workspace = await mkdtemp(join(tmpdir(), "pico-host-input-"));
  context.after(() => rm(workspace, { recursive: true, force: true }));
  assert.deepEqual(
    (await initializeProjectEntrypoints(workspace)).files.map((file) => file.status),
    ["created", "created"],
  );
  await writeFile(join(workspace, "AGENTS.md"), "Keep existing guidance.\n");
  assert.deepEqual(
    (await initializeProjectEntrypoints(workspace)).files.map((file) => file.status),
    ["existing", "existing"],
  );
  assert.equal(await readFile(join(workspace, "AGENTS.md"), "utf8"), "Keep existing guidance.\n");
  await writeFile(join(workspace, "notes.md"), "first\nsecond\nthird\n");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(join(workspace, "sample image.png"), png);
  const activated = renderSkillActivation({
    name: "review",
    args: '"target module"',
    body: "Review $ARGUMENTS[0]",
    trigger: "user-slash",
  });
  const result = await preparePromptForMessage(
    '@notes.md#L2 @skill:review @agent:reviewer @image:"sample image.png"',
    workspace,
    { viewBody: async (name) => (name === "review" ? activated.prompt : undefined) },
  );
  assert.match(result.prompt, /2: second/u);
  assert.doesNotMatch(result.prompt, /1: first/u);
  assert.match(result.prompt, /Review target module/u);
  assert.match(result.prompt, /@agent:reviewer/u);
  assert.deepEqual(result.images, [
    { type: "image_base64", mimeType: "image/png", data: png.toString("base64") },
  ]);
  assert.deepEqual(result.notices, ["已附加图片: sample image.png"]);
});

test("Host input refuses an image symlink that escapes the workspace", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-host-image-boundary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(root, "private.png"), "outside-image");
  await symlink(join(root, "private.png"), join(workspace, "image.png"));
  await assert.rejects(
    preparePromptForMessage("@image:image.png", workspace, { viewBody: async () => undefined }),
    /图片路径在工作区外/u,
  );
});
