// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ApiError } from "@/lib/sessionsApi";
import { Button } from "@/components/ui/button";
import { fetchStartupInputReceipts, startupInputReceiptKey } from "@/lib/startupInputReceipts";
import { transcriptReaderScope } from "@/lib/transcriptReaderCheckpoint";

export function useStartupInputReceipts(id: string | null, enabled: boolean) {
  const query = useInfiniteQuery({
    queryKey: [...startupInputReceiptKey(id ?? ""), transcriptReaderScope()],
    enabled: !!id && enabled,
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam, signal }) => fetchStartupInputReceipts(id!, pageParam, signal),
    getNextPageParam: (page) => (page.has_more ? page.data.at(-1)?.position : undefined),
    retry: 1,
  });
  const denied = query.error instanceof ApiError && [401, 403, 404].includes(query.error.status);
  const rows = useMemo(
    () => (enabled && !denied ? (query.data?.pages.flatMap((page) => page.data) ?? []) : []),
    [enabled, denied, query.data],
  );
  const control =
    enabled && (query.isError || query.hasNextPage) ? (
      <Button
        size="sm"
        variant="ghost"
        disabled={query.isFetching}
        onClick={() =>
          void (query.isError && !query.isFetchNextPageError
            ? query.refetch()
            : query.fetchNextPage())
        }
      >
        {query.isError ? "Retry loading saved input receipts" : "Load earlier saved inputs"}
      </Button>
    ) : null;
  return { rows, control };
}
