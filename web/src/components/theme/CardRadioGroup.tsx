// Modified for Triune.
import { TooltipButton } from "@/components/ui/tooltip";
import { useRef, type ReactNode } from "react";
import { CheckIcon } from "lucide-react";
import { useOmnigentAnalytics } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { CONTROL_FOCUS_CLASS } from "@/lib/designContract";
import { selectionCardClass } from "@/components/ui/selection-card";

export interface CardRadioOption<T extends string> {
  value: T;
  testId: string;
  body: ReactNode;
  title?: string;
}

export function CardRadioGroup<T extends string>({
  labelledBy,
  value,
  onSelect,
  componentId,
  items,
  layout,
  className,
  cardClassName,
}: {
  labelledBy: string;
  value: T;
  onSelect: (value: T) => void;
  componentId?: string;
  items: readonly CardRadioOption<T>[];
  layout?: "vertical" | "gallery";
  className?: string;
  cardClassName?: string;
}) {
  const { trackValueChange } = useOmnigentAnalytics();
  const select = componentId
    ? (next: T) => {
        trackValueChange(componentId, "select", next, { valueHasNoPii: true });
        onSelect(next);
      }
    : onSelect;
  const refs = useRef(new Map<T, HTMLButtonElement | null>());

  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      data-layout={layout}
      className={cn(
        layout === "vertical" && "flex flex-col gap-2",
        layout === "gallery" && "grid grid-cols-2 gap-2",
        className,
      )}
    >
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <TooltipButton
            key={item.value}
            ref={(element) => {
              refs.current.set(item.value, element);
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            title={item.title}
            data-testid={item.testId}
            onClick={() => select(item.value)}
            onKeyDown={(event) => {
              const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
              const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
              if (!forward && !backward) return;
              event.preventDefault();
              const nextIndex = (index + (forward ? 1 : -1) + items.length) % items.length;
              const next = items[nextIndex].value;
              select(next);
              refs.current.get(next)?.focus();
            }}
            className={cn(
              selectionCardClass(selected, "relative flex flex-col outline-none"),
              CONTROL_FOCUS_CLASS,
              cardClassName,
            )}
          >
            {selected && <SelectedBadge />}
            {item.body}
          </TooltipButton>
        );
      })}
    </div>
  );
}

function SelectedBadge() {
  return (
    <span
      aria-hidden
      className="absolute right-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm"
    >
      <CheckIcon className="size-3" />
    </span>
  );
}
