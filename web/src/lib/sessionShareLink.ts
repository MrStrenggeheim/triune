// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { withBasePath } from "./basePath";
import { copyText } from "./clipboard";
import { getOmnigentTransformShareLink } from "./host";

/**
 * The basename-rebased session path turned into an absolute URL. In the embed
 * the host transform returns the full URL (origin included); standalone has no
 * transform, so we prepend the origin ourselves.
 */
export function getShareableLink(sessionId: string, rebasePath: (path: string) => string): string {
  const path = rebasePath(`/c/${sessionId}`);
  const transform = getOmnigentTransformShareLink();
  // Standalone: `rebasePath` is identity, so apply the deployment base path
  // (e.g. `/proxy/6767`) before prepending the origin. The embed supplies its
  // own `transform`, which already includes the host mount path.
  return transform ? transform(path) : `${window.location.origin}${withBasePath(path)}`;
}

export async function copySessionLink(
  sessionId: string,
  rebasePath: (path: string) => string,
): Promise<void> {
  return copyText(getShareableLink(sessionId, rebasePath));
}
