import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppErrorBoundary, DesktopApp } from "./App.js";
import { PicoTheme } from "./astryx-provider.js";
import "./styles.css";
import "./workbar-panels/artifact-preview.css";
import "./astryx-controls.css";
import "./shell-astryx.css";
import "./conversation/markdown-astryx.css";
import "./conversation/astryx-chat.css";

const root = document.getElementById("root");
if (!root) throw new Error("Renderer root element is missing");

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <PicoTheme>
        <DesktopApp />
      </PicoTheme>
    </AppErrorBoundary>
  </StrictMode>,
);
