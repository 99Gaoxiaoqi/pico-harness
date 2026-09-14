import React from "react";
import { Box } from "ink";

export interface LayoutShellProps {
  header?: React.ReactNode | undefined;
  status?: React.ReactNode | undefined;
  transcript?: React.ReactNode | undefined;
  bottom?: React.ReactNode | undefined;
  overlay?: React.ReactNode | undefined;
  modal?: React.ReactNode | undefined;
  height?: number | undefined;
  hidden?: boolean | undefined;
}

export function LayoutShell({
  header,
  status,
  transcript,
  bottom,
  overlay,
  modal,
  height,
  hidden = false,
}: LayoutShellProps): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      display={hidden ? "none" : "flex"}
      marginRight={1}
      height={height}
      overflowX="hidden"
      overflowY={height ? "hidden" : undefined}
    >
      {header}
      {status}
      {transcript}
      {overlay && (
        <Box flexDirection="column" paddingX={1}>
          {overlay}
        </Box>
      )}
      {modal && (
        <Box flexDirection="column" borderStyle="single" borderColor="cyan" paddingX={1}>
          {modal}
        </Box>
      )}
      {/* 吸收保守布局预算留下的空行，让输入框/代理导航稳定贴底。 */}
      <Box flexGrow={1} />
      {bottom}
    </Box>
  );
}
