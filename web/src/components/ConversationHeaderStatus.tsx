// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useEffect, useState, type ReactNode } from "react";
import { ChevronRightIcon, GaugeIcon } from "lucide-react";
import { HeaderActionButton } from "@/components/HeaderActionButton";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RuntimeNoticeIndicator } from "@/components/composer/RuntimeNoticeIndicator";
import { useRuntimeNotices, type RuntimeQuota } from "@/hooks/useRuntimeNotices";
import { formatSessionCostUsd, formatTokenCount } from "@/lib/formatCost";
import type { ModelUsage } from "@/lib/types";
import { useConversationChatStore } from "@/workbench/ScopedChatStore";

function recordedNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value >= 0 ? value : null;
}

function observationDate(seconds: number | null): Date | null {
  if (recordedNumber(seconds) == null) return null;
  const date = new Date(seconds! * 1000);
  return Number.isFinite(date.getTime()) ? date : null;
}

function UsageBar({ percent, label }: { percent: number; label: string }) {
  const value = Math.min(percent, 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={`${Math.round(percent)}% used`}
      className="h-[3px] w-full overflow-hidden bg-muted"
    >
      <span className="block h-full bg-primary" style={{ width: `${value}%` }} />
    </div>
  );
}

function UsageDisclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Collapsible className="min-w-0">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="group -ml-1 justify-start px-1 text-muted-foreground"
        >
          <ChevronRightIcon className="size-3.5 group-data-[state=open]:rotate-90" />
          {label}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-[var(--popup-item-gap)] pt-[var(--popup-text-gap)]">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

const tokenRows = [
  ["inputTokens", "Input"],
  ["outputTokens", "Output"],
  ["cacheReadInputTokens", "Cache read"],
  ["cacheCreationInputTokens", "Cache write"],
  ["totalTokens", "Total"],
] as const;

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
  const contextPercent =
    used != null && capacity != null && capacity > 0
      ? recordedNumber((used / capacity) * 100)
      : null;
  // Kiro's legacy USD-named field contains credits, with no verified USD conversion.
  const priced = !harness?.toLowerCase().includes("kiro");
  const sessionCost = priced ? recordedNumber(cost) : null;
  const models = Object.entries(usageByModel ?? {}).map(
    ([model, usage]) =>
      [
        model,
        {
          inputTokens: recordedNumber(usage.inputTokens),
          outputTokens: recordedNumber(usage.outputTokens),
          totalTokens: recordedNumber(usage.totalTokens),
          cacheReadInputTokens: recordedNumber(usage.cacheReadInputTokens),
          cacheCreationInputTokens: recordedNumber(usage.cacheCreationInputTokens),
          totalCostUsd: priced ? recordedNumber(usage.totalCostUsd) : null,
        },
      ] as const,
  );
  models.sort(([, left], [, right]) => (right.totalTokens ?? 0) - (left.totalTokens ?? 0));
  // Recorded totals already include cache buckets and descendants; never add those again.
  const sessionTokens =
    models.length > 0 && models.every(([, usage]) => usage.totalTokens != null)
      ? recordedNumber(models.reduce((total, [, usage]) => total + usage.totalTokens!, 0))
      : null;
  return (
    <div className="flex min-w-0 flex-col gap-[var(--popup-inset)] [overflow-wrap:anywhere]">
      <h2 className="font-medium">Usage</h2>
      <section aria-label="Context usage" className="space-y-[var(--popup-item-gap)]">
        <div className="flex flex-wrap items-baseline justify-between gap-[var(--popup-text-gap)]">
          <h3 className="font-medium">Context</h3>
          {contextPercent != null && (
            <span className="text-sm tabular-nums text-muted-foreground">
              {Math.round(contextPercent)}% used
            </span>
          )}
        </div>
        {used != null ? (
          <p className="text-[length:calc(var(--text-ui)*1.5)] leading-tight font-medium tabular-nums">
            {formatTokenCount(used)}
            <span className="text-ui font-normal text-muted-foreground">
              {capacity != null && capacity > 0
                ? ` / ${formatTokenCount(capacity)} tokens`
                : " tokens · Capacity unavailable"}
            </span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Context usage unavailable.</p>
        )}
        {contextPercent != null && <UsageBar percent={contextPercent} label="Context used" />}
      </section>
      <section
        aria-label="Session accounting"
        className="space-y-[var(--popup-item-gap)] border-t border-border pt-[var(--popup-inset)]"
      >
        <dl className="grid grid-cols-2 gap-[var(--popup-inset)]">
          {sessionCost != null && (
            <div className="min-w-0 space-y-[var(--popup-text-gap)]">
              <dt className="text-sm text-muted-foreground">Session cost</dt>
              <dd className="text-[length:calc(var(--text-ui)*1.5)] leading-tight font-medium tabular-nums">
                {formatSessionCostUsd(sessionCost)}{" "}
                <span className="text-sm font-normal text-muted-foreground">USD</span>
              </dd>
            </div>
          )}
          {sessionTokens != null && (
            <div className="min-w-0 space-y-[var(--popup-text-gap)]">
              <dt className="text-sm text-muted-foreground">Session tokens</dt>
              <dd className="text-[length:calc(var(--text-ui)*1.5)] leading-tight font-medium tabular-nums">
                {formatTokenCount(sessionTokens)}
              </dd>
            </div>
          )}
        </dl>
        {sessionCost == null && sessionTokens == null && (
          <p className="text-sm text-muted-foreground">Session accounting unavailable.</p>
        )}
        <p className="text-sm text-muted-foreground">This session, including descendants</p>
        {models.length > 0 && (
          <UsageDisclosure label="Token breakdown">
            {models.map(([model, usage]) => (
              <div key={model} className="min-w-0 space-y-[var(--popup-text-gap)]">
                <h4>{model}</h4>
                <dl>
                  {tokenRows.map(
                    ([key, label]) =>
                      usage[key] != null && (
                        <div
                          key={key}
                          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-[var(--popup-inset)] py-[var(--popup-text-gap)]"
                        >
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="text-right tabular-nums">{usage[key].toLocaleString()}</dd>
                        </div>
                      ),
                  )}
                  {usage.totalCostUsd != null && (
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-[var(--popup-inset)] py-[var(--popup-text-gap)]">
                      <dt className="text-muted-foreground">Cost</dt>
                      <dd className="text-right tabular-nums">
                        {formatSessionCostUsd(usage.totalCostUsd)} USD
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            ))}
          </UsageDisclosure>
        )}
      </section>
      <section
        aria-label="Provider quotas"
        className="space-y-[var(--popup-item-gap)] border-t border-border pt-[var(--popup-inset)]"
      >
        <h3 className="font-medium">Provider quotas</h3>
        {!quotas.length && (
          <p className="text-sm text-muted-foreground">No provider quota observation available.</p>
        )}
        <ul className="space-y-[var(--popup-item-gap)]">
          {quotas.map((quota) => {
            const percent = recordedNumber(quota.used_percent);
            const quotaPercent = percent != null && percent <= 100 ? percent : null;
            const reset = observationDate(quota.reset_at);
            return (
              <li key={quota.id} className="space-y-[var(--popup-text-gap)]">
                <div className="flex flex-wrap items-baseline justify-between gap-x-[var(--popup-item-gap)] gap-y-[var(--popup-text-gap)]">
                  <span className="min-w-0">
                    {quota.provider} · {quota.window}
                  </span>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    {quotaPercent != null ? `${Math.round(quotaPercent)}% used` : "Usage unknown"}
                  </span>
                </div>
                {quotaPercent != null && (
                  <UsageBar
                    percent={quotaPercent}
                    label={`${quota.provider} ${quota.window} allowance used`}
                  />
                )}
                {reset != null && (
                  <p className="text-sm text-muted-foreground">
                    Reported reset {reset.toLocaleString()}
                    {reset.getTime() <= Date.now() && (
                      <span className="block">Current availability unconfirmed</span>
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
        {quotas.length > 0 && (
          <UsageDisclosure label="Observation details">
            {quotas.map((quota) => {
              const observed = observationDate(quota.observed_at);
              const minutes = recordedNumber(quota.window_minutes);
              return (
                <div key={quota.id} className="space-y-[var(--popup-text-gap)]">
                  <p>
                    {quota.provider} · {quota.window}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {observed
                      ? `Observed ${observed.toLocaleString()}`
                      : "Observation time unavailable"}
                  </p>
                  {quota.status && (
                    <p className="text-sm text-muted-foreground">
                      Provider status: {quota.status.replaceAll("_", " ")}
                    </p>
                  )}
                  {minutes != null && (
                    <p className="text-sm text-muted-foreground">
                      Reported window: {minutes} minutes
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground">Source: {quota.source_kind}</p>
                </div>
              );
            })}
          </UsageDisclosure>
        )}
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
  onOpen,
  refreshing,
}: {
  conversationId: string;
  active: boolean;
  harness?: string | null;
  quotas: RuntimeQuota[];
  error: boolean;
  onRefresh: () => void;
  onOpen: () => void;
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
    <Popover
      open={active && open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen();
      }}
    >
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
        className="max-h-[min(calc(100dvh-2rem),var(--radix-popover-content-available-height))] w-[min(25rem,calc(100vw-2rem))] overflow-x-hidden overflow-y-auto gap-[var(--popup-item-gap)] p-[var(--popup-inset)]"
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
  const useStore = useConversationChatStore();
  const [usageError, setUsageError] = useState(false);
  const [usageRefreshing, setUsageRefreshing] = useState(false);
  useEffect(() => setUsageError(false), [conversationId]);
  const refreshUsage = () => {
    if (usageRefreshing) return;
    setUsageRefreshing(true);
    void useStore
      .getState()
      .refreshSessionUsage(conversationId)
      .then(
        () => setUsageError(false),
        () => setUsageError(true),
      )
      .finally(() => setUsageRefreshing(false));
  };
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
        error={!!observations.error || usageError}
        onOpen={() => {
          if (observations.isStale && !observations.isFetching) void observations.refetch();
          refreshUsage();
        }}
        onRefresh={() => {
          void observations.refetch();
          refreshUsage();
        }}
        refreshing={observations.isFetching || usageRefreshing}
      />
    </>
  );
}
