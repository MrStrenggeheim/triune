// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
interface Page<Item> {
  items: Item[];
  hasMore: boolean;
}

/** Continue a long gap over bounded passes without replacing the reader's window. */
export class SnapshotBackfill<Item extends { id: string }> {
  private pending: Page<Item> | null = null;

  async read(
    latest: Page<Item>,
    anchors: ReadonlySet<string>,
    readOlder: (cursor: string) => Promise<Page<Item>>,
    current: () => boolean,
    maxPages: number,
  ): Promise<Page<Item> & { complete: boolean }> {
    let page = this.pending ?? latest;
    if (this.pending) {
      const seen = new Set(page.items.map((item) => item.id));
      // Disjoint newest pages belong to the next pass, after this gap is complete.
      if (latest.items.some((item) => seen.has(item.id)))
        page = {
          ...page,
          items: [...page.items, ...latest.items.filter((item) => !seen.has(item.id))],
        };
    }
    let complete =
      !anchors.size || !page.hasMore || page.items.some((item) => anchors.has(item.id));
    /* eslint-disable no-await-in-loop -- Every page depends on the previous cursor. */
    for (let count = 1; !complete && count < maxPages && current(); count++) {
      const cursor = page.items[0]?.id;
      if (!cursor) break;
      let older: Page<Item>;
      try {
        older = await readOlder(cursor);
      } catch (error) {
        this.pending = null;
        throw error;
      }
      if (!current()) return { ...page, complete: false };
      if (!older.items.length) break;
      const seen = new Set(page.items.map((item) => item.id));
      page = {
        items: [...older.items.filter((item) => !seen.has(item.id)), ...page.items],
        hasMore: older.hasMore,
      };
      complete = !page.hasMore || older.items.some((item) => anchors.has(item.id));
      if (page.items[0]?.id === cursor) break;
    }
    /* eslint-enable no-await-in-loop */
    if (current()) this.pending = complete ? null : page;
    return { ...page, complete };
  }
}
