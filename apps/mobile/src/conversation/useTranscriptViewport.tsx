import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
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
const NEAR_BOTTOM = 96;

/** One owner coordinates reading restoration, older pages and following the streaming footer. */
export function useTranscriptViewport(
  view: TranscriptReplicaView | undefined,
  ready: boolean,
  active: boolean,
  restoreVersion: number,
) {
  const listRef = useRef<FlatList<RecordItem>>(null);
  const alive = useRef(true);
  const state = useRef({ view, ready, active, restoreVersion });
  state.current = { view, ready, active, restoreVersion };
  const [showLatest, setShowLatest] = useState(false);
  const following = useRef(true);
  const dragging = useRef(false);
  const latestPending = useRef(false);
  const paging = useRef(false);
  const frames = useRef(new Map<string, number>());
  const firstVisible = useRef<string | undefined>(undefined);
  const firstRecord = useRef<string | undefined>(undefined);
  const scrollY = useRef(0);
  const layoutHeight = useRef(0);
  const contentHeight = useRef(0);
  const anchor = useRef<Anchor | undefined>(undefined);
  const appliedVersion = useRef(restoreVersion);
  const pending = useRef<
    { itemId: string; index: number; offset: number; attempts: number } | undefined
  >(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stopRestore = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    pending.current = undefined;
  }, []);
  const capture = useCallback(() => {
    const s = state.current;
    if (
      !s.active ||
      !s.ready ||
      following.current ||
      paging.current ||
      pending.current ||
      appliedVersion.current !== s.restoreVersion
    )
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
  const latest = useCallback((animated = false) => {
    if (
      state.current.active &&
      state.current.ready &&
      following.current &&
      !pending.current &&
      !paging.current
    )
      latestPending.current = true;
    if (latestTimer.current) clearTimeout(latestTimer.current);
    latestTimer.current = setTimeout(() => {
      latestTimer.current = undefined;
      const s = state.current;
      if (
        !alive.current ||
        !s.active ||
        !s.ready ||
        !following.current ||
        pending.current ||
        paging.current
      )
        return;
      // scrollToEnd includes overlays/Plan/queue in ListFooterComponent.
      listRef.current?.scrollToEnd({ animated });
    }, 0);
  }, []);
  const restore = useCallback(() => {
    const target = pending.current;
    if (!target || !state.current.ready || !state.current.active || following.current) return;
    const index =
      state.current.view?.records.findIndex((item) => item.itemId === target.itemId) ?? -1;
    if (index < 0) {
      pending.current = undefined;
      appliedVersion.current = state.current.restoreVersion;
      return;
    }
    target.index = index;
    if (timer.current) clearTimeout(timer.current);
    if (++target.attempts > 8) {
      pending.current = undefined;
      appliedVersion.current = state.current.restoreVersion;
      capture();
      return;
    }
    listRef.current?.scrollToIndex({ index, viewOffset: target.offset, animated: false });
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
  const restoreAnchor = useCallback(() => {
    const s = state.current;
    const saved = anchor.current;
    if (!saved || !s.ready || !s.active || following.current) return;
    const current = s.view;
    const sameHistory =
      saved.epoch === current?.watermark?.historyEpoch &&
      saved.projector === current.watermark.projectorVersion;
    if (!sameHistory) {
      anchor.current = undefined;
      stopRestore();
      following.current = true;
      latestPending.current = true;
      setShowLatest(false);
      appliedVersion.current = s.restoreVersion;
      latest();
      return;
    }
    let index = current.records.findIndex((item) => item.itemId === saved.itemId);
    if (index < 0) {
      index = current.records.findIndex(
        (item) =>
          item.positionSequence > saved.sequence ||
          (item.positionSequence === saved.sequence && item.positionOrdinal >= saved.ordinal),
      );
      if (index < 0) index = current.records.length - 1;
    }
    if (index < 0) return;
    pending.current = {
      itemId: current.records[index]!.itemId,
      index,
      offset: saved.offset,
      attempts: 0,
    };
    restore();
  }, [latest, restore, stopRestore]);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (active && ready) {
      if (following.current || !anchor.current) {
        following.current = true;
        latestPending.current = true;
        setShowLatest(false);
        appliedVersion.current = restoreVersion;
        latest();
      } else restoreAnchor();
    }
    return () => {
      stopRestore();
      if (latestTimer.current) clearTimeout(latestTimer.current);
      latestTimer.current = undefined;
    };
  }, [active, ready, restoreVersion, latest, restoreAnchor, stopRestore]);
  const firstId = view?.records[0]?.itemId;
  useLayoutEffect(() => {
    const previous = firstRecord.current;
    firstRecord.current = firstId;
    if (
      previous &&
      previous !== firstId &&
      view?.records.some((item) => item.itemId === previous) &&
      !following.current
    )
      restoreAnchor();
  }, [firstId, view, restoreAnchor]);
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
  function jumpToLatest() {
    if (!state.current.active || !state.current.ready) return;
    stopRestore();
    anchor.current = undefined;
    following.current = true;
    dragging.current = false;
    latestPending.current = true;
    appliedVersion.current = state.current.restoreVersion;
    setShowLatest(false);
    latest(true);
  }
  async function loadOlder(load: () => Promise<void>) {
    if (paging.current || !state.current.ready || !state.current.active) return;
    following.current = false;
    latestPending.current = false;
    stopRestore();
    capture();
    paging.current = true;
    setShowLatest(true);
    try {
      await load();
    } finally {
      paging.current = false;
      if (alive.current && state.current.active && state.current.ready) {
        if (following.current) latest();
        else restoreAnchor();
      }
    }
  }
  return {
    listRef,
    Cell,
    showLatest: active && ready && showLatest,
    jumpToLatest,
    loadOlder,
    onViewableItemsChanged: (items: ViewToken[]) => {
      firstVisible.current = items.find((item) => item.isViewable)?.key;
      capture();
    },
    onLayout: ((event) => {
      layoutHeight.current = event.nativeEvent.layout.height;
      if (following.current) latest();
    }) satisfies NonNullable<FlatListProps<RecordItem>["onLayout"]>,
    onScroll: ((event) => {
      const native = event.nativeEvent;
      scrollY.current = native.contentOffset.y;
      layoutHeight.current = native.layoutMeasurement.height;
      contentHeight.current = native.contentSize.height;
      if (!state.current.ready || pending.current || paging.current) return;
      const near = contentHeight.current - scrollY.current - layoutHeight.current <= NEAR_BOTTOM;
      if (latestPending.current && !near) return;
      latestPending.current = false;
      following.current = near && !dragging.current;
      setShowLatest(!near);
      if (following.current) anchor.current = undefined;
      else capture();
    }) satisfies NonNullable<FlatListProps<RecordItem>["onScroll"]>,
    onScrollBeginDrag: () => {
      dragging.current = true;
      stopRestore();
      if (latestTimer.current) clearTimeout(latestTimer.current);
      latestTimer.current = undefined;
      latestPending.current = false;
      following.current = false;
      appliedVersion.current = state.current.restoreVersion;
      capture();
    },
    onScrollEndDrag: ((event) => {
      dragging.current = false;
      // Momentum still owns the viewport until its end event.
      if (event.nativeEvent.velocity?.y) return;
      const native = event.nativeEvent;
      const near =
        native.contentSize.height - native.contentOffset.y - native.layoutMeasurement.height <=
        NEAR_BOTTOM;
      following.current = near;
      setShowLatest(!near);
      if (near) {
        anchor.current = undefined;
        latest();
      } else capture();
    }) satisfies NonNullable<FlatListProps<RecordItem>["onScrollEndDrag"]>,
    onMomentumScrollBegin: () => {
      dragging.current = true;
      following.current = false;
    },
    onMomentumScrollEnd: ((event) => {
      dragging.current = false;
      const native = event.nativeEvent;
      const near =
        native.contentSize.height - native.contentOffset.y - native.layoutMeasurement.height <=
        NEAR_BOTTOM;
      following.current = near;
      setShowLatest(!near);
      if (near) {
        anchor.current = undefined;
        latest();
      } else capture();
    }) satisfies NonNullable<FlatListProps<RecordItem>["onMomentumScrollEnd"]>,
    onScrollToIndexFailed: ((info) => {
      if (pending.current)
        listRef.current?.scrollToOffset({
          offset: info.averageItemLength * info.index,
          animated: false,
        });
    }) satisfies NonNullable<FlatListProps<RecordItem>["onScrollToIndexFailed"]>,
    onContentSizeChange: ((_width, height) => {
      contentHeight.current = height;
      if (pending.current && !timer.current) restore();
      else if (following.current) latest();
    }) satisfies NonNullable<FlatListProps<RecordItem>["onContentSizeChange"]>,
  };
}
