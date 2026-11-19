import { useState } from "react";
import { ContextReferencePreview } from "./ContextReferencePreview";
import { referenceScopeLabels, type ContextReference } from "@/lib/contextReferences";
import { Chip } from "@/components/ui/chip";
import { FileTextIcon, FolderIcon } from "lucide-react";
import { mentionItemPath, type MentionItem } from "@/lib/composerMentions";

export function ComposerMentionChip({
  item,
  showLineRange = true,
  onRemove,
}: {
  item: MentionItem;
  showLineRange?: boolean;
  onRemove?: () => void;
}) {
  const [preview, setPreview] = useState<ContextReference | null>(null);
  return (
    <>
      <Chip
        leading={
          item.isDir ? (
            <FolderIcon aria-hidden className="size-3 shrink-0" />
          ) : (
            <FileTextIcon aria-hidden className="size-3 shrink-0" />
          )
        }
        remove={onRemove ? { label: `Remove ${item.path}`, onClick: onRemove } : undefined}
      >
        {item.reference?.version === 2 ? (
          <a className="max-w-[240px] truncate" href={item.reference.url}>
            {item.reference.source_title}
          </a>
        ) : item.reference ? (
          <button
            type="button"
            className="max-w-[240px] truncate"
            onClick={() => item.reference?.version === 1 && setPreview(item.reference)}
          >
            {item.reference.source_title} · {referenceScopeLabels[item.reference.scope]}
          </button>
        ) : (
          <span className="max-w-[200px] truncate" title={mentionItemPath(item)}>
            {item.path}
            {item.isDir ? "/" : ""}
          </span>
        )}
        {showLineRange && item.lineRange && (
          <span className="shrink-0">
            :{item.lineRange.start}-{item.lineRange.end}
          </span>
        )}
      </Chip>
      {preview && <ContextReferencePreview reference={preview} onClose={() => setPreview(null)} />}
    </>
  );
}
