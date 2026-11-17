// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { lazy, Suspense, type ComponentProps } from "react";
import { ChunkLoadErrorBoundary } from "@/components/ChunkLoadErrorBoundary";
import { ContentSkeleton } from "@/components/ui/loading";

const PullRequestPanel = lazy(() =>
  import("./PullRequestPanel").then((module) => ({ default: module.PullRequestPanel })),
);

/** Share one lazy identity across the dock, legacy rail and mobile drawer. */
export function LazyPullRequestPanel(props: ComponentProps<typeof PullRequestPanel>) {
  return (
    <ChunkLoadErrorBoundary autoReload={false}>
      <Suspense
        fallback={
          <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
            <ContentSkeleton label="Loading pull requests…" rows={5} />
          </div>
        }
      >
        <PullRequestPanel {...props} />
      </Suspense>
    </ChunkLoadErrorBoundary>
  );
}
