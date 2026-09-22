import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useRuntime } from "../runtime-context.js";
import { sessionHref } from "../workspace-session.js";
import { UsageSettingsPage, type UsageQuerySelection } from "./UsageSettingsPage.js";

export function UsagePage() {
  const { data, actions } = useRuntime();
  const navigate = useNavigate();
  const [usage, setUsage] = useState<typeof data.usage>({});
  const [selection, setSelection] = useState<UsageQuerySelection>({
    range: "all",
    workspacePath: "",
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const sequence = useRef(0);
  const query = useCallback(
    async (next: UsageQuerySelection) => {
      setSelection(next);
      const days = { "24h": 1, "7d": 7, "30d": 30, all: 0 }[next.range];
      const to = Date.now();
      const input = {
        ...(next.workspacePath ? { workspacePath: next.workspacePath } : {}),
        ...(days ? { from: to - days * 86_400_000, to } : {}),
      };
      const request = ++sequence.current;
      setLoading(true);
      setUsage({});
      setError(undefined);
      try {
        const result = await actions.queryUsage(input);
        if (request !== sequence.current) return;
        if (result) setUsage(result);
        else setError("无法读取本地用量账本，请重试。");
      } catch (cause) {
        if (request === sequence.current)
          setError(cause instanceof Error ? cause.message : "加载用量失败，请重试");
      } finally {
        if (request === sequence.current) setLoading(false);
      }
    },
    [actions],
  );
  useEffect(() => {
    void query({ range: "all", workspacePath: "" });
    return () => {
      sequence.current += 1;
    };
  }, [query]);
  return (
    <UsageSettingsPage
      usage={usage}
      selection={selection}
      workspaces={data.workspaces}
      loading={loading}
      {...(error ? { error } : {})}
      onQuery={query}
      onOpenSession={(workspacePath, sessionId) =>
        navigate(sessionHref({ sessionId, workspacePath }))
      }
    />
  );
}
