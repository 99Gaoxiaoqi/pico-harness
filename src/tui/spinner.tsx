// Spinner:思考中动画。用 useState + useEffect 每 80ms 切换帧。
// 对标 TerminalReporter 的 setInterval spinner,但在 ink 里用 React 状态驱动。

import React, { useEffect, useState } from "react";
import { Text } from "ink";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner({ label = "" }: { label?: string }): React.ReactNode {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text color="cyan">
      {FRAMES[frame]!} {label}
    </Text>
  );
}
