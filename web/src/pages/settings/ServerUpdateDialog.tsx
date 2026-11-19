import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ServerUpdateDialogProps {
  installed: string | null;
  available: string;
  notes: string | null;
  busy: boolean;
  error: string | null;
  onLater: () => void;
  onInstall: () => void;
}

export function ServerUpdateDialog({
  installed,
  available,
  notes,
  busy,
  error,
  onLater,
  onInstall,
}: ServerUpdateDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onLater()}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Server update available</DialogTitle>
          <DialogDescription>Installing this release restarts the Triune server.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-ui">
          <dt className="text-muted-foreground">Installed</dt>
          <dd className="break-all">{installed || "Unknown"}</dd>
          <dt className="text-muted-foreground">Available</dt>
          <dd className="break-all">{available}</dd>
        </dl>
        <div>
          <h3 className="font-medium">Release notes</h3>
          <p className="mt-1 whitespace-pre-wrap break-words text-ui text-muted-foreground">
            {notes?.trim() || "No release notes were published."}
          </p>
        </div>
        {error && (
          <p role="alert" className="text-ui text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onLater} disabled={busy}>
            Later
          </Button>
          <Button onClick={onInstall} loading={busy}>
            Update &amp; restart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
