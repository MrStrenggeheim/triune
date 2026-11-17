import { cn } from "@/lib/utils";
import { Loader2Icon } from "lucide-react";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn(
        "size-4 shrink-0 origin-center animate-spin motion-reduce:animate-none [transform-box:fill-box]",
        className,
      )}
      {...props}
    />
  );
}

export { Spinner };
