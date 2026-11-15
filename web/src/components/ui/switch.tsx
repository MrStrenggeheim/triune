// Modified for Triune.
import * as React from "react";
import * as SwitchPrimitive from "radix-ui/switch";

import { cn } from "@/lib/utils";
import { useOmnigentAnalytics } from "@/lib/analytics";
import { CONTROL_FOCUS_CLASS } from "@/lib/designContract";

function Switch({
  className,
  size = "default",
  componentId,
  onCheckedChange,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default";
  // Opt-in analytics id. When set, a toggle reports the new checked state to the
  // host sink (see `lib/analytics.ts`). A boolean carries no PII, so it's sent.
  componentId?: string;
}) {
  const { trackValueChange } = useOmnigentAnalytics();
  const handleCheckedChange = componentId
    ? (checked: boolean) => {
        trackValueChange(componentId, "toggle", checked, { valueHasNoPii: true });
        onCheckedChange?.(checked);
      }
    : onCheckedChange;
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      data-component-id={componentId}
      onCheckedChange={handleCheckedChange}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-all outline-none after:absolute after:-inset-x-3 after:-inset-y-2 enabled:hover:border-ring enabled:data-checked:hover:bg-primary/90 enabled:data-unchecked:hover:bg-foreground/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:bg-primary data-unchecked:bg-muted-foreground data-disabled:data-unchecked:bg-input data-disabled:cursor-not-allowed data-disabled:opacity-50",
        CONTROL_FOCUS_CLASS,
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-background ring-0 transition-transform group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-2px)] group-data-[size=sm]/switch:data-checked:translate-x-[calc(100%-2px)] dark:data-checked:bg-primary-foreground group-data-[size=default]/switch:data-unchecked:translate-x-0 group-data-[size=sm]/switch:data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
