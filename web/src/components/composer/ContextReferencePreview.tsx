// Modified for Triune.
import { useContext } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  referenceScopeLabels,
  referenceSourceUrl,
  type ContextReference,
} from "@/lib/contextReferences";
import { ContextReferenceNavigationContext } from "@/lib/contextReferenceNavigation";

export function ContextReferencePreview({
  reference,
  onClose,
  onAttach,
}: {
  reference: ContextReference;
  onClose: () => void;
  onAttach?: () => void;
}) {
  const navigation = useContext(ContextReferenceNavigationContext);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-context-reference-picker className="max-w-2xl">
        <DialogTitle>
          {reference.source_title} · {referenceScopeLabels[reference.scope]}
        </DialogTitle>
        <DialogDescription>{reference.audience}</DialogDescription>
        <p className="text-sm text-muted-foreground">{reference.representation}</p>
        <p className="break-all text-sm">
          Boundary: {reference.boundary_id} ·{" "}
          {new Date(reference.captured_at * 1000).toLocaleString()}
        </p>
        {reference.quote && (
          <blockquote className="whitespace-pre-wrap border-l-2 pl-3">{reference.quote}</blockquote>
        )}
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap text-xs">
          {JSON.stringify(reference.items, null, 2)}
        </pre>
        <div className="flex gap-2">
          <Button type="button" variant="outline" asChild>
            <a
              href={referenceSourceUrl(reference.source_id, reference.boundary_id)}
              target="_blank"
              rel="noreferrer"
            >
              Open source
            </a>
          </Button>
          {navigation && (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                navigation.openConversation(reference.source_id, {
                  beside: true,
                  messageId: reference.boundary_id,
                })
              }
            >
              Open beside
            </Button>
          )}
          {onAttach && (
            <Button type="button" onClick={onAttach}>
              Add reference
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
