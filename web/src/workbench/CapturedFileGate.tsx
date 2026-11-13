// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { useEffect, useRef, type ReactNode } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import type { AttachmentPreviewRequest } from "@/components/ChatAttachment";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { authenticatedFetch } from "@/lib/identity";
import { toast } from "@/lib/notifications";
import { apiErrorFromResponse } from "@/lib/sessionsApi";
import { resourceViewStorageScope } from "@/lib/resourceViewStorage";

export function capturedFileQuery(request: AttachmentPreviewRequest) {
  return queryOptions({
    queryKey: [
      "chat-reference-capture",
      resourceViewStorageScope(),
      request.sessionId,
      request.itemId,
      request.reference,
    ],
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }) => {
      if (!request.itemId || !request.reference) throw new Error("Original file reference missing");
      const url = `/v1/sessions/${encodeURIComponent(request.sessionId)}/attachments/references/${encodeURIComponent(request.itemId)}/capture?${new URLSearchParams({ path: request.reference })}`;
      const response = await authenticatedFetch(url, { method: "POST", signal });
      if (!response.ok) throw await apiErrorFromResponse(response);
      return response.json();
    },
  });
}

/** Show the tab immediately; retain its original before enabling the live editor. */
export function CapturedFileGate({
  request,
  children,
}: {
  request: AttachmentPreviewRequest;
  children: ReactNode;
}) {
  const capture = useQuery(capturedFileQuery(request));
  const notified = useRef<unknown>(null);
  useEffect(() => {
    if (capture.error && notified.current !== capture.error) {
      notified.current = capture.error;
      toast.error("Could not prepare file", { description: String(capture.error) });
    }
  }, [capture.error]);
  if (capture.isSuccess) return children;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-sm text-muted-foreground">
      {capture.isError ? (
        <>
          <p>Could not prepare file.</p>
          <Button variant="outline" size="sm" onClick={() => void capture.refetch()}>
            Retry
          </Button>
        </>
      ) : (
        <div role="status" className="flex items-center gap-2">
          <Spinner aria-hidden />
          Preparing file…
        </div>
      )}
    </div>
  );
}
