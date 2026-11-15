// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useEffect, useState } from "react";
import { GaugeIcon } from "lucide-react";
import { HeaderActionButton } from "@/components/HeaderActionButton";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ModelUsageBreakdown } from "@/components/AgentInfo";
import { RuntimeNoticeIndicator } from "@/components/composer/RuntimeNoticeIndicator";
import { useRuntimeNotices, type RuntimeQuota } from "@/hooks/useRuntimeNotices";
import { formatSessionCostUsd, formatTokenCount } from "@/lib/formatCost";
import type { ModelUsage } from "@/lib/types";
import { useConversationChatStore } from "@/workbench/ScopedChatStore";

function recordedNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Context capacity, cumulative accounting and provider allowances retain separate units and scopes. */
export function ConversationUsageContent({
  tokensUsed,
  contextWindow,
  cost,
  usageByModel,
  quotas,
  harness,
}: {
  tokensUsed: number | null;
  contextWindow: number | null;
  cost: number | null;
  usageByModel: Record<string, ModelUsage> | null;
  quotas: RuntimeQuota[];
  harness?: string | null;
}) {
  const used = recordedNumber(tokensUsed);
  const capacity = recordedNumber(contextWindow);
  // Kiro's legacy USD-named field contains credits, with no verified USD conversion.
  const priced = !harness?.toLowerCase().includes("kiro");
  const sessionCost = priced ? recordedNumber(cost) : null;
  const models = Object.fromEntries(
    Object.entries(usageByModel ?? {}).map(([model, usage]) => [
      model,
      {
        inputTokens: recordedNumber(usage.inputTokens),
        outputTokens: recordedNumber(usage.outputTokens),
        totalTokens: recordedNumber(usage.totalTokens),
        cacheReadInputTokens: recordedNumber(usage.cacheReadInputTokens),
        cacheCreationInputTokens: recordedNumber(usage.cacheCreationInputTokens),
        totalCostUsd: priced ? recordedNumber(usage.totalCostUsd) : null,
      },
    ]),
  );
  return (
    <div className="flex flex-col gap-[var(--popup-item-gap)]">
      <section aria-label="Context usage" className="space-y-[var(--popup-text-gap)]">
        <h3 className="font-medium">Context</h3>
        <p className="text-sm text-muted-foreground">
          Latest observed model context, separate from account quota.
        </p>
        {used != null ? (
          <p className="tabular-nums">
            {formatTokenCount(used)} tokens
            {capacity != null && capacity > 0
              ? ` / ${formatTokenCount(capacity)} capacity`
              : " · Capacity unavailable"}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Context usage unavailable.</p>
        )}
      </section>
      <section aria-label="Session accounting" className="space-y-[var(--popup-text-gap)]">
        <h3 className="font-medium">Session accounting</h3>
        <p className="text-sm text-muted-foreground">
          Recorded totals for this session and its descendants.
        </p>
        {sessionCost != null && (
          <p className="tabular-nums">Cost: {formatSessionCostUsd(sessionCost)} USD</p>
        )}
        {Object.keys(models).length > 0 ? (
          <ModelUsageBreakdown usageByModel={models} />
        ) : (
          <p className="text-sm text-muted-foreground">Token accounting unavailable.</p>
        )}
      </section>
      <section aria-label="Provider quotas" className="space-y-[var(--popup-text-gap)]">
        <h3 className="font-medium">Provider quotas</h3>
        {!quotas.length && (
          <p className="text-sm text-muted-foreground">No provider quota observation available.</p>
        )}
        <ul className="space-y-[var(--popup-item-gap)]">
          {quotas.map((quota) => (
            <li key={quota.id} className="space-y-[var(--popup-text-gap)]">
              <p className="font-medium">
                {quota.provider} · {quota.window}
              </p>
              {quota.used_percent != null && (
                <p className="tabular-nums">{quota.used_percent}% of reported allowance used</p>
              )}
              {quota.status && (
                <p className="text-sm">Provider status: {quota.status.replaceAll("_", " ")}</p>
              )}
              {quota.window_minutes != null && (
                <p className="text-sm text-muted-foreground">
                  Reported window: {quota.window_minutes} minutes
                </p>
              )}
              {quota.reset_at != null && (
                <p className="text-sm text-muted-foreground">
                  Last reported reset: {new Date(quota.reset_at * 1000).toLocaleString()}
                  {quota.reset_at * 1000 <= Date.now() && " · Current availability unconfirmed"}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Observed {new Date(quota.observed_at * 1000).toLocaleString()}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function UsagePopover({
  conversationId,
  active,
  harness,
  quotas,
  error,
  onRefresh,
  refreshing,
}: {
  conversationId: string;
  active: boolean;
  harness?: string | null;
  quotas: RuntimeQuota[];
  error: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  const useStore = useConversationChatStore();
  const tokensUsed = useStore((state) =>
    state.conversationId === conversationId ? state.tokensUsed : null,
  );
  const contextWindow = useStore((state) =>
    state.conversationId === conversationId ? state.contextWindow : null,
  );
  const cost = useStore((state) =>
    state.conversationId === conversationId ? state.sessionCostUsd : null,
  );
  const usageByModel = useStore((state) =>
    state.conversationId === conversationId ? state.sessionUsageByModel : null,
  );
  return (
    <Popover open={active && open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <HeaderActionButton aria-label="Usage">
          <GaugeIcon className="size-4" />
        </HeaderActionButton>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        collisionPadding={8}
        aria-label="Conversation usage"
        onCloseAutoFocus={(event) => {
          if (!active) event.preventDefault();
        }}
        className="max-h-[min(32rem,var(--radix-popover-content-available-height))] w-[min(25rem,calc(100vw-2rem))] overflow-y-auto gap-[var(--popup-item-gap)] p-[var(--popup-inset)]"
      >
        {error && (
          <div role="alert" className="flex items-center gap-[var(--popup-text-gap)] text-sm">
            <span>Could not refresh provider usage.</span>
            <Button variant="ghost" size="xs" disabled={refreshing} onClick={onRefresh}>
              Retry
            </Button>
          </div>
        )}
        <ConversationUsageContent
          tokensUsed={tokensUsed}
          contextWindow={contextWindow}
          cost={cost}
          usageByModel={usageByModel}
          quotas={quotas}
          harness={harness}
        />
      </PopoverContent>
    </Popover>
  );
}

/** A captured chat always exposes Usage; only exceptional observations add Notices. */
export function ConversationHeaderStatus({
  conversationId,
  active = true,
  permissionLevel,
  harness,
}: {
  conversationId: string;
  active?: boolean;
  permissionLevel?: number | null;
  harness?: string | null;
}) {
  const readable = permissionLevel == null || permissionLevel >= 1;
  const observations = useRuntimeNotices(conversationId, active && readable);
  if (!readable || observations.accessDenied) return null;
  return (
    <>
      <RuntimeNoticeIndicator
        key={`notices:${conversationId}`}
        conversationId={conversationId}
        active={active}
        notices={observations.notices}
        onDismiss={observations.dismiss}
      />
      <UsagePopover
        key={`usage:${conversationId}`}
        conversationId={conversationId}
        active={active}
        harness={harness}
        quotas={observations.quotas}
        error={!!observations.error}
        onRefresh={() => void observations.refetch()}
        refreshing={observations.isFetching}
      />
    </>
  );
}
