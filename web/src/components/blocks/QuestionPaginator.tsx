// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The same header navigation for a pending or answered elicitation batch. */
export function QuestionPaginator({
  index,
  count,
  onChange,
}: {
  index: number;
  count: number;
  onChange: (index: number) => void;
}) {
  if (count <= 1) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1" aria-label="Question navigation">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        tooltip={false}
        aria-label="Previous question"
        disabled={index === 0}
        onClick={() => onChange(index - 1)}
      >
        <ChevronLeftIcon aria-hidden="true" />
      </Button>
      <span
        className="whitespace-nowrap text-sm text-muted-foreground tabular-nums"
        aria-live="polite"
        data-testid="ask-user-question-progress"
      >
        Question {index + 1} of {count}
      </span>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        tooltip={false}
        aria-label="Next question"
        disabled={index >= count - 1}
        onClick={() => onChange(index + 1)}
      >
        <ChevronRightIcon aria-hidden="true" />
      </Button>
    </span>
  );
}
