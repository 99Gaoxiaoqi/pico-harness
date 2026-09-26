import { Theme } from "@astryxdesign/core/theme";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import type { ReactNode } from "react";
import { picoTheme } from "./astryx-theme/pico.js";

export function PicoTheme({ children }: { readonly children: ReactNode }) {
  return (
    <InternationalizationProvider
      locale="zh-CN"
      overrides={{
        "zh-CN": {
          "@astryx.appShell.skipToContent": "跳到主要内容",
          "@astryx.dialog.close": "关闭",
          "@astryx.selector.placeholder": "请选择…",
          "@astryx.selector.searchPlaceholder": "搜索…",
          "@astryx.selector.searchOptions": "搜索选项",
          "@astryx.selector.empty": "没有匹配选项",
          "@astryx.chat.composerInput.label": "消息",
          "@astryx.chat.composer.placeholder": "向 Pico 发送消息…",
          "@astryx.chatLayoutScrollButton.scrollToBottom": "回到最新消息",
          "@astryx.chatSendButton.send": "发送",
          "@astryx.chatSendButton.stop": "停止",
          "@astryx.markdown.taskList": "任务列表",
        },
      }}
    >
      <Theme theme={picoTheme} mode="light">
        {children}
      </Theme>
    </InternationalizationProvider>
  );
}
