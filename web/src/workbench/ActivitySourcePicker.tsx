// Modified for Triune.
import { useEffect, useState } from "react";
import { CheckIcon, ChevronDownIcon, MessageSquareIcon, MonitorIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useConversations, useSessionSearch } from "@/hooks/useConversations";
import { useHosts } from "@/hooks/useHosts";
import { useSession } from "@/hooks/useSession";
import { useViewerId } from "@/hooks/useViewerId";
import { resourceViewStorageScope } from "@/lib/resourceViewStorage";
import { WorkspaceSelector } from "@/shell/WorkspaceSelector";
import {
  WorkspaceSelectionDialog,
  type WorkspaceSelection,
} from "@/shell/WorkspaceSelectionDialog";
import { conversationDisplayLabel } from "@/shell/sidebarNav";
import type { ActivitySource } from "./ActivityView";

/** Both origin kinds use authorized discovery, without navigating or following chat focus. */
export function ActivitySourcePicker({
  source,
  onChange,
  onChooseWorkspace,
}: {
  source?: ActivitySource | null;
  onChange: (source: ActivitySource) => void | Promise<void>;
  onChooseWorkspace: (selection: WorkspaceSelection) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hosts = useHosts();
  const viewerId = useViewerId();
  const scope = resourceViewStorageScope();
  const { session } = useSession(source?.kind === "chat" ? source.conversationId : undefined);
  const recent = useConversations("", false, { enabled: open && !!viewerId });
  const search = useSessionSearch(debouncedQuery, "title", {
    enabled: open && !!viewerId,
    cacheIdentity: scope,
  });
  const chats = debouncedQuery ? search : recent;
  const settled = query.trim() === debouncedQuery;
  const conversations = [
    ...new Map(
      chats.data?.pages.flatMap((page) => page.data).map((chat) => [chat.id, chat]),
    ).values(),
  ];
  const label =
    source?.kind === "host"
      ? `Host: ${hosts.data?.find((host) => host.host_id === source.hostId)?.name || source.hostId} · ${source.workspace?.root || "Choose path"}`
      : source?.kind === "chat"
        ? `Chat: ${session?.title || source.conversationId}`
        : "Choose source";

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  async function select(next: ActivitySource) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onChange(next);
      setOpen(false);
      setQuery("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {source?.kind === "host" ? (
        <WorkspaceSelector
          hostLabel={
            hosts.data?.find((host) => host.host_id === source.hostId)?.name || source.hostId
          }
          path={source.workspace?.root ?? ""}
          aria-label={`Choose orchestration source · ${label}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          menuOpen={open || workspaceOpen}
          data-view-retain={open || workspaceOpen || busy || undefined}
          onClick={() => setOpen(true)}
        />
      ) : (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Choose orchestration source · ${label}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          data-view-retain={open || workspaceOpen || busy || undefined}
          className="min-w-0 gap-1"
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          <MessageSquareIcon className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
          <ChevronDownIcon className="size-3.5 shrink-0" />
        </Button>
      )}
      <CommandDialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) {
            setOpen(next);
            if (!next) setQuery("");
          }
        }}
        title="Orchestration source"
        description="Choose a chat or a host workspace."
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search chats…"
            value={query}
            onValueChange={setQuery}
            disabled={busy}
          />
          {error && (
            <p role="alert" className="px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <CommandList aria-label="Orchestration sources">
            <CommandGroup heading="Source">
              <CommandItem
                value="host-workspace"
                disabled={busy}
                onSelect={() => {
                  setOpen(false);
                  setWorkspaceOpen(true);
                }}
              >
                <MonitorIcon className="size-3.5" />
                Host / workspace
              </CommandItem>
            </CommandGroup>
            <CommandGroup heading="Chats">
              {(!settled || chats.isLoading) && (
                <p role="status" className="px-2 text-sm">
                  Loading chats…
                </p>
              )}
              {chats.error && (
                <Button variant="ghost" size="sm" onClick={() => void chats.refetch()}>
                  Could not load chats · Retry
                </Button>
              )}
              {settled &&
                conversations.map((chat) => (
                  <CommandItem
                    key={chat.id}
                    value={`chat:${chat.id}`}
                    disabled={busy}
                    onSelect={() => void select({ kind: "chat", conversationId: chat.id })}
                  >
                    <MessageSquareIcon className="size-3.5" />
                    <span className="min-w-0 flex-1 truncate">
                      {conversationDisplayLabel(chat)}
                    </span>
                    {source?.kind === "chat" && source.conversationId === chat.id && (
                      <CheckIcon className="size-3.5" />
                    )}
                  </CommandItem>
                ))}
              {settled && !chats.isLoading && !chats.error && conversations.length === 0 && (
                <p className="px-2 text-sm text-muted-foreground">No matching chats.</p>
              )}
              {settled && chats.hasNextPage && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={chats.isFetchingNextPage}
                  onClick={() => void chats.fetchNextPage()}
                >
                  Load more chats
                </Button>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </CommandDialog>
      {workspaceOpen && (
        <WorkspaceSelectionDialog
          open
          onOpenChange={setWorkspaceOpen}
          hostId={source?.kind === "host" ? source.hostId : (session?.hostId ?? null)}
          initialPath={
            source?.kind === "host" ? source.workspace?.root : (session?.workspace ?? undefined)
          }
          workspacePath={
            source?.kind === "host" ? source.workspace?.root : (session?.workspace ?? undefined)
          }
          onConfirm={onChooseWorkspace}
        />
      )}
    </>
  );
}
