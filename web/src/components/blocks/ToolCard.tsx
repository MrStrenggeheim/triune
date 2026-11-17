// Modified for Triune.
import {
  useTranscriptDisclosureState,
  transcriptDisclosureItemKey,
} from "@/lib/transcriptReaderCheckpoint";
import { useTranscriptDisclosureAnchor } from "@/hooks/useTranscriptDisclosureAnchor";
import { useInlinePreviewBoundary } from "@/artifacts/inlinePreviewBoundary";
import { useWrapPreference } from "@/hooks/useWrapPreference";
// Tool-call renderer. Renders each call as a single muted-text trigger
// line (status icon + truncated `name(argsSummary)`); clicking expands an
// indented panel with the parameters JSON and output preview. The big
// border-stripe / badge / pill card shell was removed deliberately — tool
// calls used to dominate the transcript, and the goal is for the
// assistant's prose to read first.

import {
  CheckIcon,
  ChevronRightIcon,
  CircleSlashIcon,
  CopyIcon,
  Loader2Icon,
  Maximize2Icon,
  Minimize2Icon,
  WrapTextIcon,
  XCircleIcon,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChatSearchRevealContext } from "@/lib/chatSearchHighlights";
import { readSubagentActivity, subagentCardItemIds } from "@/lib/subagentActivity";
import { SubagentActivityMessage } from "./SubagentActivityMessage";
import {
  CodeBlock,
  CodeBlockActions,
  type CodeColorScheme,
  type CodeLanguage,
  CodeBlockContainer,
  CodeBlockContent,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import { useResolvedThemeMode } from "@/components/theme/useResolvedThemeMode";
import { useTerminalIsDark } from "@/components/theme/useTerminalIsDark";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { RenderItem, ToolState } from "@/lib/renderItems";
import { dropTrailingPartialEscape, showControlCharacters, stripAnsi } from "@/lib/ansi";
import { type ShellOutputFormat, parseShellToolOutput } from "@/lib/shellToolOutput";
import { terminalSurfaceStyle } from "@/lib/terminalPalette";
import { iconForTool } from "@/lib/toolIcon";
import {
  type ToolRunCall,
  type ToolTitle,
  formatToolRunLabel,
  formatToolTitle,
  shellCommandPreview,
  shellToolCall,
  splitEnvPrefix,
} from "@/lib/toolTitle";
import { resolveChatFilePath } from "@/hooks/useWorkspaceChangedFiles";
import { useFileViewer, useWorkspacePaths } from "@/shell/FileViewerContext";

const OUTPUT_PREVIEW_LINE_LIMIT = 80;
const OUTPUT_PREVIEW_CHAR_LIMIT = 12_000;

/**
 * If the string is valid JSON, return its 2-space-indented form.
 * Otherwise return the string verbatim. The code block renders inside a
 * `<pre>`, so a compact one-line JSON payload otherwise becomes a single
 * horizontal-scrolling line.
 */
function prettyPrintIfJson(s: string): string {
  try {
    const parsed: unknown = JSON.parse(s);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return s;
  }
}

export function formatToolDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0ms";
  }

  if (seconds < 1) {
    return `${Math.max(1, Math.round(seconds * 1000))}ms`;
  }

  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (totalSeconds < 60 * 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

interface OutputPreview {
  text: string;
  isTruncated: boolean;
  lineCount: number;
  charCount: number;
  shownLineCount: number;
  shownCharCount: number;
  hiddenLineCount: number;
  hiddenCharCount: number;
}

export function getOutputPreview(output: string, expanded = false): OutputPreview {
  const lines = output.length === 0 ? [] : output.split("\n");
  const lineCount = lines.length;
  const charCount = output.length;

  if (
    expanded ||
    (lineCount <= OUTPUT_PREVIEW_LINE_LIMIT && charCount <= OUTPUT_PREVIEW_CHAR_LIMIT)
  ) {
    return {
      text: output,
      isTruncated: false,
      lineCount,
      charCount,
      shownLineCount: lineCount,
      shownCharCount: charCount,
      hiddenLineCount: 0,
      hiddenCharCount: 0,
    };
  }

  let text =
    lineCount > OUTPUT_PREVIEW_LINE_LIMIT
      ? lines.slice(0, OUTPUT_PREVIEW_LINE_LIMIT).join("\n")
      : output;

  if (text.length > OUTPUT_PREVIEW_CHAR_LIMIT) {
    text = text.slice(0, OUTPUT_PREVIEW_CHAR_LIMIT).trimEnd();
  }

  const shownLineCount = text.length === 0 ? 0 : text.split("\n").length;
  const shownCharCount = text.length;

  return {
    text,
    isTruncated: shownCharCount < charCount,
    lineCount,
    charCount,
    shownLineCount,
    shownCharCount,
    hiddenLineCount: Math.max(0, lineCount - shownLineCount),
    hiddenCharCount: Math.max(0, charCount - shownCharCount),
  };
}

interface ToolCardProps {
  /** Presentation identity; never a tool execution or API target. */
  disclosureKey?: string;
  /** Display name for the tool. For native tools, this is the friendly label. */
  name: string;
  /**
   * Set for native (provider-managed) tools — the underlying type
   * (e.g. "web_search_call"). Used to pick the category icon.
   */
  nativeToolType?: string;
  /** Brief one-line summary of arguments shown next to the name. */
  argsSummary?: string;
  /** Full args dict, rendered as JSON in the expanded panel. */
  arguments: Record<string, unknown>;
  /** Tool output, or null if not yet available / never produced. */
  output: string | null;
  state: ToolState;
  /** Seconds from the page's performance clock when the tool call rendered. */
  startedAt?: number | null;
  /** Completed runtime in seconds. Undefined when historical data lacks timing. */
  duration?: number;
}

export function ToolCard({
  disclosureKey,
  name,
  nativeToolType,
  argsSummary,
  arguments: args,
  output,
  state,
  startedAt,
  duration,
}: ToolCardProps) {
  const [savedOpen, rememberOpen] = useTranscriptDisclosureState(disclosureKey);
  const [open, setOpen] = useState(savedOpen ?? false);
  const preserveDisclosure = useTranscriptDisclosureAnchor();
  const title = useMemo(() => formatToolTitle(name, args, argsSummary), [name, args, argsSummary]);
  const shellCall = useMemo(() => shellToolCall(name, args), [name, args]);
  const inputJson = useMemo(() => JSON.stringify(args, null, 2), [args]);
  const formattedOutput = useMemo(
    () => (output === null ? null : prettyPrintIfJson(output)),
    [output],
  );
  const elapsedDuration = useElapsedDuration(state === "input-available" ? startedAt : null);
  const displayDuration = duration ?? elapsedDuration;

  // Link a file tool's path to the FileViewer, resolved like chat file links.
  const openFile = useFileViewer();
  const { root, home } = useWorkspacePaths();
  const linkPath =
    title.filePath === undefined
      ? null
      : (resolveChatFilePath(title.filePath, root, home)?.path ?? null);
  const onBodyClick = openFile && linkPath ? () => openFile(linkPath) : undefined;

  return (
    <Collapsible
      onClickCapture={preserveDisclosure}
      open={open}
      onOpenChange={(next) => {
        rememberOpen(next);
        setOpen(next);
      }}
      className="group not-prose w-full"
    >
      <ToolTriggerRow
        title={title}
        name={name}
        nativeToolType={nativeToolType}
        state={state}
        duration={displayDuration}
        onBodyClick={onBodyClick}
      />
      <CollapsibleContent className="mt-1 ml-1 space-y-2 border-l-2 border-border pl-3 py-1 data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=open]:animate-in">
        {shellCall !== null ? (
          <ShellTerminalPanel
            command={shellCall.command}
            outputFormat={shellCall.outputFormat}
            argsCwd={typeof args.cwd === "string" && args.cwd.length > 0 ? args.cwd : null}
            inputJson={inputJson}
            output={output}
            state={state}
          />
        ) : (
          <>
            <OutputSection title="Parameters" output={inputJson} />
            {formattedOutput !== null && <OutputSection output={formattedOutput} />}
            {formattedOutput === null && state === "input-available" && (
              <ToolPendingOutput duration={displayDuration} />
            )}
          </>
        )}
        {shellCall === null &&
          output === null &&
          (state === "output-error" || state === "cancelled" || state === "no-output") && (
            <EmptyOutputState state={state} />
          )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Render the folded (older) part of a contiguous tool run as one muted
 * summary line ("Read 2 files"). Clicking expands to show each tool as
 * its own (also-collapsible) trigger. `BlockRenderer` decides which
 * tools fold here: older tools once the visible tail of the most
 * recent ones has been peeled off.
 */
export function ToolGroupSummary({ tools }: { tools: RenderItem[] }) {
  const preserveDisclosure = useTranscriptDisclosureAnchor();
  const label = formatToolRunLabel(tools.map(toolRunCall));
  const reveal = useContext(ChatSearchRevealContext);
  const requested = tools.some(
    (item) =>
      item.kind === "subagent_activity" &&
      subagentCardItemIds(item.data).some((id) => reveal?.revealedItems.has(id)),
  );
  const revealRevision = requested ? (reveal?.revealRequest?.revision ?? 0) : undefined;
  const firstKey = transcriptDisclosureItemKey(tools[0]);
  const [savedOpen, rememberOpen] = useTranscriptDisclosureState(
    firstKey ? `tool-group:${firstKey}` : undefined,
    revealRevision ? JSON.stringify([reveal?.revealRequest?.itemId, revealRevision]) : undefined,
  );
  const [groupChoice, setGroupChoice] = useState(() => ({
    key: firstKey,
    open: savedOpen ?? requested,
  }));
  const open = groupChoice.key === firstKey ? groupChoice.open : (savedOpen ?? requested);
  if (groupChoice.key !== firstKey) setGroupChoice({ key: firstKey, open });
  useEffect(() => {
    if (revealRevision !== undefined && savedOpen === undefined)
      setGroupChoice({ key: firstKey, open: true });
  }, [revealRevision, savedOpen, firstKey]);
  return (
    // Named `group/tool-summary` so this collapsible only rotates its
    // OWN chevron (line 296 in `ToolTriggerRow` uses an unnamed
    // `group-data-[state=open]:rotate-90` that would otherwise match
    // any ancestor `.group[data-state=open]` and incorrectly rotate
    // chevrons of inner tool cards when this outer group is open).
    <Collapsible
      onClickCapture={preserveDisclosure}
      open={open}
      onOpenChange={(next) => {
        rememberOpen(next);
        setGroupChoice({ key: firstKey, open: next });
      }}
      className="group/tool-summary not-prose w-full"
    >
      <CollapsibleTrigger className="flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-sm py-0.5 text-left text-muted-foreground text-chat transition-colors hover:text-foreground">
        <span>{label}</span>
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/tool-summary:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 space-y-1 border-t border-border/60 pt-1 data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=open]:animate-in">
        {tools.map((item) => {
          if (item.kind === "subagent_activity") {
            const resource = item.data.resource as Record<string, unknown> | undefined;
            return (
              <SubagentActivityMessage
                key={
                  typeof resource?.card_key === "string"
                    ? resource.card_key
                    : `activity:${item.itemId}`
                }
                data={item.data}
              />
            );
          }
          if (item.kind === "tool") {
            return (
              <ToolCard
                key={transcriptDisclosureItemKey(item)}
                disclosureKey={transcriptDisclosureItemKey(item)}
                name={item.execution.name}
                argsSummary={item.execution.argsSummary}
                arguments={item.execution.arguments}
                output={item.output}
                state={item.state}
                startedAt={item.startedAt}
                duration={item.duration}
              />
            );
          }
          if (item.kind === "native_tool") {
            return (
              <ToolCard
                key={`native:${item.itemId ?? item.label}`}
                disclosureKey={transcriptDisclosureItemKey(item)}
                name={item.label}
                nativeToolType={item.toolType}
                arguments={item.data}
                output={null}
                state="output-available"
              />
            );
          }
          return null;
        })}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Tool name + args used to categorize a run item for the summary label. */
function toolRunCall(item: RenderItem): ToolRunCall {
  if (item.kind === "subagent_activity") {
    const activity = readSubagentActivity(item.data);
    const resource = item.data.resource as Record<string, unknown> | undefined;
    const status =
      typeof resource?.card_status === "string" ? resource.card_status : activity?.status;
    return {
      name: "subagent_activity",
      activityKey:
        typeof resource?.card_key === "string"
          ? resource.card_key
          : (activity?.sessionId ?? item.itemId ?? undefined),
      pending: status
        ? ["running", "starting", "pending", "queued", "waiting", "busy"].includes(status)
        : activity?.phase === "delegated",
    };
  }
  if (item.kind === "tool") {
    return { name: item.execution.name, args: item.execution.arguments };
  }
  if (item.kind === "native_tool") return { name: item.toolType, args: item.data };
  return { name: "" };
}

/**
 * Single muted-text trigger line for a tool call. Status/category icon
 * at left, title (verb bold + dynamic body) in the middle truncated to
 * one line, optional duration on the right, chevron at the far right.
 */
function ToolTriggerRow({
  title,
  name,
  nativeToolType,
  state,
  duration,
  onBodyClick,
}: {
  title: ToolTitle;
  name: string;
  nativeToolType: string | undefined;
  state: ToolState;
  duration: number | undefined;
  /** When set, the body text (e.g. file path) is rendered as a clickable link. */
  onBodyClick?: () => void;
}) {
  return (
    <CollapsibleTrigger className="flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-sm py-0.5 text-left text-muted-foreground text-chat transition-colors hover:text-foreground">
      <StatusIcon name={name} nativeToolType={nativeToolType} state={state} />
      <span className="min-w-0 flex-1 truncate">
        {title.verb !== null && <span className="font-semibold text-foreground">{title.verb}</span>}
        {title.verb !== null && title.body.length > 0 && " "}
        <ToolTitleBody title={title} onBodyClick={onBodyClick} />
      </span>
      {duration !== undefined && (
        <span className="shrink-0 tabular-nums opacity-70">{formatToolDuration(duration)}</span>
      )}
      <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
    </CollapsibleTrigger>
  );
}

/** The dynamic part of a trigger row: a shell command, a linked file path, or plain text. */
function ToolTitleBody({ title, onBodyClick }: { title: ToolTitle; onBodyClick?: () => void }) {
  if (title.isShellCommand === true) return <ShellCommandLine command={title.body} />;
  if (!onBodyClick) return title.body;
  return (
    // Use <span role="link"> instead of <button> to avoid nesting
    // interactive elements — CollapsibleTrigger already renders as
    // a <button>, and nested buttons are invalid HTML.
    <span
      role="link"
      tabIndex={0}
      className="text-link underline decoration-dotted underline-offset-2 hover:decoration-solid transition-colors cursor-pointer"
      onClick={(e) => {
        e.stopPropagation();
        onBodyClick();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault(); // prevent Space from triggering parent button's click via keyup
          e.stopPropagation();
          onBodyClick();
        }
      }}
    >
      {title.body}
    </span>
  );
}

/** Collapsed-row command: a script's first line, and a count of the rest. */
function ShellCommandLine({ command }: { command: string }) {
  const { firstLine, moreLines } = shellCommandPreview(command);
  const { env, rest } = splitEnvPrefix(firstLine);
  return (
    // Only the command truncates, so the line count stays visible.
    <span className="inline-flex max-w-full items-baseline font-mono text-[0.92em]">
      <span className="min-w-0 truncate">
        {env.length > 0 && <span className="opacity-60">{env}</span>}
        <span>{rest}</span>
      </span>
      {moreLines > 0 && (
        <>
          {" "}
          <span className="ml-1.5 shrink-0 font-sans opacity-60">
            +{moreLines} {moreLines === 1 ? "line" : "lines"}
          </span>
        </>
      )}
    </span>
  );
}

/**
 * Expanded view for shell tools: the working directory, `$ command`, and
 * the output in one terminal-like block, with exit status in the footer.
 * The raw argument JSON stays one click away for debugging.
 */
function ShellTerminalPanel({
  command,
  outputFormat,
  argsCwd,
  inputJson,
  output,
  state,
}: {
  command: string;
  outputFormat: ShellOutputFormat;
  /** Working directory from the call's arguments (Codex sends one). */
  argsCwd: string | null;
  inputJson: string;
  output: string | null;
  state: ToolState;
}) {
  const [wrap, setWrap] = useWrapPreference("tool-input");
  const [outputWrap, setOutputWrap] = useWrapPreference("tool-output");
  const [showRaw, setShowRaw] = useState(false);
  const terminalIsDark = useTerminalIsDark();
  const appIsDark = useResolvedThemeMode() === "dark";
  // The terminal theme setting can pin the scheme the app is not in; repaint
  // just this block then, and otherwise keep the app's own palette.
  let pinnedScheme: CodeColorScheme | undefined;
  if (terminalIsDark !== appIsDark) pinnedScheme = terminalIsDark ? "dark" : "light";
  const parsed = useMemo(
    () => (output === null ? null : parseShellToolOutput(output, outputFormat)),
    [output, outputFormat],
  );
  const rawOutput = useMemo(
    () => (output === null ? null : showControlCharacters(prettyPrintIfJson(output))),
    [output],
  );
  const hasOutput = parsed !== null && parsed.text.length > 0;
  // sys_os_shell reports its working directory in the result instead.
  const cwd = argsCwd ?? parsed?.cwd ?? null;
  // With no cwd line the actions sit with the command: floated so only its
  // first line wraps around them, or on a sticky row when lines do not wrap or
  // the card is too narrow to share a line. Only classes change, so focus stays.
  const actionsBesideCommand = cwd === null;
  const actions = (
    <CodeBlockActions className="my-0 mr-0 ml-auto shrink-0 gap-1 @max-[480px]/shell:-ml-1">
      <WrapTextButton onToggle={() => setWrap((value) => !value)} wrap={wrap} />
      <CopyTextButton label="Copy command" caption="command" text={command} />
      {hasOutput && (
        <CopyTextButton label="Copy output" caption="output" text={stripAnsi(parsed.text)} />
      )}
      <Button
        aria-pressed={showRaw}
        className={cn("h-6 px-1.5 text-muted-foreground", showRaw && "text-foreground")}
        onClick={() => setShowRaw((value) => !value)}
        size="xs"
        type="button"
        variant="ghost"
        componentId="diagnostics.tool.toggle_raw_parameters"
      >
        Raw
      </Button>
    </CodeBlockActions>
  );
  return (
    <div className="space-y-2">
      <CodeBlockContainer
        language="bash"
        data-testid="shell-tool-terminal"
        data-terminal-theme={terminalIsDark ? "dark" : "light"}
        className="@container/shell"
        style={pinnedScheme === undefined ? undefined : terminalSurfaceStyle(terminalIsDark)}
      >
        <OutputSection
          output={command}
          title="Command"
          renderPanel={(text) => (
            <>
              {cwd !== null && (
                // On a narrow card the folder takes its own line and the actions wrap below
                // it, left-aligned with the text.
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 pt-1.5">
                  <span
                    className="min-w-0 truncate font-mono text-muted-foreground text-xs @max-[480px]/shell:basis-full"
                    title={cwd}
                  >
                    {cwd}
                  </span>
                  {actions}
                </div>
              )}
              {/* The `$` prompt is a pseudo-element so selecting or copying the command skips it. */}
              <div className={SHELL_COMMAND_LINES_CLASS} style={SHELL_PROMPT_STYLE}>
                <CodeBlockContent
                  code={text}
                  language="bash"
                  wrap={wrap}
                  colorScheme={pinnedScheme}
                  className={cn(
                    TERMINAL_PRE_CLASS,
                    actionsBesideCommand && wrap
                      ? "pt-2 pb-1 @max-[480px]/shell:pt-1"
                      : "pt-1 pb-1",
                  )}
                  leading={
                    actionsBesideCommand ? (
                      <div
                        className={
                          wrap
                            ? "float-right mt-1.5 mr-3 -mb-1 ml-2 @max-[480px]/shell:float-none @max-[480px]/shell:m-0 @max-[480px]/shell:flex @max-[480px]/shell:px-3 @max-[480px]/shell:pt-1.5"
                            : "sticky left-0 flex justify-end px-3 pt-1.5 @max-[480px]/shell:justify-start"
                        }
                      >
                        {actions}
                      </div>
                    ) : undefined
                  }
                />
              </div>
            </>
          )}
        />
        {hasOutput && (
          <div className="border-t border-border/60 pt-1" data-tool-section="output">
            <OutputSection
              output={parsed.text}
              renderPanel={(text) => (
                <>
                  <div className="flex items-center justify-between px-3 text-xs text-muted-foreground">
                    <span>Output</span>
                    <WrapTextButton
                      onToggle={() => setOutputWrap((value) => !value)}
                      wrap={outputWrap}
                      kind="output"
                    />
                  </div>
                  <CodeBlockContent
                    code={dropTrailingPartialEscape(text)}
                    language="ansi"
                    wrap={outputWrap}
                    colorScheme={pinnedScheme}
                    className={cn(TERMINAL_PRE_CLASS, "pt-0 pb-2")}
                  />
                </>
              )}
            />
          </div>
        )}
        {parsed !== null && !hasOutput && (
          <div className="px-3 pb-2 font-mono text-muted-foreground text-xs">(no output)</div>
        )}
        <ShellStatus
          state={state}
          exitCode={parsed?.exitCode ?? null}
          timedOut={parsed?.timedOut ?? false}
          outputRecorded={output !== null}
        />
      </CodeBlockContainer>
      {showRaw && (
        <>
          <OutputSection title="Parameters" output={inputJson} />
          {rawOutput !== null && (
            <OutputSection
              output={rawOutput}
              language={outputFormat === "sys-os-json" ? "json" : "text"}
            />
          )}
        </>
      )}
    </div>
  );
}

// A non-breaking space keeps the prompt on the same line as the first word.
const SHELL_PROMPT_STYLE = { "--shell-prompt": '"$\u00a0"' } as CSSProperties;

// One prompt for the whole script, like a pasted block in a terminal. Wrapped
// text indents past it so it doesn't read as a new line.
const SHELL_COMMAND_LINES_CLASS =
  "[&_code>span]:pl-[2ch] [&_code>span]:-indent-[2ch] [&_code>span:first-child]:before:font-semibold [&_code>span:first-child]:before:text-muted-foreground [&_code>span:first-child]:before:content-[var(--shell-prompt)]";

// Command and output share the panel's own background so the block reads as
// one continuous terminal surface instead of stacked code panels.
const TERMINAL_PRE_CLASS = "px-3 !bg-transparent dark:!bg-transparent";

/** Status line under the output; omitted when there is nothing to report. */
function ShellStatus({
  state,
  exitCode,
  timedOut,
  outputRecorded,
}: {
  state: ToolState;
  exitCode: number | null;
  timedOut: boolean;
  /** Whether the call recorded any output string, even an empty one. */
  outputRecorded: boolean;
}) {
  let status: ReactNode;
  if (state === "input-available") {
    status = (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Loader2Icon className="size-3 animate-spin text-info" />
        running
      </span>
    );
  } else if (timedOut) {
    status = <span className="text-destructive">timed out</span>;
  } else if (exitCode !== null) {
    status = (
      <span className={exitCode === 0 ? "text-success" : "text-destructive"}>exit {exitCode}</span>
    );
  } else if (state === "output-error") {
    status = <span className="text-destructive">failed</span>;
  } else if (state === "cancelled") {
    status = <span className="text-muted-foreground">cancelled</span>;
  } else if (state === "no-output" && !outputRecorded) {
    status = <span className="text-muted-foreground">no output recorded</span>;
  } else {
    return null;
  }
  return <div className="px-3 pb-2 font-mono text-xs tabular-nums">{status}</div>;
}

/**
 * Icon shown at the start of a tool-call row. The transient states
 * (running / errored / cancelled) take priority so the user sees an
 * unambiguous progress signal; once the tool has completed cleanly we
 * fall back to a category icon picked from the tool name.
 */
function StatusIcon({
  name,
  nativeToolType,
  state,
}: {
  name: string;
  nativeToolType: string | undefined;
  state: ToolState;
}): ReactNode {
  if (state === "input-available") {
    // Slightly larger and tinted so the running indicator is the one
    // thing in the row that actively draws the eye.
    return <Loader2Icon className="size-3.5 shrink-0 animate-spin text-info" />;
  }
  if (state === "output-error") {
    return <XCircleIcon className="size-3.5 shrink-0 text-destructive" />;
  }
  if (state === "cancelled" || state === "no-output") {
    // Turn over, no output recorded — muted slash, not the error icon.
    return <CircleSlashIcon className="size-3.5 shrink-0" />;
  }
  const Icon = iconForTool(name, nativeToolType);
  return <Icon className="size-3.5 shrink-0" />;
}

function CodePanel({
  title,
  text,
  copyText,
  copyLabel,
  language = "json",
}: {
  title: string;
  text: string;
  copyText: string;
  copyLabel: string;
  language?: CodeLanguage;
}) {
  // Soft-wrap long lines by default so the panel never needs horizontal
  // scrolling to read; the toggle restores the scrolling view for when
  // column alignment matters (same affordance as chat code blocks).
  const [wrap, setWrap] = useWrapPreference(
    title.includes("output") || title === "Output" ? "tool-output" : "tool-input",
  );
  return (
    <CodeBlock code={text} language={language} wrap={wrap}>
      <CodeBlockHeader>
        <CodeBlockTitle className="min-w-0">
          <span className="truncate font-medium uppercase tracking-wide">{title}</span>
        </CodeBlockTitle>
        <CodeBlockActions>
          <WrapTextButton onToggle={() => setWrap((value) => !value)} wrap={wrap} />
          <CopyTextButton label={copyLabel} text={copyText} />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
}

function WrapTextButton({
  wrap,
  onToggle,
  kind,
}: {
  wrap: boolean;
  onToggle: () => void;
  kind?: string;
}) {
  const label = `${wrap ? "Disable" : "Enable"} ${kind ? `${kind} ` : ""}word wrap`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={label}
          aria-pressed={wrap}
          className={cn("size-6 text-muted-foreground", wrap && "text-foreground")}
          onClick={onToggle}
          size="icon-xs"
          type="button"
          variant="ghost"
          componentId="diagnostics.tool.toggle_wrap"
        >
          <WrapTextIcon className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function OutputSection({
  output,
  renderPanel,
  language,
  title = "Output",
}: {
  output: string;
  renderPanel?: (text: string) => ReactNode;
  language?: CodeLanguage;
  title?: string;
}) {
  const preserveDisclosure = useTranscriptDisclosureAnchor();
  const [isExpanded, setIsExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const boundary = useInlinePreviewBoundary(container, true);
  const [expandedHeight, setExpandedHeight] = useState<number>();
  const collapsedPreview = useMemo(() => getOutputPreview(output), [output]);
  const preview = useMemo(() => getOutputPreview(output, isExpanded), [output, isExpanded]);
  useLayoutEffect(() => {
    const measure = () => {
      if (!isExpanded && body.current && content.current)
        setOverflows(content.current.scrollHeight > body.current.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (body.current) observer.observe(body.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [output, isExpanded]);
  const canExpand = collapsedPreview.isTruncated || overflows || isExpanded;
  return (
    <div
      ref={container}
      data-tool-reading-box
      className="relative flex min-h-0 flex-col overflow-hidden rounded-md"
      style={{
        maxHeight: `min(320px, ${boundary?.maxHeight ?? "60dvh"})`,
        height: isExpanded ? expandedHeight : undefined,
      }}
      onClickCapture={preserveDisclosure}
    >
      <div ref={body} className={cn("min-h-0", isExpanded ? "overflow-auto" : "overflow-hidden")}>
        <div ref={content}>
          {renderPanel ? (
            renderPanel(preview.text)
          ) : (
            <CodePanel
              title={title}
              text={preview.text}
              copyText={output}
              copyLabel={`Copy ${title.toLowerCase()}`}
              language={language}
            />
          )}
        </div>
      </div>
      {canExpand && (
        <div className="relative flex shrink-0 items-center gap-2 bg-background px-2 py-1 text-xs text-muted-foreground">
          {!isExpanded && (
            <div className="pointer-events-none absolute inset-x-0 bottom-full h-8 bg-gradient-to-t from-background to-transparent" />
          )}
          <Button
            className="shrink-0"
            aria-expanded={isExpanded}
            size="xs"
            type="button"
            variant="ghost"
            onClick={() => {
              if (!isExpanded) setExpandedHeight(container.current?.getBoundingClientRect().height);
              setIsExpanded((value) => !value);
            }}
            componentId="diagnostics.tool.toggle_expanded"
          >
            {isExpanded ? (
              <Minimize2Icon className="size-3" />
            ) : (
              <Maximize2Icon className="size-3" />
            )}
            {isExpanded ? "Collapse" : "Expand"}
          </Button>
          <span className="min-w-0 truncate">
            {isExpanded
              ? `${output.length.toLocaleString()} characters`
              : collapsedPreview.hiddenCharCount
                ? `${collapsedPreview.hiddenCharCount.toLocaleString()} characters omitted`
                : `${collapsedPreview.lineCount.toLocaleString()} lines`}
          </span>
        </div>
      )}
    </div>
  );
}

function ToolPendingOutput({ duration }: { duration: number | undefined }) {
  return (
    <div className="py-1">
      <div className="flex items-center gap-2 text-muted-foreground text-ui">
        <Loader2Icon className="size-4 animate-spin text-info" />
        <span>
          Waiting for output
          {duration !== undefined ? ` for ${formatToolDuration(duration)}` : ""}
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full w-1/3 animate-pulse rounded-full bg-info/70" />
      </div>
    </div>
  );
}

function EmptyOutputState({ state }: { state: "output-error" | "cancelled" | "no-output" }) {
  let message: string;
  if (state === "cancelled") {
    message = "Tool was cancelled before output arrived.";
  } else if (state === "no-output") {
    message = "No output was recorded for this tool call.";
  } else {
    message = "Tool did not return output before the response failed.";
  }
  return <div className="py-1 text-muted-foreground text-ui">{message}</div>;
}

interface CopyTextButtonProps {
  text: string;
  label: string;
  /** Visible text next to the icon, for when several copy buttons sit together. */
  caption?: string;
}

function CopyTextButton({ text, label, caption }: CopyTextButtonProps) {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);

  const copyToClipboard = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }

    setIsCopied(true);
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = window.setTimeout(() => setIsCopied(false), 2000);
  }, [text]);

  useEffect(
    () => () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    },
    [],
  );

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          aria-label={isCopied ? "Copied" : label}
          className={cn("text-muted-foreground", caption ? "h-6 gap-1 px-1.5" : "size-6")}
          onClick={copyToClipboard}
          size={caption ? "xs" : "icon-xs"}
          type="button"
          variant="ghost"
          componentId="diagnostics.tool.copy"
        >
          <Icon className="size-3.5" />
          {caption}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{isCopied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}

function useElapsedDuration(startedAt: number | null | undefined): number | undefined {
  const [now, setNow] = useState(() => getNowSeconds());

  useEffect(() => {
    if (startedAt === null || startedAt === undefined) {
      return;
    }

    setNow(getNowSeconds());
    const interval = window.setInterval(() => setNow(getNowSeconds()), 500);
    return () => window.clearInterval(interval);
  }, [startedAt]);

  if (startedAt === null || startedAt === undefined) {
    return undefined;
  }

  return Math.max(0, now - startedAt);
}

function getNowSeconds(): number {
  if (typeof performance !== "undefined") {
    return performance.now() / 1000;
  }
  return Date.now() / 1000;
}
