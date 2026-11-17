// Modified for Triune.
import { ContentSkeleton } from "@/components/ui/loading";

export function PageLoading({ label = "Loading Triune…" }: { label?: string }) {
  return (
    <div className="flex min-h-screen flex-col bg-background p-6" aria-busy="true">
      <ContentSkeleton label={label} rows={6} className="mx-auto max-w-4xl" />
    </div>
  );
}
