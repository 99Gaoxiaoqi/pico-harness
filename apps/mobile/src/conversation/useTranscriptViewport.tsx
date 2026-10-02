import React, { useCallback, useLayoutEffect, useRef } from "react";
import { FlatList, View, type FlatListProps, type ViewToken } from "react-native";
import type { RuntimeTranscriptItemRecord } from "@pico/protocol/mobile";
import type { TranscriptReplicaView } from "@pico/transcript-replica";

type RecordItem = RuntimeTranscriptItemRecord;
type CellProps = React.ComponentProps<
  NonNullable<FlatListProps<RecordItem>["CellRendererComponent"]>
>;
type Anchor = {
  itemId: string;
  sequence: number;
  ordinal: number;
  offset: number;
  epoch: string;
  projector: number;
};

/** Keeps a reading anchor while the same conversation is hidden or resynchronized. */
export function useTranscriptViewport(
  view: TranscriptReplicaView | undefined,
  ready: boolean,
  active: boolean,
  restoreVersion: number,
) {
  const listRef = useRef<FlatList<RecordItem>>(null);
  const state = useRef({ view, ready, active, restoreVersion });
  state.current = { view, ready, active, restoreVersion };
  const frames = useRef(new Map<string, number>());
  const firstVisible = useRef<string | undefined>(undefined);
  const scrollY = useRef(0);
  const anchor = useRef<Anchor | undefined>(undefined);
  const appliedVersion = useRef(restoreVersion);
  const pending = useRef<
    { itemId: string; index: number; offset: number; attempts: number } | undefined
  >(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const capture = useCallback(() => {
    const s = state.current;
    if (!s.active || !s.ready || pending.current || appliedVersion.current !== s.restoreVersion)
      return;
    const record = s.view?.records.find((item) => item.itemId === firstVisible.current);
    const y = record && frames.current.get(record.itemId);
    const watermark = s.view?.watermark;
    if (!record || y === undefined || !watermark) return;
    anchor.current = {
      itemId: record.itemId,
      sequence: record.positionSequence,
      ordinal: record.positionOrdinal,
      offset: y - scrollY.current,
      epoch: watermark.historyEpoch,
      projector: watermark.projectorVersion,
    };
  }, []);
  const restore = useCallback(() => {
    const target = pending.current;
    if (!target || !state.current.ready || !state.current.active) return;
    const index =
      state.current.view?.records.findIndex((item) => item.itemId === target.itemId) ?? -1;
    if (index < 0) {
      pending.current = undefined;
      appliedVersion.current = state.current.restoreVersion;
      return;
    }
    target.index = index;
    if (timer.current) clearTimeout(timer.current);
    // Virtualized rows need another layout pass after an approximate scroll.
    if (++target.attempts > 8) {
      pending.current = undefined;
      appliedVersion.current = state.current.restoreVersion;
      capture();
      return;
    }
    listRef.current?.scrollToIndex({
      index: target.index,
      viewOffset: target.offset,
      animated: false,
    });
    timer.current = setTimeout(() => {
      timer.current = undefined;
      if (pending.current !== target) return;
      const record = state.current.view?.records[target.index];
      const y = record && frames.current.get(record.itemId);
      if (y !== undefined && Math.abs(y - scrollY.current - target.offset) <= 2) {
        pending.current = undefined;
        appliedVersion.current = state.current.restoreVersion;
        capture();
      } else restore();
    }, 80);
  }, [capture]);
  useLayoutEffect(() => {
    if (active && ready) {
      const saved = anchor.current;
      const current = state.current.view;
      let index = saved
        ? (current?.records.findIndex((item) => item.itemId === saved.itemId) ?? -1)
        : -1;
      if (saved && current?.records.length) {
        const sameHistory =
          saved.epoch === current.watermark?.historyEpoch &&
          saved.projector === current.watermark.projectorVersion;
        if (index < 0 && sameHistory) {
          index = current.records.findIndex(
            (item) =>
              item.positionSequence > saved.sequence ||
              (item.positionSequence === saved.sequence && item.positionOrdinal >= saved.ordinal),
          );
          if (index < 0) index = current.records.length - 1;
        }
        if (index >= 0) {
          pending.current = {
            itemId: current.records[index]!.itemId,
            index,
            offset: saved.offset,
            attempts: 0,
          };
          restore();
        } else {
          anchor.current = undefined;
          listRef.current?.scrollToOffset({ offset: 0, animated: false });
          appliedVersion.current = restoreVersion;
        }
      } else appliedVersion.current = restoreVersion;
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
      pending.current = undefined;
    };
  }, [active, ready, restoreVersion, restore]);
  const Cell = useCallback(
    ({ item, children, style, onLayout, onFocusCapture }: CellProps) => (
      <View
        style={style}
        {...{ onFocusCapture }}
        onLayout={(event) => {
          frames.current.set(item.itemId, event.nativeEvent.layout.y);
          onLayout?.(event);
          capture();
        }}
      >
        {children}
      </View>
    ),
    [capture],
  );
  return {
    listRef,
    Cell,
    onViewableItemsChanged: (items: ViewToken[]) => {
      firstVisible.current = items.find((item) => item.isViewable)?.key;
      capture();
    },
    onScroll: ((event) => {
      scrollY.current = event.nativeEvent.contentOffset.y;
      capture();
    }) satisfies NonNullable<FlatListProps<RecordItem>["onScroll"]>,
    onScrollBeginDrag: () => {
      if (timer.current) clearTimeout(timer.current);
      pending.current = undefined;
      appliedVersion.current = state.current.restoreVersion;
      capture();
    },
    onScrollToIndexFailed: ((info) => {
      listRef.current?.scrollToOffset({
        offset: info.averageItemLength * info.index,
        animated: false,
      });
    }) satisfies NonNullable<FlatListProps<RecordItem>["onScrollToIndexFailed"]>,
    onContentSizeChange: () => {
      if (pending.current && !timer.current) restore();
    },
  };
}
