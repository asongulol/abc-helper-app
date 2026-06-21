/**
 * Pure client-side pagination helper (no React, trivially testable). Slices an
 * already-fetched array for display and reports the human "Showing X–Y of Z"
 * range. `page` is clamped into [1, totalPages] so callers can't go out of range.
 */

export interface PageResult<T> {
  pageItems: T[];
  /** The clamped page actually shown. */
  page: number;
  totalPages: number;
  total: number;
  /** 1-based index of the first item shown (0 when empty). */
  from: number;
  /** 1-based index of the last item shown. */
  to: number;
}

export const paginate = <T>(items: readonly T[], page: number, pageSize: number): PageResult<T> => {
  const size = Math.max(1, Math.floor(pageSize) || 1);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const clamped = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (clamped - 1) * size;
  return {
    pageItems: items.slice(start, start + size),
    page: clamped,
    totalPages,
    total,
    from: total === 0 ? 0 : start + 1,
    to: Math.min(start + size, total),
  };
};
