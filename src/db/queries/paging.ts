/**
 * Page a PostgREST select past the server's row cap.
 *
 * PostgREST silently truncates an unbounded select at `max_rows` (1000 by
 * default) — no error, just missing rows. On a query that feeds gross pay that
 * is a silent underpay, so anything unbounded and money-adjacent goes through
 * here instead.
 *
 * `page` is called with each `.range(from, to)` window until a page comes back
 * empty. Each step advances by the number of rows ACTUALLY returned, not by
 * `size`, so this stays correct when the server's cap is lower than the page
 * size we ask for — the caller never has to know the deployed `max_rows`.
 */
export const selectAll = async <T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
  size = 1000,
): Promise<T[]> => {
  const out: T[] = [];
  // ponytail: 200 pages (≥200k rows) is a runaway backstop, not a real ceiling —
  // raise it if a single company's period ever legitimately gets that big.
  for (let p = 0, from = 0; p < 200; p++) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length === 0) return out;
    from += rows.length;
  }
  throw new Error(`${label}: paging did not terminate (over 200 pages).`);
};
