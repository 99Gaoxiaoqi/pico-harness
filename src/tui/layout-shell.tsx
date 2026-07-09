import React from "react";
import { Box } from "ink";

export interface LayoutShellProps {
  header?: React.ReactNode;
  status?: React.ReactNode;
  transcript?: React.ReactNode;
  bottom?: React.ReactNode;
  overlay?: React.ReactNode;
  modal?: React.ReactNode;
  height?: number;
}

export function LayoutShell({
  header,
  status,
  transcript,
  bottom,
  overlay,
  modal,
  height,
}: LayoutShellProps): React.ReactNode {
  return (
    <Box flexDirection="column" height={height} overflowY={height ? "hidden" : undefined}>
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
      {bottom}
    </Box>
  );
}
