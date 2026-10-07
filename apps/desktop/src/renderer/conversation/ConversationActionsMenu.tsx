import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import {
  DropdownMenu,
  DropdownMenuDivider,
  DropdownMenuItem,
} from "@astryxdesign/core/DropdownMenu";
import {
  Copy,
  CopyPlus,
  FileDiff,
  FolderOpen,
  Minimize2,
  MoreHorizontal,
  Pencil,
} from "lucide-react";
import { useRef, useState } from "react";

export function ConversationActionsMenu({
  disabledReason,
  onReview,
  onRename,
  onFork,
  onCompact,
  onOpenWorkspace,
  onCopyWorkspacePath,
}: {
  readonly disabledReason?: string | undefined;
  readonly onReview: () => void;
  readonly onRename: () => void;
  readonly onFork: () => Promise<boolean>;
  readonly onCompact: () => void;
  readonly onOpenWorkspace: () => void;
  readonly onCopyWorkspacePath: () => void;
}) {
  const [forkOpen, setForkOpen] = useState(false);
  const [forkBusy, setForkBusy] = useState(false);
  const [forkError, setForkError] = useState<string>();
  const forkLock = useRef(false);
  const blocked = Boolean(disabledReason) || forkBusy;

  async function fork() {
    if (blocked || forkLock.current) return;
    forkLock.current = true;
    setForkBusy(true);
    setForkError(undefined);
    try {
      if (await onFork()) setForkOpen(false);
      else setForkError("未能创建新会话，请查看错误提示后重试。");
    } catch (cause) {
      setForkError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      forkLock.current = false;
      setForkBusy(false);
    }
  }

  return (
    <>
      <DropdownMenu
        className="conversation-actions-menu"
        button={{
          label: "更多会话操作",
          icon: <MoreHorizontal aria-hidden="true" />,
          isIconOnly: true,
          variant: "ghost",
          size: "sm",
          className: "conversation-panel-toggle",
          tooltip: "更多会话操作",
        }}
        hasChevron={false}
        alignment="end"
        menuWidth={288}
        presentation="popover"
      >
        <DropdownMenuItem
          label="查看运行改动"
          description={
            <span>{disabledReason ?? "查看一次运行修改的文件，确认结果或反馈修改意见"}</span>
          }
          icon={<FileDiff aria-hidden="true" />}
          isDisabled={blocked}
          onClick={onReview}
        />
        <DropdownMenuItem
          label="重命名会话"
          description={<span>{disabledReason ?? "修改会话标题，方便查找"}</span>}
          icon={<Pencil aria-hidden="true" />}
          isDisabled={blocked}
          onClick={onRename}
        />
        <DropdownMenuItem
          label="复制为新会话…"
          description={
            <span>{disabledReason ?? "沿用当前上下文尝试另一种方案，共用项目文件"}</span>
          }
          icon={<CopyPlus aria-hidden="true" />}
          isDisabled={blocked}
          onClick={() => {
            setForkError(undefined);
            setForkOpen(true);
          }}
        />
        <DropdownMenuDivider />
        <DropdownMenuItem
          label="打开项目文件夹"
          icon={<FolderOpen aria-hidden="true" />}
          onClick={onOpenWorkspace}
        />
        <DropdownMenuItem
          label="复制项目路径"
          icon={<Copy aria-hidden="true" />}
          onClick={onCopyWorkspacePath}
        />
        <DropdownMenuDivider />
        <DropdownMenuItem
          label="压缩上下文…"
          description={
            <span>{disabledReason ?? "用摘要减少后续请求的上下文占用，保留历史记录"}</span>
          }
          icon={<Minimize2 aria-hidden="true" />}
          isDisabled={blocked}
          onClick={onCompact}
        />
      </DropdownMenu>
      <Dialog
        isOpen={forkOpen}
        onOpenChange={(open) => {
          if (!forkBusy) setForkOpen(open);
        }}
        aria-label="复制为新会话"
      >
        <section className="command-dialog conversation-action-dialog">
          <h2>复制为新会话</h2>
          <p>继承当前对话的上下文和设置，在新会话中尝试另一种方案。</p>
          <p>两个会话共用同一项目目录，文件修改会相互影响。</p>
          {disabledReason && <p role="status">{disabledReason}</p>}
          {forkError && <p role="alert">{forkError}</p>}
          <div className="command-dialog__actions">
            <Button
              label="取消"
              variant="ghost"
              isDisabled={forkBusy}
              onClick={() => setForkOpen(false)}
            />
            <Button
              label={forkBusy ? "正在创建…" : "创建新会话"}
              variant="primary"
              isDisabled={blocked}
              onClick={() => void fork()}
            />
          </div>
        </section>
      </Dialog>
    </>
  );
}
