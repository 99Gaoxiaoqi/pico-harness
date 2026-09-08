/// <reference lib="dom" />

import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { previewData } from "../../../apps/desktop/src/renderer/fixture.js";
import { AutomationsPage } from "../../../apps/desktop/src/renderer/pages/AutomationsPage.js";
import { HomePage } from "../../../apps/desktop/src/renderer/pages/HomePage.js";
import { ReviewPage } from "../../../apps/desktop/src/renderer/pages/ReviewPage.js";
import { SettingsPage } from "../../../apps/desktop/src/renderer/pages/SettingsPage.js";
import { RuntimeContext } from "../../../apps/desktop/src/renderer/runtime-context.js";
import type { RuntimeStore } from "../../../apps/desktop/src/renderer/runtime.js";

Object.assign(globalThis, { React });

test("extracted desktop pages share the supplied runtime context and route scope", () => {
  const session = previewData.sessions[0]!;
  const job = previewData.jobs[0]!;
  const runtime: RuntimeStore = {
    preview: true,
    connection: { kind: "ready" },
    busy: undefined,
    message: undefined,
    data: {
      ...previewData,
      backgroundMode: true,
      sessions: [{ ...session, title: "来自同一 Runtime 的会话" }],
      jobs: [{ ...job, name: "来自同一 Runtime 的定时任务" }],
      changes: [
        { ...previewData.changes[0]!, path: "shared-context.ts", patch: "+shared-runtime" },
      ],
    },
    actions: new Proxy({} as RuntimeStore["actions"], {
      get: () => () => {
        throw new Error("Rendering must not dispatch runtime mutations");
      },
    }),
  };
  const html = renderToStaticMarkup(
    React.createElement(
      RuntimeContext.Provider,
      { value: runtime },
      React.createElement(
        MemoryRouter,
        { initialEntries: [`/review?workspace=${encodeURIComponent(session.workspacePath)}`] },
        React.createElement(HomePage),
        React.createElement(AutomationsPage),
        React.createElement(ReviewPage),
        React.createElement(SettingsPage),
      ),
    ),
  );

  assert.match(html, /来自同一 Runtime 的会话/u);
  assert.match(html, /来自同一 Runtime 的定时任务/u);
  assert.match(html, /shared-context\.ts/u);
  assert.match(html, /\+shared-runtime/u);
  assert.match(html, /<option value="enabled" selected="">继续后台运行<\/option>/u);
  assert.match(html, new RegExp(`workspace=${encodeURIComponent(session.workspacePath)}`, "u"));
});
