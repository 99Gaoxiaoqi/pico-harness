const DEFAULT_ESTIMATED_ROW_HEIGHT = 3;
const DEFAULT_OVERSCAN_ROWS = 20;
const DEFAULT_VIRTUALIZE_THRESHOLD = 200;

export interface VirtualTranscriptOptions<T> {
  /** Estimated row height for items without a measured/custom height. */
  estimatedRowHeight?: number;
  /** Extra rows to render before and after the viewport. */
  overscanRows?: number;
  /** Item count at or below which virtualization is disabled. */
  virtualizeThreshold?: number;
  /** Render the final window regardless of scrollOffsetRows. */
  scrollToBottom?: boolean;
  /** Optional per-item row estimate. */
  getItemRows?: (item: T, index: number) => number | undefined;
}

export interface VirtualTranscriptWindow<T> {
  /** Visible slice after applying viewport and overscan. */
  visibleItems: T[];
  /** Inclusive start index of visibleItems in the original items array. */
  startIndex: number;
  /** Exclusive end index of visibleItems in the original items array. */
  endIndex: number;
  /** Estimated rows represented by the spacer before visibleItems. */
  topSpacerRows: number;
  /** Estimated rows represented by the spacer after visibleItems. */
  bottomSpacerRows: number;
  /** Rows skipped inside the first visible item. */
  startOffsetRows: number;
}

export function computeVirtualTranscript<T>(
  items: readonly T[],
  viewportRows: number,
  scrollOffsetRows: number,
  options: VirtualTranscriptOptions<T> = {},
): VirtualTranscriptWindow<T> {
  const threshold = normalizeNonNegativeInteger(
    options.virtualizeThreshold,
    DEFAULT_VIRTUALIZE_THRESHOLD,
  );

  if (items.length <= threshold) {
    return {
      visibleItems: items.slice(),
      startIndex: 0,
      endIndex: items.length,
      topSpacerRows: 0,
      bottomSpacerRows: 0,
      startOffsetRows: 0,
    };
  }

  const estimatedRowHeight = normalizePositiveInteger(
    options.estimatedRowHeight,
    DEFAULT_ESTIMATED_ROW_HEIGHT,
  );
  const viewport = normalizePositiveInteger(viewportRows, 1);
  const overscan = normalizeNonNegativeInteger(options.overscanRows, DEFAULT_OVERSCAN_ROWS);
  const itemRows = buildItemRows(items, estimatedRowHeight, options.getItemRows);
  const offsets = buildOffsets(itemRows);
  const totalRows = offsets[offsets.length - 1] ?? 0;
  const windowRows = viewport + overscan * 2;
  const scrollOffset = normalizeNonNegativeInteger(scrollOffsetRows, 0);
  const windowTop = options.scrollToBottom
    ? Math.max(0, totalRows - windowRows)
    : Math.max(0, scrollOffset - overscan);
  const windowBottom = options.scrollToBottom
    ? totalRows
    : Math.min(totalRows, scrollOffset + viewport + overscan);
  const startIndex = findStartIndex(offsets, windowTop);
  const endIndex = Math.max(startIndex, findEndIndex(offsets, windowBottom));

  return {
    visibleItems: items.slice(startIndex, endIndex),
    startIndex,
    endIndex,
    topSpacerRows: offsets[startIndex] ?? 0,
    bottomSpacerRows: totalRows - (offsets[endIndex] ?? totalRows),
    startOffsetRows: Math.max(0, windowTop - (offsets[startIndex] ?? 0)),
  };
}

function buildItemRows<T>(
  items: readonly T[],
  estimatedRowHeight: number,
  getItemRows: ((item: T, index: number) => number | undefined) | undefined,
): number[] {
  return items.map((item, index) => {
    const itemRows = getItemRows?.(item, index);
    if (itemRows !== undefined && Number.isFinite(itemRows) && itemRows >= 0) {
      return Math.ceil(itemRows);
    }
    return estimatedRowHeight;
  });
}

function buildOffsets(itemRows: readonly number[]): number[] {
  const offsets = new Array<number>(itemRows.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < itemRows.length; i++) {
    offsets[i + 1] = (offsets[i] ?? 0) + (itemRows[i] ?? 0);
  }
  return offsets;
}

function findStartIndex(offsets: readonly number[], row: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 1);
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((offsets[mid + 1] ?? 0) <= row) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function findEndIndex(offsets: readonly number[], row: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 1);
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((offsets[mid] ?? 0) < row) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.ceil(value);
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}
