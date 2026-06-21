'use client';

import { useEffect, useMemo, useState } from 'react';
import { type PageResult, paginate } from '@/lib/paginate';

export interface UsePagination<T> extends PageResult<T> {
  setPage: (p: number) => void;
}

/**
 * Client-side pagination over an in-memory array. Pass a `resetKey` (e.g. the
 * active filter/client id) to jump back to page 1 when the underlying list is
 * swapped — without resetting on every incidental re-render or data refresh.
 */
export function usePagination<T>(
  items: readonly T[],
  pageSize = 20,
  resetKey?: unknown,
): UsePagination<T> {
  const [page, setPage] = useState(1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the caller's key changes.
  useEffect(() => {
    setPage(1);
  }, [resetKey]);

  const result = useMemo(() => paginate(items, page, pageSize), [items, page, pageSize]);
  return { ...result, setPage };
}
