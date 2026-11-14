// Modified for Triune.
import * as React from "react";
import * as CheckboxPrimitive from "radix-ui/checkbox";
import { CheckIcon, MinusIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useOmnigentAnalytics } from "@/lib/analytics";

const CHECKBOX_VISUAL_CLASS =
  "group/checkbox relative flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-background transition-colors dark:bg-input/30 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground dark:data-checked:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground";

function CheckboxGlyph() {
  return (
    <>
      <CheckIcon
        className="size-3 group-data-[state=indeterminate]/checkbox:hidden"
        strokeWidth={3}
      />
      <MinusIcon
        className="hidden size-3 group-data-[state=indeterminate]/checkbox:block"
        strokeWidth={3}
      />
    </>
  );
}

/** Decorative agent-managed status; callers supply the accessible status text. */
function CheckboxVisual({ checked = false }: { checked?: CheckboxPrimitive.CheckedState }) {
  return (
    <span
      aria-hidden="true"
      data-slot="checkbox-visual"
      data-state={checked === "indeterminate" ? "indeterminate" : checked ? "checked" : "unchecked"}
      data-checked={checked === true ? "" : undefined}
      className={CHECKBOX_VISUAL_CLASS}
    >
      {checked !== false && <CheckboxGlyph />}
    </span>
  );
}

function Checkbox({
  className,
  componentId,
  onCheckedChange,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> & {
  // Opt-in analytics id. When set, a toggle reports the new checked state to the
  // host sink (see `lib/analytics.ts`). A boolean carries no PII, so it's sent.
  componentId?: string;
}) {
  const { trackValueChange } = useOmnigentAnalytics();
  const handleCheckedChange = componentId
    ? (checked: CheckboxPrimitive.CheckedState) => {
        trackValueChange(componentId, "checkbox", checked === true, { valueHasNoPii: true });
        onCheckedChange?.(checked);
      }
    : onCheckedChange;
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      data-component-id={componentId}
      onCheckedChange={handleCheckedChange}
      className={cn(
        CHECKBOX_VISUAL_CLASS,
        "peer cursor-pointer outline-none after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current"
      >
        {/* Driven by Radix's own state so uncontrolled checkboxes show the right glyph. */}
        <CheckboxGlyph />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox, CheckboxVisual };
