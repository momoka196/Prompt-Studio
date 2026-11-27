import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface UseVirtualGridOptions {
  itemCount: number;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  gridContainerRef: React.RefObject<HTMLElement | null>;
  enabled: boolean;
  estimatedRowHeight?: number;
  rowGap?: number;
  overscanRows?: number;
  resetKey?: string;
  layoutKey?: string;
}

export interface VirtualGridResult {
  columnCount: 1 | 2 | 3;
  totalRows: number;
  startRow: number;
  endRow: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  totalHeight: number;
  measureRowRef: (rowIndex: number) => (el: HTMLElement | null) => void;
}

function resolveColumnCount(width: number): 1 | 2 | 3 {
  if (width >= 1020) return 3;
  if (width >= 640) return 2;
  return 1;
}

export function useVirtualGrid({
  itemCount,
  scrollContainerRef,
  gridContainerRef,
  enabled,
  estimatedRowHeight = 278,
  rowGap = 14,
  overscanRows = 2,
  resetKey = '',
  layoutKey = '',
}: UseVirtualGridOptions): VirtualGridResult {
  const [columnCount, setColumnCount] = useState<1 | 2 | 3>(() => {
    if (typeof window === 'undefined') return 3;
    return resolveColumnCount(Math.min(window.innerWidth - 64, 1240));
  });

  const measuredHeightsRef = useRef<Map<number, number>>(new Map());
  const rowNodeMapRef = useRef<Map<number, HTMLElement>>(new Map());
  const nodeToRowIndexRef = useRef<WeakMap<Element, number>>(new WeakMap());
  const rowRefCallbacksRef = useRef<Map<number, (el: HTMLElement | null) => void>>(new Map());
  const rowResizeObserverRef = useRef<ResizeObserver | null>(null);
  const firstVisibleRowRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const measureRafIdRef = useRef<number | null>(null);
  const [measureVersion, setMeasureVersion] = useState(0);

  const totalRows = useMemo(
    () => (columnCount > 0 ? Math.ceil(itemCount / columnCount) : 0),
    [itemCount, columnCount]
  );

  const scheduleMeasureVersionBump = useCallback(() => {
    if (measureRafIdRef.current !== null) return;
    measureRafIdRef.current = window.requestAnimationFrame(() => {
      measureRafIdRef.current = null;
      setMeasureVersion((v) => v + 1);
    });
  }, []);

  // 列数或筛选分页重置时清空行高测量缓存
  useEffect(() => {
    measuredHeightsRef.current.clear();
    setMeasureVersion((v) => v + 1);
  }, [columnCount, resetKey]);

  // 列表缩短（例如删卡）时清理越界行高缓存
  useEffect(() => {
    let pruned = false;
    for (const key of measuredHeightsRef.current.keys()) {
      if (key >= totalRows) {
        measuredHeightsRef.current.delete(key);
        pruned = true;
      }
    }
    if (pruned) {
      setMeasureVersion((v) => v + 1);
    }
  }, [totalRows]);

  const rowMetrics = useMemo(() => {
    const offsets = new Float64Array(totalRows + 1);
    const heights = new Float64Array(totalRows);
    let acc = 0;
    for (let r = 0; r < totalRows; r += 1) {
      offsets[r] = acc;
      const h = measuredHeightsRef.current.get(r) ?? estimatedRowHeight;
      heights[r] = h;
      acc += h + (r < totalRows - 1 ? rowGap : 0);
    }
    offsets[totalRows] = acc;
    return { offsets, heights, totalHeight: acc };
    // measureVersion drives recalculation when measuredHeightsRef updates
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalRows, estimatedRowHeight, rowGap, measureVersion]);

  const [range, setRange] = useState<{ startRow: number; endRow: number }>(() => ({
    startRow: 0,
    endRow: totalRows > 0 ? Math.min(totalRows - 1, 5) : -1,
  }));

  const rowMetricsRef = useRef(rowMetrics);
  rowMetricsRef.current = rowMetrics;
  const totalRowsRef = useRef(totalRows);
  totalRowsRef.current = totalRows;

  const computeVisibleRange = useCallback(() => {
    const rowsCount = totalRowsRef.current;
    if (!enabled || rowsCount === 0) {
      setRange((prev) =>
        prev.startRow === 0 && prev.endRow === -1 ? prev : { startRow: 0, endRow: -1 }
      );
      return;
    }

    const scrollEl = scrollContainerRef.current;
    const gridEl = gridContainerRef.current;
    if (!scrollEl) {
      const fallbackEnd = Math.min(rowsCount - 1, 4);
      setRange((prev) =>
        prev.startRow === 0 && prev.endRow === fallbackEnd
          ? prev
          : { startRow: 0, endRow: fallbackEnd }
      );
      return;
    }

    const scrollTop = scrollEl.scrollTop;
    const viewportHeight = scrollEl.clientHeight || 640;
    let gridOffsetTop = 0;
    if (gridEl) {
      const gridRect = gridEl.getBoundingClientRect();
      const scrollRect = scrollEl.getBoundingClientRect();
      gridOffsetTop = Math.max(0, gridRect.top - scrollRect.top + scrollTop);
    }

    const relTop = Math.max(0, scrollTop - gridOffsetTop);
    const relBottom = Math.max(relTop, scrollTop + viewportHeight - gridOffsetTop);

    const { offsets, heights } = rowMetricsRef.current;

    // 二分查找首个底部越过 relTop 的行
    let low = 0;
    let high = rowsCount - 1;
    let firstVisible = rowsCount - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (offsets[mid] + heights[mid] > relTop) {
        firstVisible = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    // 二分查找最后一个顶部进入 relBottom 的行
    low = firstVisible;
    high = rowsCount - 1;
    let lastVisible = firstVisible;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (offsets[mid] <= relBottom) {
        lastVisible = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    firstVisibleRowRef.current = firstVisible;
    const nextStart = Math.max(0, firstVisible - overscanRows);
    const nextEnd = Math.min(rowsCount - 1, lastVisible + overscanRows);

    setRange((prev) =>
      prev.startRow === nextStart && prev.endRow === nextEnd
        ? prev
        : { startRow: nextStart, endRow: nextEnd }
    );
  }, [enabled, gridContainerRef, overscanRows, scrollContainerRef]);

  const scheduleRecompute = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = window.requestAnimationFrame(() => {
      rafIdRef.current = null;
      computeVisibleRange();
    });
  }, [computeVisibleRange]);

  const recordMeasuredRowHeight = useCallback(
    (rowIndex: number, el: HTMLElement) => {
      const measured = Math.round(el.getBoundingClientRect().height);
      if (measured <= 0) return;

      const prev = measuredHeightsRef.current.get(rowIndex);
      const effectivePrev = prev ?? estimatedRowHeight;
      if (Math.abs(measured - effectivePrev) > 1) {
        const delta = measured - effectivePrev;
        measuredHeightsRef.current.set(rowIndex, measured);
        // 若视口上方已滚过的行发生高度修正，补偿 scrollTop 防止回跳
        if (rowIndex < firstVisibleRowRef.current && scrollContainerRef.current) {
          scrollContainerRef.current.scrollTop += delta;
        }
        scheduleMeasureVersionBump();
      } else if (prev === undefined) {
        measuredHeightsRef.current.set(rowIndex, measured);
      }
    },
    [estimatedRowHeight, scheduleMeasureVersionBump, scrollContainerRef]
  );

  // 初始化共享 ResizeObserver 监听可见行高度变化（处理删卡移位或窄屏折行）
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const rowIndex = nodeToRowIndexRef.current.get(entry.target);
        if (rowIndex !== undefined && entry.target instanceof HTMLElement) {
          recordMeasuredRowHeight(rowIndex, entry.target);
        }
      }
    });
    rowResizeObserverRef.current = ro;
    for (const [rowIndex, el] of rowNodeMapRef.current.entries()) {
      nodeToRowIndexRef.current.set(el, rowIndex);
      ro.observe(el);
    }
    return () => {
      ro.disconnect();
      rowResizeObserverRef.current = null;
    };
  }, [recordMeasuredRowHeight]);

  // 监听滚动容器尺寸与网格宽度（决定列数与可视行范围）
  useEffect(() => {
    if (!enabled) return;
    const scrollEl = scrollContainerRef.current;
    const gridEl = gridContainerRef.current;

    const updateWidthAndRange = () => {
      const targetWidth =
        gridEl?.clientWidth || scrollEl?.clientWidth || window.innerWidth;
      const nextCols = resolveColumnCount(targetWidth);
      setColumnCount((prev) => (prev === nextCols ? prev : nextCols));
      scheduleRecompute();
    };

    updateWidthAndRange();

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        updateWidthAndRange();
      });
      if (scrollEl) resizeObserver.observe(scrollEl);
      if (gridEl) resizeObserver.observe(gridEl);
    }

    const onScroll = () => {
      scheduleRecompute();
    };
    scrollEl?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', updateWidthAndRange);

    return () => {
      scrollEl?.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', updateWidthAndRange);
      resizeObserver?.disconnect();
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (measureRafIdRef.current !== null) {
        window.cancelAnimationFrame(measureRafIdRef.current);
        measureRafIdRef.current = null;
      }
    };
  }, [enabled, gridContainerRef, scheduleRecompute, scrollContainerRef]);

  // 上方折叠面板/提示条变化、总数或行高测量更新后立即重新对齐可视窗口
  useLayoutEffect(() => {
    computeVisibleRange();
  }, [computeVisibleRange, itemCount, totalRows, measureVersion, resetKey, layoutKey]);

  const measureRowNode = useCallback(
    (rowIndex: number, el: HTMLElement | null) => {
      const prevEl = rowNodeMapRef.current.get(rowIndex);
      if (prevEl && prevEl !== el) {
        rowResizeObserverRef.current?.unobserve(prevEl);
        rowNodeMapRef.current.delete(rowIndex);
      }
      if (!el) return;
      rowNodeMapRef.current.set(rowIndex, el);
      nodeToRowIndexRef.current.set(el, rowIndex);
      rowResizeObserverRef.current?.observe(el);
      recordMeasuredRowHeight(rowIndex, el);
    },
    [recordMeasuredRowHeight]
  );

  const measureRowRef = useCallback(
    (rowIndex: number) => {
      let cb = rowRefCallbacksRef.current.get(rowIndex);
      if (!cb) {
        cb = (el: HTMLElement | null) => {
          measureRowNode(rowIndex, el);
        };
        rowRefCallbacksRef.current.set(rowIndex, cb);
      }
      return cb;
    },
    [measureRowNode]
  );

  const clampedStart =
    totalRows === 0 ? 0 : Math.max(0, Math.min(range.startRow, totalRows - 1));
  const clampedEnd =
    totalRows === 0 ? -1 : Math.max(clampedStart, Math.min(range.endRow, totalRows - 1));

  const topSpacerHeight =
    totalRows > 0 && clampedStart > 0 ? rowMetrics.offsets[clampedStart] : 0;
  const bottomSpacerHeight =
    totalRows > 0 && clampedEnd >= 0 && clampedEnd < totalRows - 1
      ? Math.max(0, rowMetrics.totalHeight - rowMetrics.offsets[clampedEnd + 1])
      : 0;

  return {
    columnCount,
    totalRows,
    startRow: clampedStart,
    endRow: clampedEnd,
    topSpacerHeight,
    bottomSpacerHeight,
    totalHeight: rowMetrics.totalHeight,
    measureRowRef,
  };
}
