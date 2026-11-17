// Modified for Triune.
import { ContentSkeleton } from "@/components/ui/loading";
import { useParams } from "@/lib/routing";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { resolveExtensionPage } from "./catalog";
import { useExtensions, useExtensionsLoading } from "./ExtensionProvider";
import { ExtensionPageHost } from "./ExtensionPageHost";

export function ExtensionPageRoute() {
  const params = useParams<{ extensionId: string; "*": string }>();
  const route = params["*"]?.split("/")[0];
  const extensions = useExtensions();
  const extensionsLoading = useExtensionsLoading();
  const resolved = resolveExtensionPage(extensions, params.extensionId, route);

  if (extensionsLoading) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden pt-14 md:pt-12">
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <ContentSkeleton label="Loading extension…" rows={6} />
        </div>
      </div>
    );
  }

  if (!resolved) return <NotFoundPage />;

  return <ExtensionPageHost resolved={resolved} />;
}
