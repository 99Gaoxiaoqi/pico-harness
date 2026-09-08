import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useRuntime } from "../runtime-context.js";
import { sessionHref } from "../workspace-session.js";
import { UsageSettingsPage } from "./UsageSettingsPage.js";

export function UsagePage() {
  const { data, actions } = useRuntime();
  const navigate = useNavigate();
  const [usage, setUsage] = useState(data.usage);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const sequence = useRef(0);
  const query = useCallback(
    async (input: { workspacePath?: string; from?: number; to?: number }) => {
      const request = ++sequence.current;
      setLoading(true);
      setError(undefined);
      try {
        const result = await actions.queryUsage(input);
        if (request !== sequence.current) return;
        if (result) setUsage(result);
        else setError("无法读取本地用量账本，请重试。");
      } finally {
        if (request === sequence.current) setLoading(false);
      }
    },
    [actions],
  );
  useEffect(() => {
    void query({});
    return () => {
      sequence.current += 1;
    };
  }, [query]);
  return (
    <UsageSettingsPage
      usage={usage}
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
