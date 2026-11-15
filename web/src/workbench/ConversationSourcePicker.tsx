// Modified for Triune; inherited notices remain applicable.
import { useState } from "react";
import { MessageSquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/hooks/useSession";
import { CommandPalette } from "@/shell/CommandPalette";

const noop = () => {};

/** A view changes its named source explicitly, without navigating the surrounding layout. */
export function ConversationSourcePicker({
  conversationId,
  label,
  onChange,
}: {
  conversationId?: string;
  label: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { session } = useSession(conversationId);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="min-w-0 max-w-full shrink gap-1 truncate"
        aria-label={`Choose ${label.toLowerCase()} conversation · ${conversationId ? session?.title || "Conversation" : "Choose chat"}`}
        onClick={() => setOpen(true)}
      >
        <MessageSquareIcon className="size-3.5 shrink-0" />
        <span className="truncate">
          {label === "Chat" ? "" : `${label}: `}
          {conversationId ? session?.title || "Conversation" : "Choose chat"}
        </span>
      </Button>
      <CommandPalette
        sessionsOnly
        open={open}
        onOpenChange={setOpen}
        onToggleLeftSidebar={noop}
        onToggleRightSidebar={noop}
        onNavigate={(path) => {
          const match = path.match(/^\/c\/([^/?#]+)$/);
          if (match) onChange(decodeURIComponent(match[1]));
        }}
      />
    </>
  );
}
