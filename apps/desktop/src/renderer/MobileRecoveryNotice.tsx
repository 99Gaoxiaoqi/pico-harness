import { RefreshCw } from "lucide-react";
import { Button, InlineNotice } from "./components.js";

/**
 * Startup recovery is silent by design; this is the only user-facing surface.
 * It appears only in the mobile settings page, so an unattended launch never
 * raises an alarm the user cannot act on.
 */
export function MobileRecoveryNotice({
  visible,
  busy,
  onRetry,
}: {
  readonly visible: boolean;
  readonly busy: boolean;
  readonly onRetry: () => void;
}) {
  if (!visible) return null;
  return (
    <InlineNotice tone="error">
      手机连接已开启，但后台服务未运行。自动恢复没有完成，请检查连接配置后重试。
      <Button variant="quiet" disabled={busy} onClick={onRetry}>
        <RefreshCw size={15} aria-hidden="true" /> 重试恢复
      </Button>
    </InlineNotice>
  );
}
