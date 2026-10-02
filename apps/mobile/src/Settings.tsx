import React, { useState } from "react";
import { View } from "react-native";
import { Chips } from "./ui";
import { Jobs } from "./settings/Jobs";
import { Memory } from "./settings/Memory";
import { Providers } from "./settings/Providers";
import { Mcp } from "./settings/Mcp";
import { Defaults } from "./settings/Defaults";
import { Capabilities } from "./settings/Capabilities";

export { SessionSettings } from "./settings/SessionSettings";

const sections = [
  "自动化",
  "记忆",
  "Provider",
  "MCP",
  "Skills",
  "Hooks",
  "插件",
  "默认设置",
] as const;
export function SettingsPanel() {
  const [section, setSection] = useState<(typeof sections)[number]>("自动化");
  return (
    <View style={{ gap: 14 }}>
      <Chips values={sections} value={section} onChange={setSection} />
      {section === "自动化" ? (
        <Jobs />
      ) : section === "记忆" ? (
        <Memory />
      ) : section === "Provider" ? (
        <Providers />
      ) : section === "MCP" ? (
        <Mcp />
      ) : section === "默认设置" ? (
        <Defaults />
      ) : (
        <Capabilities key={section} section={section} />
      )}
    </View>
  );
}
