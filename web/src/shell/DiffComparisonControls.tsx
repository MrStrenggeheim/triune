// Modified for Triune.
import { ContentSkeleton } from "@/components/ui/loading";
import { useEffect, useState } from "react";
import {
  CheckIcon,
  ChevronDownIcon,
  GitCompareIcon,
  GitCommitHorizontalIcon,
  HistoryIcon,
  MessageSquareIcon,
  WorkflowIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAgentTurnChoices } from "@/hooks/useWorkspaceComparisons";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SessionActionMenuItem } from "@/components/SessionActionMenuItem";
import {
  DEFAULT_WORKSPACE_COMPARISON,
  type ComparisonTurn,
  type WorkspaceComparison,
} from "@/lib/workspaceComparison";

export type DiffComparison = WorkspaceComparison;
export const DEFAULT_DIFF_COMPARISON = DEFAULT_WORKSPACE_COMPARISON;
export const REPOSITORY_COMPARISON_HINT =
  "Select a repository root as the panel folder to compare commits.";
const EMPTY_TURNS: ComparisonTurn[] = [];

const modes = [
  {
    source: "git",
    label: "Git",
    Icon: GitCompareIcon,
    detail: "HEAD → current files · all writers",
  },
  {
    source: "last-turn",
    label: "Turn",
    Icon: WorkflowIcon,
    detail: "Captured edits from one agent turn",
  },
  {
    source: "agent",
    label: "Chat",
    Icon: MessageSquareIcon,
    detail: "Captured agent edits in this conversation",
  },
  {
    source: "since",
    label: "Since",
    Icon: HistoryIcon,
    detail: "Commit → current files · all writers",
  },
  {
    source: "range",
    label: "Revisions",
    Icon: GitCommitHorizontalIcon,
    detail: "Two commits, or one commit and its parent",
  },
] as const;

export function DiffComparisonControls({
  value,
  onChange,
  repositoryRoot = false,
  turns = EMPTY_TURNS,
  compact = false,
  sessionId,
  scopePath = "",
}: {
  value: DiffComparison;
  onChange: (value: DiffComparison) => void;
  repositoryRoot?: boolean;
  turns?: ComparisonTurn[];
  compact?: boolean;
  sessionId?: string;
  scopePath?: string;
}) {
  const [editing, setEditing] = useState<"turn" | "since" | "range" | null>(null);
  const [base, setBase] = useState(value.base || "HEAD~1");
  const [target, setTarget] = useState(value.target === "WORKTREE" ? "HEAD" : value.target);
  const [single, setSingle] = useState(value.source === "commit");
  const [turnId, setTurnId] = useState(value.turnId ?? "latest");
  useEffect(() => {
    if (editing && editing !== "turn" && !repositoryRoot) setEditing(null);
  }, [repositoryRoot, editing]);
  const mode = modes.find((item) => item.source === value.source) ?? modes[4];
  const label = mode.label;
  const selectionDescription =
    value.source === "last-turn"
      ? value.turnId === "current"
        ? "Current agent turn"
        : (turns.find((turn) => turn.id === value.turnId)?.label ?? "Last completed agent turn")
      : mode.detail;
  const openEditor = (source: "turn" | "since" | "range") => {
    setBase(value.base);
    setTarget(value.target === "WORKTREE" ? "HEAD" : value.target);
    setTurnId(value.turnId ?? "latest");
    setSingle(value.source === "commit");
    setEditing(source);
  };
  const Icon = mode.Icon;
  return (
    <div
      className={
        compact
          ? "inline-flex min-w-0 shrink-0"
          : "workspace-control-header flex items-center gap-2 border-b border-border px-3 text-ui"
      }
    >
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Diff comparison"
            tooltip="Compare changes"
            tooltipDescription={`${label}: ${selectionDescription}`}
            className="h-7 min-w-0 max-w-44 gap-1 px-1.5 text-xs"
          >
            <Icon className="size-3.5 shrink-0" />
            <span className={compact ? "max-w-16 truncate" : "truncate"}>{label}</span>
            <ChevronDownIcon className="size-3 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-2rem)]">
          <DropdownMenuLabel>Compare changes</DropdownMenuLabel>
          {modes.map((item, index) => (
            <div key={item.source}>
              {index === 3 && <DropdownMenuSeparator />}
              <SessionActionMenuItem
                disabledReason={
                  index >= 3 && !repositoryRoot ? REPOSITORY_COMPARISON_HINT : undefined
                }
                onSelect={() => {
                  if (item.source === "git") onChange(DEFAULT_DIFF_COMPARISON);
                  else if (item.source === "agent")
                    onChange({ ...value, source: "agent", turnId: undefined });
                  else if (item.source === "last-turn") openEditor("turn");
                  else openEditor(item.source);
                }}
              >
                <item.Icon className="size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block">{item.label}</span>
                  <span className="block text-xs text-muted-foreground">{item.detail}</span>
                </span>
                {(value.source === item.source ||
                  (item.source === "range" && value.source === "commit")) && (
                  <CheckIcon className="size-3.5" />
                )}
              </SessionActionMenuItem>
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {!compact && (
        <span className="text-xs text-muted-foreground">
          {value.source === "git"
            ? "HEAD → current files"
            : value.source === "since"
              ? `${value.base} → current files`
              : value.source === "range" || value.source === "commit"
                ? `${value.base} → ${value.target}`
                : "Recorded agent edits · captured coverage"}
        </span>
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {editing === "turn"
                ? "Choose agent turn"
                : editing === "since"
                  ? "Changes since commit"
                  : "Compare revisions"}
            </DialogTitle>
            <DialogDescription>
              {editing === "turn"
                ? "Review captured edits from a completed turn, or explicitly select the current turn. Uncaptured edits remain unavailable."
                : "Compare versions in the repository selected as the panel root."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (editing === "turn")
                onChange({
                  ...value,
                  source: "last-turn",
                  turnId: turnId === "latest" ? undefined : turnId,
                });
              else if (repositoryRoot && editing)
                onChange({
                  source: editing === "since" ? "since" : single ? "commit" : "range",
                  base:
                    editing === "since" ? base.trim() : single ? `${target.trim()}^` : base.trim(),
                  target: editing === "since" ? "WORKTREE" : target.trim(),
                });
              setEditing(null);
            }}
          >
            {editing === "turn" ? (
              <Select value={turnId} onValueChange={setTurnId}>
                <SelectTrigger aria-label="Agent turn">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="latest">Last completed turn</SelectItem>
                  {sessionId ? (
                    <AgentTurnOptions sessionId={sessionId} path={scopePath} fallback={turns} />
                  ) : (
                    <TurnOptions turns={turns} />
                  )}
                </SelectContent>
              </Select>
            ) : (
              <>
                {editing === "range" && (
                  <Select
                    value={single ? "commit" : "range"}
                    onValueChange={(next) => setSingle(next === "commit")}
                  >
                    <SelectTrigger aria-label="Revision comparison type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="range">Two revisions</SelectItem>
                      <SelectItem value="commit">Single commit</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                {(editing === "since" || !single) && (
                  <label className="flex flex-col items-stretch gap-2">
                    {editing === "since" ? "Commit revision" : "Base revision"}
                    <Input
                      aria-label={editing === "since" ? "Commit revision" : "Base revision"}
                      value={base}
                      onChange={(event) => setBase(event.target.value)}
                      className="font-mono"
                    />
                  </label>
                )}
                {editing === "range" && (
                  <label className="flex flex-col items-stretch gap-2">
                    {single ? "Commit revision" : "Target revision"}
                    <Input
                      aria-label={single ? "Commit revision" : "Target revision"}
                      value={target}
                      onChange={(event) => setTarget(event.target.value)}
                      className="font-mono"
                    />
                  </label>
                )}
              </>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  editing !== "turn" &&
                  (!repositoryRoot ||
                    ((editing === "since" || !single) && !base.trim()) ||
                    (editing === "range" && !target.trim()))
                }
              >
                Compare
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TurnOptions({ turns }: { turns: ComparisonTurn[] }) {
  return turns.map((turn) => (
    <SelectItem key={turn.id} value={turn.id}>
      {turn.label}
      {turn.finished ? "" : " · in progress"}
    </SelectItem>
  ));
}

function AgentTurnOptions({
  sessionId,
  path,
  fallback,
}: {
  sessionId: string;
  path: string;
  fallback: ComparisonTurn[];
}) {
  const choices = useAgentTurnChoices(sessionId, path, true);
  return (
    <>
      <TurnOptions turns={choices.data?.turns ?? fallback} />
      {choices.isLoading && (
        <SelectItem value="loading" disabled>
          <ContentSkeleton label="Loading captured turns…" rows={1} className="w-40 p-0" />
        </SelectItem>
      )}
      {choices.isError && (
        <SelectItem value="error" disabled>
          {choices.error.message}
        </SelectItem>
      )}
    </>
  );
}
