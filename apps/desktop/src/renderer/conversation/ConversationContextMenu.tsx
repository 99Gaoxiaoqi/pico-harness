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
        description: skill.description,
      })),
      ...agents.map((agent) => ({
        kind: "agent" as const,
        name: agent.name,
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
        <button type="button" onClick={onClose} aria-label="关闭上下文菜单">
          <X aria-hidden="true" />
        </button>
      </header>
      <label className="conversation-context-search">
        <Search aria-hidden="true" />
        <span className="conversation-sr-only">搜索 Skill 或子代理</span>
        <input
          ref={inputRef}
          value={query}
          placeholder="搜索名称或说明"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "Enter" && entries[0]) onSelect(entries[0]);
          }}
        />
      </label>
      <div className="conversation-context-results">
        {entries.length === 0 ? (
          <p>没有匹配的上下文。</p>
        ) : (
          entries.map((entry) => (
            <button
              type="button"
              key={`${entry.kind}:${entry.name}`}
              onClick={() => onSelect(entry)}
            >
              {entry.kind === "skill" ? (
                <WandSparkles aria-hidden="true" />
              ) : (
                <Bot aria-hidden="true" />
              )}
              <span>
                <strong>{entry.name}</strong>
                <small>{entry.description}</small>
              </span>
              <em>{entry.kind === "skill" ? "Skill" : "Agent"}</em>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
