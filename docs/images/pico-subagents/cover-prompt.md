# PiCO 子智能体封面生成记录

- 用途：`docs/pico-subagents-technical-guide.md` 的概念封面，不作为精确架构证据。
- 生成方式：Codex 内置 `image_gen`，2026-09-09。
- 成品：`cover.png`。已人工查看生成结果，标题与三个能力场景符合用途。
- 技术事实以正文中的 Mermaid 图和源码为准。

## 最终提示词

```text
Use case: stylized-concept
Asset type: editorial cover illustration for a Chinese technical article about PiCO subagents.
Primary request: create a refined landscape 16:9 cover illustrating one coordinating agent assigning bounded work to three specialist workstations, with durable conversation records and a protected separate workspace.
Style: elegant technical editorial illustration, subtle paper and ceramic material, precise architectural isometric composition, warm off-white background, muted graphite, restrained blue and teal accents, ample negative space, polished and readable at document width.
Composition: a central coordinator desk connected by thin purposeful lines to three smaller workstations: one reading stacked documents with a magnifying glass, one examining a small globe with source cards, one building code blocks inside a distinct outlined workspace. Beside the reading station, show a single archive containing two separate timeline cards to suggest one conversation and multiple runs. A subtle shield at each specialist boundary signifies restricted capabilities. Abstract agent figures or geometric nodes, no human portraits.
Text: only the exact title "PiCO" and subtitle "SUBAGENTS", understated, large and crisp. No other words, no small pseudo-code, no fake UI.
Constraints: conceptual illustration, not a formal architecture diagram. No claimed speed metrics, no nested infinite agents, no robots with faces, no neon, no watermark.
```
