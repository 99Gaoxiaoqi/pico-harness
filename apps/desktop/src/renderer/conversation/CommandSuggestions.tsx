import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { CommandIcon } from "./CommandIcon.js";
import {
  desktopCommandPolicy,
  type DesktopCommandSuggestion,
} from "../../shared/command-policy.js";
import type { SlashArgumentCandidate } from "@pico/cli/command-contracts";
import type { CatalogSkillView, CatalogAgentView } from "../model.js";
import {
  parseComposerDraft,
  placeComposerCaret,
  referenceValue,
  restoreReferenceTokens,
  serializeComposerNode,
  type ComposerReference,
} from "./composer-references.js";
import "./commands.css";

export interface ComposerCommands {
  readonly catalog: readonly DesktopCommandSuggestion[];
  readonly complete: (text: string) => Promise<readonly SlashArgumentCandidate[]>;
}
export interface ComposerResources {
  readonly skills: readonly CatalogSkillView[];
  readonly agents: readonly CatalogAgentView[];
}
interface Candidate {
  label: string;
  description: string;
  text: string;
  disabled: boolean;
  group: string;
  commandName?: string;
  reference?: ComposerReference;
}
const commandTitles: Readonly<Record<string, string>> = {
  help: "查看帮助",
  goal: "管理 Goal",
  resume: "打开历史会话",
  compact: "压缩上下文",
  rewind: "回退到检查点",
  changes: "查看检查点更改",
  model: "选择模型",
  thinking: "调整思考强度",
  plan: "切换计划模式",
  swarm: "使用 Swarm",
  graph: "使用 Graph",
  new: "新建任务",
  rename: "重命名会话",
  fork: "分叉会话",
  status: "查看会话状态",
  context: "查看上下文",
  steer: "调整当前执行",
  queue: "发送到下一轮",
  replace: "停止并替换",
  operations: "查看存储操作",
  hooks: "管理 Hooks",
  "add-dir": "添加工作目录",
};
const commandDescriptions: Readonly<Record<string, string>> = {
  help: "查看可用命令与使用方式",
  goal: "查看目标，暂停或继续执行",
  resume: "搜索并切换到已有会话",
  compact: "精简历史消息，保留任务关键信息",
  rewind: "预览并回退代码或对话",
  changes: "查看文件差异，按文件恢复",
};
function candidateIcon(item: Candidate) {
  if (item.group === "Skills") return "skill";
  if (item.group === "Agents") return "agent";
  if (item.group === "参数") return "argument";
  return item.commandName ?? "command";
}
const normalized = (value: string) => value.normalize("NFKC").toLowerCase();
function score(name: string, description: string, query: string) {
  const n = normalized(name),
    q = normalized(query).trim();
  if (!q) return 1;
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (n.includes(q)) return 60;
  return q.split(/\s+/u).every((part) => normalized(`${name} ${description}`).includes(part))
    ? 20
    : 0;
}

/** One floating menu for commands, Skills and Agents; references remain part of the draft. */
export function useCommandSuggestions(
  value: string,
  onChange: (value: string) => void,
  commands?: ComposerCommands,
  resources?: ComposerResources,
  editableRef?: RefObject<HTMLDivElement | null>,
) {
  const id = useId();
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string>();
  const [cursor, setCursor] = useState(value.length);
  const [argumentsResult, setArgumentsResult] = useState<{
    text: string;
    items: readonly SlashArgumentCandidate[];
  }>();
  const [replacement, setReplacement] = useState<Candidate>();
  const listRef = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!editableRef?.current) return;
    const editable = editableRef.current.querySelector<HTMLElement>('[contenteditable="true"]');
    if (editable) {
      restoreReferenceTokens(editable, onChange);
      if (pendingCaret.current !== undefined) {
        placeComposerCaret(editable, pendingCaret.current);
        pendingCaret.current = undefined;
      }
    }
  }, [value, editableRef, onChange]);
  useEffect(() => {
    const update = () => {
      const editable = editableRef?.current?.querySelector<HTMLElement>('[contenteditable="true"]'),
        selection = window.getSelection();
      if (!editable || !selection?.rangeCount || !editable.contains(selection.anchorNode)) return;
      const range = selection.getRangeAt(0).cloneRange();
      range.selectNodeContents(editable);
      range.setEnd(selection.anchorNode!, selection.anchorOffset);
      setCursor(serializeComposerNode(range.cloneContents()).length);
    };
    document.addEventListener("selectionchange", update);
    update();
    return () => document.removeEventListener("selectionchange", update);
  }, [value, editableRef]);
  const before = value.slice(0, editableRef ? cursor : value.length);
  const resourceMatch = /(?:^|\s)\/(skill|agent)\s+([^\n/]*)$/u.exec(before);
  const simpleMatch = /(?:^|\s)\/([^\s/[\]]*)$/u.exec(before);
  const commandMatch = /^\/([\w?:-]*)(\s+[^\n]*)?$/u.exec(value);
  const name = commandMatch?.[1]?.toLowerCase() ?? "";
  const hasArguments = commandMatch?.[2] !== undefined;
  const knownArguments =
    hasArguments && commands?.catalog.some((item) => [item.name, ...item.aliases].includes(name));
  const match = simpleMatch ?? (!knownArguments ? /(?:^|\s)\/([^\n/[\]]*)$/u.exec(before) : null);
  const query = resourceMatch?.[2] ?? match?.[1] ?? "";
  const mode = resourceMatch?.[1];
  const start = resourceMatch
    ? before.lastIndexOf(`/${mode} `)
    : match
      ? before.lastIndexOf("/")
      : 0;
  const primary = start === 0 && Boolean(match);
  const parsed = parseComposerDraft(value);
  useEffect(() => {
    setIndex(0);
    setReplacement(undefined);
    if (!commands || !commandMatch || !hasArguments || mode) return;
    let stale = false;
    void commands
      .complete(value)
      .then((items) => {
        if (!stale) setArgumentsResult({ text: value, items });
      })
      .catch(() => {
        if (!stale) setArgumentsResult({ text: value, items: [] });
      });
    return () => {
      stale = true;
    };
  }, [commands, value, hasArguments, Boolean(commandMatch), mode]);
  const items: Candidate[] = [];
  if (primary && commands && !mode) {
    items.push(
      ...commands.catalog
        .filter((item) => query || (item.tier === "primary" && !item.disabled))
        .filter((item) =>
          [item.name, ...item.aliases].some((token) =>
            score(
              token,
              `${commandTitles[item.name] ?? ""} ${commandDescriptions[item.name] ?? ""} ${item.description}`,
              query,
            ),
          ),
        )
        .map((item) => ({
          label: `/${item.name}`,
          description:
            item.disabledReason ??
            `${item.tier === "advanced" ? "高级 · " : ""}${commandDescriptions[item.name] ?? item.description}`,
          text: `/${item.insertText} `,
          disabled: item.disabled ?? false,
          group: "命令",
          commandName: item.name,
        })),
    );
  } else if (commands && commandMatch && hasArguments && !mode) {
    items.push(
      ...(argumentsResult?.text === value ? argumentsResult.items : []).map((item) => ({
        label: item.label ?? item.value,
        description: item.description ?? "",
        text: `/${name} ${item.insertText ?? item.value} `,
        disabled: false,
        group: "参数",
      })),
    );
  }
  if ((match || resourceMatch) && resources) {
    if (mode !== "agent")
      items.push(
        ...resources.skills
          .filter(
            (skill) =>
              !parsed.references.some(
                (ref) => ref.kind === "skill" && normalized(ref.name) === normalized(skill.name),
              ),
          )
          .map((skill) => ({ skill, rank: score(skill.name, skill.description, query) }))
          .filter((item) => item.rank > 0)
          .sort((a, b) => b.rank - a.rank)
          .map(({ skill }) => {
            const reference: ComposerReference = {
              kind: "skill",
              name: skill.name,
              ...(skill.sourceId ? { sourceId: skill.sourceId } : {}),
              ...(skill.sourcePath ? { sourcePath: skill.sourcePath } : {}),
            };
            return {
              label: skill.name,
              description: skill.description,
              reference,
              text: referenceValue(reference),
              disabled: false,
              group: "Skills",
            };
          }),
      );
    if (mode === "agent")
      items.push(
        ...resources.agents
          .map((agent) => ({ agent, rank: score(agent.name, agent.description, query) }))
          .filter((item) => item.rank > 0)
          .sort((a, b) => b.rank - a.rank)
          .map(({ agent }) => {
            const reference: ComposerReference = {
              kind: "agent",
              name: agent.name,
              ...(agent.subagentId ? { subagentId: agent.subagentId } : {}),
            };
            return {
              label: agent.name,
              description: agent.description,
              reference,
              text: referenceValue(reference),
              disabled: false,
              group: "Agents",
            };
          }),
      );
  }
  const menuKey = `${value}:${cursor}`;
  const open = (items.length > 0 || Boolean(resources && mode)) && dismissed !== menuKey;
  const selected = Math.min(index, Math.max(items.length - 1, 0));
  useEffect(() => {
    if (open)
      listRef.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
  }, [selected, open]);
  useEffect(() => {
    const editable = editableRef?.current?.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!editable) return;
    editable.setAttribute("role", open ? "combobox" : "textbox");
    editable.setAttribute("aria-expanded", String(open));
    if (open) {
      editable.setAttribute("aria-controls", id);
      editable.setAttribute("aria-activedescendant", `${id}-${selected}`);
    } else {
      editable.removeAttribute("aria-controls");
      editable.removeAttribute("aria-activedescendant");
    }
  }, [open, selected, id, editableRef]);
  function accept(position: number, replace = false) {
    const item = items[position];
    if (!item || item.disabled) return;
    if (
      item.reference &&
      !replace &&
      parsed.references.some((ref) => ref.kind === "agent" || item.reference?.kind === "agent")
    ) {
      setReplacement(item);
      return;
    }
    let next = item.reference
      ? `${value.slice(0, start)}${item.text} ${value.slice(before.length)}`
      : item.text;
    if (replace)
      next = next.replace(/\/\[(skill|agent):[^\]\n]+\]/gu, (marker) =>
        marker === item.text ? marker : "",
      );
    pendingCaret.current = replace || !item.reference ? next.length : start + item.text.length + 1;
    onChange(next);
    setCursor(pendingCaret.current);
    setDismissed(`${next}:${pendingCaret.current}`);
    setReplacement(undefined);
    editableRef?.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
  }
  return {
    inputProps: {
      ref: editableRef,
      role: open ? "combobox" : "textbox",
      "aria-expanded": open ? true : undefined,
      "aria-controls": open ? id : undefined,
      "aria-activedescendant": open ? `${id}-${selected}` : undefined,
      "aria-autocomplete": "list" as const,
    },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (!open || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(menuKey);
        setReplacement(undefined);
        return true;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!items.length) return true;
        setIndex((selected + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
        return true;
      }
      const exactCommand = primary
        ? commands?.catalog.find((item) =>
            [item.name, ...item.aliases].includes(query.toLowerCase()),
          )
        : undefined;
      const exact = Boolean(exactCommand || (primary && desktopCommandPolicy(query.toLowerCase())));
      if (
        event.key === "Tab" ||
        (event.key === "Enter" && !event.shiftKey && (!exact || exactCommand?.disabled))
      ) {
        event.preventDefault();
        if (!replacement) accept(selected);
        return true;
      }
      return false;
    },
    menu: open ? (
      <div className="command-suggestions">
        <div
          className="command-suggestions__list"
          role="listbox"
          aria-label="命令与技能"
          id={id}
          ref={listRef}
        >
          {!items.length && (
            <p>没有可用的{mode === "agent" ? "子代理" : "技能"}，请先添加或调整搜索。</p>
          )}
          {replacement ? (
            <div className="composer-replacement" role="status">
              <span>
                替换已选上下文为 {replacement.reference?.kind === "agent" ? "Agent" : "Skill"}{" "}
                {replacement.label}？正文会保留。
              </span>
              <button
                type="button"
                onClick={() =>
                  accept(
                    items.findIndex((item) => item.text === replacement.text),
                    true,
                  )
                }
              >
                替换上下文
              </button>
              <button type="button" onClick={() => setReplacement(undefined)}>
                取消
              </button>
            </div>
          ) : (
            [...new Set(items.map((item) => item.group))].map((group) => (
              <div key={group} role="group" aria-label={group}>
                <div className="command-suggestions__group-label" aria-hidden="true">
                  {group}
                </div>
                {items.map((item, position) => {
                  if (item.group !== group) return null;
                  return (
                    <div
                      key={`${item.group}:${item.label}`}
                      id={`${id}-${position}`}
                      role="option"
                      aria-selected={position === selected}
                      aria-disabled={item.disabled}
                      data-command={item.commandName}
                      data-group={item.group}
                      onMouseMove={() => setIndex(position)}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        accept(position);
                      }}
                    >
                      <CommandIcon
                        className="command-suggestions__icon"
                        name={candidateIcon(item)}
                      />
                      <div className="command-suggestions__text">
                        <div className="command-suggestions__name">
                          <strong>
                            {item.commandName
                              ? (commandTitles[item.commandName] ?? item.label)
                              : item.label}
                          </strong>
                          {item.commandName && (
                            <span className="command-suggestions__token">{item.label}</span>
                          )}
                        </div>
                        <span className="command-suggestions__description">{item.description}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="command-suggestions__hint" aria-hidden="true">
          ↑ ↓ 选择 · Tab / Enter 确认 · Esc 收起
        </div>
      </div>
    ) : null,
  };
}
