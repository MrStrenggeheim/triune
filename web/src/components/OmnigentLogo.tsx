// Modified for Triune.
import type { ComponentProps } from "react";
import logo from "@/assets/omnigent-logo.svg";
import { cn } from "@/lib/utils";

/** Local workspace mark; operator-provided branding remains separate. */
export function OmnigentLogo({ className, ...props }: Omit<ComponentProps<"img">, "src" | "alt">) {
  return <img {...props} src={logo} alt="Triune" className={cn("h-8 w-7 shrink-0", className)} />;
}
