import { describe, expect, it } from 'vitest';
import { paginate } from '@/lib/paginate';

const nums = Array.from({ length: 25 }, (_, i) => i + 1); // 1..25

describe('paginate', () => {
  it('slices the requested page and reports the range', () => {
    const r = paginate(nums, 1, 10);
    expect(r.pageItems).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(r).toMatchObject({ page: 1, totalPages: 3, total: 25, from: 1, to: 10 });
  });

  it('handles a partial last page', () => {
    const r = paginate(nums, 3, 10);
    expect(r.pageItems).toEqual([21, 22, 23, 24, 25]);
    expect(r).toMatchObject({ from: 21, to: 25 });
  });

  it('clamps an out-of-range page into [1, totalPages]', () => {
    expect(paginate(nums, 99, 10).page).toBe(3);
    expect(paginate(nums, 0, 10).page).toBe(1);
    expect(paginate(nums, -5, 10).page).toBe(1);
  });

  it('reports an empty list as 1 page, 0 range', () => {
    const r = paginate([], 1, 10);
    expect(r).toMatchObject({ totalPages: 1, total: 0, from: 0, to: 0 });
    expect(r.pageItems).toEqual([]);
  });
});
