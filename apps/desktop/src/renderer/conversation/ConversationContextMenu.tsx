import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Bot, Search, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogAgentView, CatalogSkillView } from "../model.js";

export function ConversationContextMenu({
  skills,
  agents,
  onSelect,
  onClose,
}: {
  readonly skills: readonly CatalogSkillView[];
  readonly agents: readonly CatalogAgentView[];
  readonly onSelect: (activation: {
    readonly kind: "skill" | "agent";
    readonly name: string;
    readonly subagentId?: string;
  }) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const entries = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [
      ...skills.map((skill) => ({
        kind: "skill" as const,
        name: skill.name,
        subagentId: undefined,
        description: skill.description,
      })),
      ...agents.map((agent) => ({
        kind: "agent" as const,
        name: agent.name,
        subagentId: agent.subagentId,
        description: agent.description,
      })),
    ].filter(
      (entry) =>
        !needle ||
        entry.name.toLocaleLowerCase().includes(needle) ||
        entry.description.toLocaleLowerCase().includes(needle),
    );
  }, [agents, query, skills]);

  return (
    <section className="conversation-context-menu" aria-label="添加上下文">
      <header>
        <div>
          <strong>添加上下文</strong>
          <span>选择 Skill 或子代理</span>
        </div>
        <Button
          label="关闭上下文菜单"
          isIconOnly
          icon={<X aria-hidden="true" />}
          variant="ghost"
          size="sm"
          onClick={onClose}
        />
      </header>
      <div className="conversation-context-search">
        <TextInput
          label="搜索 Skill 或子代理"
          isLabelHidden
          startIcon={<Search aria-hidden="true" />}
          ref={inputRef}
          value={query}
          placeholder="搜索名称或说明"
          onChange={setQuery}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "Enter" && entries[0]) onSelect(entries[0]);
          }}
        />
      </div>
      <div className="conversation-context-results">
        {entries.length === 0 ? (
          <p>没有匹配的上下文。</p>
        ) : (
          entries.map((entry) => (
            <Button
              label={entry.name}
              variant="ghost"
              key={`${entry.kind}:${entry.subagentId ?? entry.name}`}
              onClick={() => onSelect(entry)}
              icon={
                entry.kind === "skill" ? (
                  <WandSparkles aria-hidden="true" />
                ) : (
                  <Bot aria-hidden="true" />
                )
              }
              endContent={<em>{entry.kind === "skill" ? "Skill" : "Agent"}</em>}
            >
              <span>
                <strong>{entry.name}</strong>
                <small>{entry.description}</small>
              </span>
            </Button>
          ))
        )}
      </div>
    </section>
  );
}
