// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { forwardRef, type ComponentProps } from "react";
import { XIcon } from "lucide-react";
import { HeaderActionButton } from "./HeaderActionButton";
import { cn } from "@/lib/utils";

export type CloseButtonProps = ComponentProps<typeof HeaderActionButton>;

export const CloseButton = forwardRef<HTMLButtonElement, CloseButtonProps>(function CloseButton(
  {
    children,
    className,
    size = "icon-xs",
    variant = "ghost",
    type = "button",
    tooltip = false,
    "aria-label": label = "Close",
    ...props
  },
  ref,
) {
  return (
    <HeaderActionButton
      {...props}
      ref={ref}
      type={type}
      size={size}
      variant={variant}
      tooltip={tooltip}
      aria-label={label}
      data-close-button=""
      className={cn("close-control-button", className)}
    >
      {children ?? <XIcon aria-hidden="true" />}
    </HeaderActionButton>
  );
});
