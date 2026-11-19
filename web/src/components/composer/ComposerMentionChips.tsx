import { ComposerMentionChip } from "./ComposerMentionChip";
import { mentionItemPath, type MentionItem } from "@/lib/composerMentions";
import { cn } from "@/lib/utils";
import { ComposerChipRow } from "@/components/composer/ChatComposer";

/**
 * One removable chip per workspace path tagged via the composer "@" menu,
 * shared by the new-session launcher and the in-session composer. Each chip
 * carries the full tagged path (with any line range) as its title, since the
 * visible label truncates; the line range renders outside the truncating span
 * so it is never clipped. ``showLineRange`` is on for the in-session
 * composer, where "Attach to agent" can tag a line span; the launcher's chips
 * are path-only. Removal is by list index, matching each surface's state.
 */
export function ComposerMentionChips({
  items,
  onRemove,
  showLineRange = false,
  className,
}: {
  items: MentionItem[];
  onRemove: (index: number) => void;
  showLineRange?: boolean;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ComposerChipRow className={cn("gap-1.5", className)}>
      {items.map((item, i) => (
        <ComposerMentionChip
          key={mentionItemPath(item)}
          item={item}
          showLineRange={showLineRange}
          onRemove={() => onRemove(i)}
        />
      ))}
    </ComposerChipRow>
  );
}
