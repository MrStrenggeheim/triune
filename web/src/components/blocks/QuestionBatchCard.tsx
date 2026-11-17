// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useState, type ReactNode } from "react";
import {
  ClockIcon,
  InfoIcon,
  MessageCircleCheckIcon,
  MessageCircleQuestionMark,
  XIcon,
} from "lucide-react";
import { ActivityRow } from "@/components/ActivityRow";
import { Badge } from "@/components/ui/badge";
import type { ClaudeQuestion } from "@/lib/askUserQuestion";
import type { ElicitationBlock } from "@/lib/blocks";
import { questionAnswer } from "@/lib/questionBatches";
import { QuestionMarkdown } from "./QuestionMarkdown";
import { QuestionPaginator } from "./QuestionPaginator";

export function QuestionBatchCard({
  questions,
  index,
  onIndexChange,
  status,
  response,
  children,
}: {
  questions: ClaudeQuestion[];
  index: number;
  onIndexChange: (index: number) => void;
  status: "pending" | "responded";
  response: ElicitationBlock["response"];
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(status === "pending");
  const current = questions[index] ?? questions[0];
  if (!current) return null;
  const pending = status === "pending";
  const action = response?.action;
  const label = pending
    ? "Needs input"
    : action === "accept"
      ? "Answered"
      : action === "decline"
        ? "Declined"
        : action === "cancel"
          ? "Cancelled"
          : response?.reason === "unanswered"
            ? "Prompt expired"
            : "Resolved elsewhere";
  const Icon = pending
    ? MessageCircleQuestionMark
    : action === "accept"
      ? MessageCircleCheckIcon
      : action === "decline"
        ? XIcon
        : response?.reason === "unanswered"
          ? ClockIcon
          : InfoIcon;
  const value = questionAnswer(current, response?.content);
  const redacted =
    (current.isSecret && value !== undefined) ||
    (Array.isArray(response?.["_meta"]?.redacted_questions) &&
      response["_meta"].redacted_questions.includes(current.id || current.question));
  const answer =
    action === "accept"
      ? redacted
        ? "Answer hidden"
        : value === undefined
          ? "Unanswered"
          : Array.isArray(value)
            ? value.join(", ") || "Empty answer"
            : String(value) || "Empty answer"
      : label;
  return (
    <ActivityRow
      presentation="message"
      icon={<Icon aria-hidden="true" />}
      expanded={expanded}
      onExpandedChange={setExpanded}
      keepMounted={pending}
      title={
        <>
          <strong className="shrink-0 font-semibold">{label}</strong>
          <span className="shrink-0 text-muted-foreground">·</span>
          {current.header && (
            <Badge variant="secondary" className="shrink-0 font-normal text-muted-foreground">
              {current.header}
            </Badge>
          )}
          <span className="min-w-0 truncate text-muted-foreground">
            <QuestionMarkdown>{current.question}</QuestionMarkdown>
          </span>
        </>
      }
      summary={pending ? "" : <span className="text-foreground">{answer}</span>}
      descriptionText={`${current.question}${pending ? "" : ` ${answer}`}`}
      actions={
        <QuestionPaginator index={index} count={questions.length} onChange={onIndexChange} />
      }
    >
      {pending ? (
        children
      ) : (
        <div className="min-w-0 whitespace-pre-wrap break-words">
          <p className="text-foreground">{answer}</p>
        </div>
      )}
    </ActivityRow>
  );
}
