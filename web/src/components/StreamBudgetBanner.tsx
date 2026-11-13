// Modified for Triune.
import { useEffect } from "react";
import { removeNotification } from "@/lib/notifications";

/** Compatibility mount also removes notices retained by older app versions. */
export function StreamBudgetBanner() {
  useEffect(() => removeNotification("stream-budget"), []);
  return null;
}
