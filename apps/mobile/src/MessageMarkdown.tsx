import React, { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import type { RuntimeMediaReference } from "@pico/protocol/mobile";
import {
  parseMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
  type MarkdownTextRun,
} from "./markdown";
import { color, s } from "./ui";

export interface MessageMarkdownProps {
  readonly text: string;
  readonly media?: readonly RuntimeMediaReference[];
  readonly renderMedia: (reference: RuntimeMediaReference) => React.ReactNode;
  readonly onLink: (href: string) => void;
}

export function MessageMarkdown({ text, media, renderMedia, onLink }: MessageMarkdownProps) {
  const document = useMemo(() => parseMarkdown(text, media), [text, media]);
  const textRun = (run: MarkdownTextRun, key: number) => (
    <Text
      key={key}
      style={[
        run.strong && styles.strong,
        run.emphasis && styles.emphasis,
        run.strike && styles.strike,
        run.code && styles.inlineCode,
        run.blocked && styles.blocked,
        run.href && styles.link,
      ]}
      accessibilityRole={run.href ? "link" : undefined}
      onPress={run.href ? () => onLink(run.href!) : undefined}
    >
      {run.text}
    </Text>
  );
  const inline = (
    nodes: readonly MarkdownInline[],
    textStyle?: StyleProp<TextStyle>,
  ): React.ReactNode => {
    const parts: React.ReactNode[] = [];
    let runs: MarkdownTextRun[] = [];
    const flush = () => {
      if (!runs.length) return;
      parts.push(
        <Text key={`text-${parts.length}`} selectable style={[s.text, textStyle]}>
          {runs.map(textRun)}
        </Text>,
      );
      runs = [];
    };
    for (const node of nodes) {
      if (node.type === "text") runs.push(node);
      else {
        flush();
        parts.push(
          <View key={`media-${parts.length}`} style={styles.media}>
            {renderMedia(node.reference)}
          </View>,
        );
      }
    }
    flush();
    return <View style={styles.inline}>{parts}</View>;
  };
  const blocks = (nodes: readonly MarkdownBlock[]): React.ReactNode =>
    nodes.map((block, index) => {
      switch (block.type) {
        case "paragraph":
          return <View key={index}>{inline(block.inline)}</View>;
        case "heading":
          return (
            <View key={index} accessibilityRole="header">
              {inline(block.inline, [styles.heading, headingStyles[block.level - 1]])}
            </View>
          );
        case "code":
          return (
            <View key={index} style={styles.code}>
              {!!block.language && <Text style={s.muted}>{block.language}</Text>}
              <ScrollView horizontal>
                <Text selectable style={[s.mono, styles.codeText]}>
                  {block.text}
                </Text>
              </ScrollView>
            </View>
          );
        case "quote":
          return (
            <View key={index} style={styles.quote}>
              {blocks(block.blocks)}
            </View>
          );
        case "list":
          return (
            <View key={index} style={styles.list}>
              {block.items.map((item, itemIndex) => (
                <View key={itemIndex} style={styles.listItem}>
                  <Text
                    style={[s.text, styles.marker, item.checked !== undefined && styles.task]}
                    accessibilityLabel={
                      item.checked === undefined ? undefined : item.checked ? "已完成" : "未完成"
                    }
                  >
                    {item.checked !== undefined
                      ? item.checked
                        ? "☑"
                        : "☐"
                      : block.ordered
                        ? `${block.start + itemIndex}.`
                        : "•"}
                  </Text>
                  <View style={styles.listContent}>{blocks(item.blocks)}</View>
                </View>
              ))}
            </View>
          );
        case "table":
          return (
            <ScrollView key={index} horizontal style={styles.tableScroll}>
              <View style={styles.table}>
                {[block.header, ...block.rows].map((row, rowIndex) => (
                  <View
                    key={rowIndex}
                    style={[styles.tableRow, rowIndex === 0 && styles.tableHeader]}
                  >
                    {row.map((cell, cellIndex) => (
                      <View key={cellIndex} style={styles.cell}>
                        {inline(cell, [
                          { textAlign: block.align[cellIndex] ?? "left" },
                          rowIndex === 0 && styles.strong,
                        ])}
                      </View>
                    ))}
                  </View>
                ))}
              </View>
            </ScrollView>
          );
        case "rule":
          return <View key={index} style={styles.rule} />;
      }
    });
  return <View style={styles.document}>{blocks(document)}</View>;
}

const headingStyles: TextStyle[] = [
  { fontSize: 26, lineHeight: 34 },
  { fontSize: 23, lineHeight: 31 },
  { fontSize: 20, lineHeight: 28 },
  { fontSize: 18, lineHeight: 26 },
  { fontSize: 16, lineHeight: 24 },
  { fontSize: 15, lineHeight: 23 },
];
const styles = StyleSheet.create({
  document: { gap: 12, minWidth: 0 },
  inline: { gap: 8, minWidth: 0 },
  strong: { fontWeight: "600" },
  emphasis: { fontStyle: "italic" },
  strike: { textDecorationLine: "line-through" },
  inlineCode: { fontFamily: s.mono.fontFamily, backgroundColor: color.surface, color: color.muted },
  link: { color: color.accent, textDecorationLine: "underline" },
  blocked: { color: color.faint },
  media: { alignSelf: "stretch", minWidth: 0 },
  heading: { fontWeight: "600", color: color.text },
  code: { gap: 6, padding: 12, borderRadius: 8, backgroundColor: color.surface },
  codeText: { color: color.text, fontSize: 13, lineHeight: 20 },
  quote: { gap: 10, paddingLeft: 12, borderLeftWidth: 3, borderLeftColor: color.lineStrong },
  list: { gap: 7 },
  listItem: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  marker: { minWidth: 22, textAlign: "right" },
  task: { color: color.accent },
  listContent: { flex: 1, gap: 8, minWidth: 0 },
  tableScroll: { borderWidth: 1, borderColor: color.line, borderRadius: 7 },
  table: { flexDirection: "column" },
  tableRow: { flexDirection: "row" },
  tableHeader: { backgroundColor: color.surface },
  cell: {
    width: 170,
    padding: 10,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: color.line,
  },
  rule: { height: 1, backgroundColor: color.line, marginVertical: 4 },
});
