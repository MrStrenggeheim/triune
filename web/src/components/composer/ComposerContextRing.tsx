// Modified for Triune; inherited notices remain applicable.
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { formatTokenCount } from "@/lib/formatCost";
import { cn } from "@/lib/utils";

/** Circumference of the progress ring (r=5.5). */
const RING_CIRCUMFERENCE = 2 * Math.PI * 5.5;

/**
 * Compact context-usage ring beside the composer send control.
 *
 * Grayscale by design — a near-full context window is a neutral fact, not an
 * error, so the ring never escalates to warning/destructive colors. Self-nulls
 * when there is nothing to show, so the landing/pre-session window (no context
 * figures) renders nothing.
 *
 * @param contextWindow - Total context window in tokens; ``<= 0``/``null``
 *   renders nothing (``0/0`` would be ``NaN%``).
 * @param tokensUsed - Tokens consumed so far, or ``null`` when unknown.
 */
export function ComposerContextRing({
  contextWindow,
  tokensUsed,
  className,
}: {
  contextWindow: number | null;
  tokensUsed: number | null;
  className?: string;
}) {
  if (contextWindow == null || contextWindow <= 0 || tokensUsed == null) return null;

  const pct = Math.min(tokensUsed / contextWindow, 1);
  // Arc, %, label, and tooltip all encode context USED: a fresh session
  // shows an empty ring at 0% and the ring fills as context is consumed.
  const usedArc = pct * RING_CIRCUMFERENCE;
  const usedPct = Math.round(pct * 100);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          menuFeedback="composer"
          tooltip={`${usedPct}% context used`}
          tooltipDescription={`${formatTokenCount(tokensUsed)} / ${formatTokenCount(contextWindow)} tokens`}
          type="button"
          data-testid="composer-context-ring"
          className={cn("p-0 text-muted-foreground", className)}
          aria-label={`${usedPct}% of context used`}
        >
          {/* Tight stroke bounds keep the visible icon-to-label gap consistent. */}
          <svg
            data-icon-size="13"
            viewBox="1.5 1.5 13 13"
            width="13"
            height="13"
            fill="none"
            aria-hidden="true"
          >
            {/* Track */}
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="2" opacity="0.2" />
            {/* Used arc — skipped at 0, where round linecaps would still paint a dot. */}
            {usedArc > 0 && (
              <circle
                cx="8"
                cy="8"
                r="5.5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={`${usedArc} ${RING_CIRCUMFERENCE}`}
                transform="rotate(-90 8 8)"
              />
            )}
          </svg>
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" aria-label="Context window" className="w-52 gap-1.5">
        <p className="font-medium">Context window</p>
        <p className="tabular-nums">{usedPct}% used</p>
        <Progress aria-label="Context used" value={pct * 100} />
        <p className="tabular-nums text-muted-foreground">
          {tokensUsed.toLocaleString()} / {contextWindow.toLocaleString()} tokens
        </p>
      </PopoverContent>
    </Popover>
  );
}
