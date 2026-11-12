// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { authenticatedFetch } from "./identity";
import { apiErrorFromResponse } from "./sessionsApi";
import type { WorkbenchWorkspace } from "./workbenchWorkspace";

export type ChatFileLocation =
  | {
      kind: "file" | "directory" | "missing" | "unknown";
      workspace: WorkbenchWorkspace;
      path: string;
    }
  | { kind: "captured"; workspace: WorkbenchWorkspace | null; path: string };
export async function fetchChatFileLocation(
  sessionId: string,
  itemId: string,
  path: string,
  signal?: AbortSignal,
): Promise<ChatFileLocation> {
  const response = await authenticatedFetch(
    `/v1/sessions/${encodeURIComponent(sessionId)}/attachments/references/${encodeURIComponent(itemId)}/metadata?${new URLSearchParams({ path })}`,
    { signal },
  );
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response.json();
}
