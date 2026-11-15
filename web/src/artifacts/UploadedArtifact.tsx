// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useQuery } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";
import { downloadBlob } from "@/lib/explorerOperations";
import { useViewerId } from "@/hooks/useViewerId";
import { Button } from "@/components/ui/button";
import { ArtifactFrame } from "./ArtifactFrame";
import type { ArtifactReference } from "./artifactProtocol";

/** File identity stays scoped to its source chat; the server authorizes metadata and original bytes. */
export function UploadedArtifact({
  sessionId,
  reference,
}: {
  sessionId: string | null;
  reference: ArtifactReference;
}) {
  const viewerId = useViewerId();
  const resource = useQuery({
    queryKey: ["inline-artifact", viewerId, sessionId, reference.file_id],
    enabled: !!viewerId && !!sessionId,
    retry: false,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const base = `/v1/sessions/${encodeURIComponent(sessionId!)}/resources/files/${encodeURIComponent(reference.file_id)}`;
      const metadata = await authenticatedFetch(base, { signal });
      if (!metadata.ok) throw await apiErrorFromResponse(metadata);
      const file = (await metadata.json()) as {
        name?: string;
        metadata?: { bytes?: number; content_type?: string };
      };
      if ((file.metadata?.bytes ?? 0) > 50 * 1024 * 1024)
        throw new Error("Artifact exceeds the 50 MiB preview limit.");
      const response = await authenticatedFetch(`${base}/content`, { signal });
      if (!response.ok) throw await apiErrorFromResponse(response);
      const blob = await response.blob();
      if (blob.size > 50 * 1024 * 1024)
        throw new Error("Artifact exceeds the 50 MiB preview limit.");
      const filename = file.name || "artifact.html";
      if (
        !/\.html?$/i.test(filename) &&
        !/^(text\/html|application\/xhtml\+xml)(;|$)/i.test(blob.type)
      )
        throw new Error("This artifact reference does not identify an uploaded HTML document.");
      return { html: await blob.text(), blob, filename };
    },
  });
  if (!sessionId) return <p role="alert">This artifact has no source chat.</p>;
  if (resource.error)
    return (
      <div role="alert" className="space-y-2">
        <p>{resource.error.message}</p>
        <Button size="sm" variant="secondary" onClick={() => void resource.refetch()}>
          Retry artifact
        </Button>
      </div>
    );
  if (!resource.data) return <p role="status">Loading artifact…</p>;
  const data = resource.data;
  return (
    <ArtifactFrame
      key={`${sessionId}:${reference.file_id}`}
      identity={`${sessionId}:${reference.file_id}`}
      title={reference.title || data.filename}
      html={data.html}
      onDownload={() => downloadBlob(data.blob, data.filename)}
    />
  );
}
