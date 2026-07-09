import { describe, expect, it } from "vitest";
import { computeVirtualTranscript } from "../../src/tui/virtual-transcript.js";

describe("computeVirtualTranscript", () => {
  it("returns a small viewport-sized window for a long transcript", () => {
    const items = makeItems(1000);

    const result = computeVirtualTranscript(items, 20, 300, {
      estimatedRowHeight: 2,
      overscanRows: 4,
    });

    expect(result.startIndex).toBe(148);
    expect(result.endIndex).toBe(162);
    expect(result.visibleItems).toEqual(items.slice(148, 162));
    expect(result.topSpacerRows).toBe(296);
    expect(result.bottomSpacerRows).toBe(1676);
  });

  it("extends the visible window by overscan rows on both sides", () => {
    const items = makeItems(1000);

    const withoutOverscan = computeVirtualTranscript(items, 20, 300, {
      estimatedRowHeight: 2,
      overscanRows: 0,
    });
    const withOverscan = computeVirtualTranscript(items, 20, 300, {
      estimatedRowHeight: 2,
      overscanRows: 6,
    });

    expect(withoutOverscan.startIndex).toBe(150);
    expect(withoutOverscan.endIndex).toBe(160);
    expect(withOverscan.startIndex).toBe(147);
    expect(withOverscan.endIndex).toBe(163);
  });

  it("returns all items for small transcripts", () => {
    const items = makeItems(12);

    const result = computeVirtualTranscript(items, 5, 20, {
      estimatedRowHeight: 2,
      overscanRows: 4,
      virtualizeThreshold: 200,
    });

    expect(result.startIndex).toBe(0);
    expect(result.endIndex).toBe(12);
    expect(result.visibleItems).toEqual(items);
    expect(result.topSpacerRows).toBe(0);
    expect(result.bottomSpacerRows).toBe(0);
  });

  it("returns the final window when scrolling to bottom", () => {
    const items = makeItems(1000);

    const result = computeVirtualTranscript(items, 20, 0, {
      estimatedRowHeight: 2,
      overscanRows: 4,
      scrollToBottom: true,
    });

    expect(result.startIndex).toBe(986);
    expect(result.endIndex).toBe(1000);
    expect(result.visibleItems).toEqual(items.slice(986));
    expect(result.topSpacerRows).toBe(1972);
    expect(result.bottomSpacerRows).toBe(0);
  });

  it("reports the row offset when the viewport starts inside a tall item", () => {
    const items = ["old", "streaming"];

    const result = computeVirtualTranscript(items, 5, 0, {
      estimatedRowHeight: 2,
      getItemRows: (_item, index) => (index === 1 ? 20 : 2),
      overscanRows: 0,
      scrollToBottom: true,
      virtualizeThreshold: 0,
    });

    expect(result.visibleItems).toEqual(["streaming"]);
    expect(result.startIndex).toBe(1);
    expect(result.startOffsetRows).toBe(15);
    expect(result.bottomSpacerRows).toBe(0);
  });
});

function makeItems(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `message-${i}`);
}
