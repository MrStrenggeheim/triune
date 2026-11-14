// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { ReactNode } from "react";
import { MessageCircleIcon } from "lucide-react";
import { ActivityRow } from "@/components/ActivityRow";
import { ConversationScopeContext } from "@/components/chat/conversationScope";
import { FilePathAwareMessageResponse } from "@/components/blocks/ChatMarkdown";
import type { SubagentActivity } from "@/lib/subagentActivity";

/** A child-authored report retaining the scope of each captured source part. */
export function SubagentReply({
  activity,
  conversationId,
  agentName,
  action,
}: {
  activity: SubagentActivity;
  conversationId: string | null;
  agentName: string;
  action: ReactNode;
}) {
  const text = activity.resultText!;
  const preview = text
    .slice(0, 768)
    .replace(/[\uD800-\uDBFF]$/u, "")
    .split("\n", 4)
    .slice(0, 3)
    .join("\n");
  const ref = activity.resultRef ?? activity.resultRefs[0];
  const sourceConversationId = ref?.conversationId ?? conversationId;
  const sourceItemId = ref?.itemId ?? activity.itemId;
  const parts = activity.resultParts;
  const hasExactParts = parts.length > 0 && parts.map((part) => part.text).join("\n\n") === text;
  function renderText(shownText: string) {
    let offset = 0;
    const segments = hasExactParts
      ? parts.flatMap((part) => {
          const shown = shownText.slice(offset, offset + part.text.length);
          offset += part.text.length + 2;
          return shown ? [{ ...part, text: shown }] : [];
        })
      : [{ text: shownText, ref: { conversationId: sourceConversationId, itemId: sourceItemId } }];
    return segments.map((segment) => (
      <ConversationScopeContext.Provider
        key={`${segment.ref.conversationId}:${segment.ref.itemId}`}
        value={segment.ref.conversationId}
      >
        <FilePathAwareMessageResponse
          sourceItemId={segment.ref.itemId}
          breaks
          mode="static"
          className="text-sm leading-5 [&>*]:my-0 [&_p]:my-0 [&_p]:leading-5"
        >
          {segment.text}
        </FilePathAwareMessageResponse>
      </ConversationScopeContext.Provider>
    ));
  }
  return (
    <article
      className="group min-w-0 text-sm"
      data-testid="subagent-reply"
      data-phase="returned"
      data-child-session-id={activity.sessionId}
      data-message-id={activity.itemId ?? undefined}
    >
      <ActivityRow
        presentation="message"
        icon={<MessageCircleIcon aria-hidden="true" />}
        title={
          <>
            <strong className="shrink-0 font-semibold">{agentName}</strong>{" "}
            <span className="text-muted-foreground">replied</span>
          </>
        }
        actions={action}
        summary={renderText(preview)}
      >
        {renderText(text)}
      </ActivityRow>
    </article>
  );
}
