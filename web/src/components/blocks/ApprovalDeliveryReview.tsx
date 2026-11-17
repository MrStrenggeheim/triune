// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).

import { useEffect, useRef, useState } from "react";
import { ClockIcon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { authenticatedFetch } from "@/lib/identity";
import type { RunnerApprovalDelivery } from "@/lib/runnerApprovalDelivery";
import { cn } from "@/lib/utils";

export function ApprovalDeliveryReview({
  delivery,
  className,
}: {
  delivery: RunnerApprovalDelivery;
  className?: string;
}) {
  const [state, setState] = useState<"held" | "checking" | "confirmed">("held");
  const [notice, setNotice] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  const recheck = async () => {
    if (active.current || state === "confirmed") return;
    const controller = new AbortController();
    active.current = controller;
    setState("checking");
    setNotice("");
    try {
      const path = `/v1/sessions/${encodeURIComponent(delivery.session_id)}/elicitations/${encodeURIComponent(delivery.elicitation_id)}`;
      const response = await authenticatedFetch(
        `${path}?delivery_attempt_id=${encodeURIComponent(delivery.attempt_id)}`,
        { method: "GET", signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setState("held");
        setNotice(
          response.status === 401 || response.status === 403 || response.status === 404
            ? "Delivery could not be checked with your current access. The attempt remains held."
            : "Delivery could not be confirmed. The attempt remains held.",
        );
        return;
      }
      const result = await response.json();
      if (controller.signal.aborted) return;
      if (
        result.status === "resolved" &&
        result.delivery_state === "confirmed" &&
        result.delivery_attempt_id === delivery.attempt_id
      ) {
        setState("confirmed");
      } else {
        setState("held");
        setNotice(
          "The original receipt is unavailable. Delivery remains unknown and the attempt stays held.",
        );
      }
    } catch {
      if (!controller.signal.aborted) {
        setState("held");
        setNotice("Delivery could not be checked. The attempt remains held.");
      }
    } finally {
      if (active.current === controller) active.current = null;
    }
  };

  return (
    <Alert
      data-testid="approval-card"
      data-state={state === "confirmed" ? "delivery-confirmed" : "delivery-unknown"}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      <AlertTitle className="flex items-center gap-2 text-ui">
        <ClockIcon className="size-4 text-muted-foreground" />
        {state === "confirmed" ? "Delivery confirmed" : "Delivery unknown"}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-2 text-sm">
        <span>
          {state === "confirmed"
            ? "The original runner receipt confirmed delivery. This attempt is settled."
            : "Your decision may have reached the runner. This attempt stays held until its original receipt confirms delivery."}
        </span>
        <span>Rechecking only looks for that receipt. It never sends the answer again.</span>
        {notice && <span role="status">{notice}</span>}
        <div className="flex flex-wrap gap-2">
          {state !== "confirmed" && (
            <Button
              size="sm"
              disabled={state === "checking"}
              onClick={() => void recheck()}
              componentId="approval.recheck_delivery"
            >
              {state === "checking" ? "Checking delivery…" : "Recheck delivery"}
            </Button>
          )}
          <Dialog>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                Review delivery
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delivery review</DialogTitle>
                <DialogDescription>
                  Only the original trusted receipt can settle this attempt. Missing evidence keeps
                  it held.
                </DialogDescription>
              </DialogHeader>
              <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                {[
                  ["Session", delivery.session_id],
                  ["Request", delivery.elicitation_id],
                  ["Attempt", delivery.attempt_id],
                  ["Runner", delivery.runner_id],
                  ["Receiver", delivery.owner_kind],
                ].map(([label, value]) => (
                  <div className="contents" key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="break-all font-mono">{value}</dd>
                  </div>
                ))}
              </dl>
            </DialogContent>
          </Dialog>
        </div>
      </AlertDescription>
    </Alert>
  );
}
