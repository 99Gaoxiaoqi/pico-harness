import type { CatalogSkillView, CatalogAgentView } from "../model.js";

export interface ComposerReference {
  readonly kind: "skill" | "agent";
  readonly name: string;
  readonly sourceId?: string;
  readonly sourcePath?: string;
  readonly subagentId?: string;
}
const MARKER = /\/\[(skill|agent):([^\]\n]+)\]/gu;
export const referenceValue = (reference: ComposerReference): string =>
  `/[${reference.kind}:${encodeURIComponent(JSON.stringify(reference))}]`;
export function parseComposerDraft(value: string) {
  const references: ComposerReference[] = [];
  const text = value.replace(MARKER, (marker, kind: string, encoded: string) => {
    try {
      const reference = JSON.parse(decodeURIComponent(encoded)) as ComposerReference;
      if (reference.kind !== kind || typeof reference.name !== "string" || !reference.name)
        return marker;
      references.push(reference);
      return "";
    } catch {
      return marker;
    }
  });
  return { text: text.replace(/\u00a0/gu, " ").trim(), references };
}
export function validateComposerReferences(
  references: readonly ComposerReference[],
  skills: readonly CatalogSkillView[],
  agents: readonly CatalogAgentView[],
): string | undefined {
  if (references.length > 16) return "最多选择 16 个技能。";
  if (references.some((ref) => ref.kind === "agent") && references.length !== 1)
    return "一个消息只能选择一个 Agent；请先移除其他上下文。";
  for (const ref of references) {
    if (ref.kind === "skill") {
      const skill = skills.find(
        (item) =>
          item.name.normalize("NFKC").toLowerCase() === ref.name.normalize("NFKC").toLowerCase(),
      );
      if (
        !skill ||
        (ref.sourceId !== undefined && skill.sourceId !== ref.sourceId) ||
        (ref.sourcePath !== undefined && skill.sourcePath !== ref.sourcePath)
      )
        return `Skill ${ref.name} 已移除或来源已变化，请重新选择。`;
    } else if (
      !agents.some((item) => item.name === ref.name && item.subagentId === ref.subagentId)
    ) {
      return `Agent ${ref.name} 已不可用，请重新选择。`;
    }
  }
  return undefined;
}

/** Restore library-compatible atomic tokens after draft/session changes. */
export function restoreReferenceTokens(editable: HTMLElement, onChange: (value: string) => void) {
  const selection = window.getSelection();
  const focused = document.activeElement === editable;
  const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest("[data-astryx-token]")) nodes.push(node);
  }
  let changed = false;
  for (const node of nodes) {
    const value = node.textContent ?? "";
    const matches = [...value.matchAll(MARKER)];
    if (!matches.length) continue;
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      const ref = parseComposerDraft(match[0]).references[0];
      if (!ref) continue;
      fragment.append(value.slice(offset, match.index));
      const token = document.createElement("span");
      token.contentEditable = "false";
      token.className = "composer-reference";
      token.setAttribute("data-astryx-token", "");
      token.setAttribute("data-astryx-token-value", match[0]);
      token.append(`${ref.kind === "skill" ? "Skill" : "Agent"}: ${ref.name}`);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute(
        "aria-label",
        `移除 ${ref.kind === "skill" ? "Skill" : "Agent"} ${ref.name}`,
      );
      remove.addEventListener("mousedown", (event) => event.preventDefault());
      remove.addEventListener("click", () => {
        token.remove();
        onChange(serializeComposerNode(editable));
      });
      token.append(remove);
      fragment.append(token);
      offset = match.index + match[0].length;
      changed = true;
    }
    fragment.append(value.slice(offset));
    node.replaceWith(fragment);
  }
  if (changed && focused && selection) {
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}
export function serializeComposerNode(node: Node): string {
  let text = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
    else if (child instanceof HTMLElement) {
      if (child.hasAttribute("data-astryx-token"))
        text += child.getAttribute("data-astryx-token-value") ?? "";
      else if (child.tagName === "BR") text += "\n";
      else {
        if ((child.tagName === "DIV" || child.tagName === "P") && text && !text.endsWith("\n"))
          text += "\n";
        text += serializeComposerNode(child);
      }
    }
  }
  return text;
}
