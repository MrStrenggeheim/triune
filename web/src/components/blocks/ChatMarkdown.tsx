import {
  ChatAttachmentContext,
  ChatAttachment,
  InlineFileReference,
  InlinePathCode,
  FilePreviewMenu,
} from "@/components/ChatAttachment";
import { useScopedConversationId } from "@/components/chat/conversationScope";
// Markdown rendering for chat text: assistant bubbles, user bubbles, and any
// other surface that shows agent-authored markdown.
//
// Two affordances beyond plain markdown, both routing to the workspace preview so a
// file the agent names is one click away:
//
//   1. Inline-code paths (`` `src/App.tsx` ``): see `WorkspacePathInlineCode`.
//   2. Markdown links whose href is a file path: see `WorkspaceFileLink`.
//
// Lives apart from `BlockRenderer` so approval cards can render agent markdown
// without importing the block dispatcher that renders them.

import type React from "react";
import { isValidElement, useMemo, useContext, lazy, Suspense } from "react";
import { GitPullRequestIcon } from "lucide-react";
import { defaultRemarkPlugins } from "streamdown";
import remarkBreaks from "remark-breaks";
import { normalizeExplicitMathDelimiters } from "@/components/ai-elements/mathMarkdown";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  splitWorkspaceFileCitation,
  WORKSPACE_FILE_LINK_ATTR,
  WORKSPACE_IMAGE_ATTR,
} from "@/components/ai-elements/streamdown-security";
import { ZoomableImage } from "@/components/ImageLightbox";
import { VideoPlayer } from "@/components/VideoPlayer";
import { isRemoteVideoUrl, isVideoFile } from "@/lib/video";
import { useThrottledValue } from "@/hooks/useThrottledValue";
import { withBasePath } from "@/lib/basePath";
import { absoluteWorkspacePath } from "@/lib/composerContext";
import { followLinkWithPopupFallback } from "@/lib/openLinkInApp";
import { cn } from "@/lib/utils";
import {
  useFileViewer,
  useFileViewerConversationId,
  useIsChangedPath,
  useWorkspacePaths,
} from "@/shell/FileViewerContext";
import {
  looksLikeWorkspaceFilePath,
  resolveChatFilePath,
  useWorkspaceFileExists,
} from "@/hooks/useWorkspaceChangedFiles";
import { showToast } from "@/components/ui/toast";
import { canonicalSessionImages, parseSessionFileSource } from "@/lib/remoteImagePolicy";
import { MediaBatch, remarkMediaBatches } from "@/components/MediaBatch";
import { splitArtifactMarkdown } from "@/artifacts/artifactProtocol";

const UploadedArtifact = lazy(() =>
  import("@/artifacts/UploadedArtifact").then((module) => ({ default: module.UploadedArtifact })),
);

// Streamdown hands each component override the source hast node alongside the
// element's own props. Overrides here spread their props onto a DOM element, so
// they destructure `node` away first. Left in, it renders as a literal
// node="[object Object]" attribute.
type WithHastNode<T> = T & { node?: unknown };

/** What the chat renderers know about a cited path's openability. */
interface WorkspaceFileOpener {
  /**
   * Click handler opening the file in the FileViewer, or null when the text
   * isn't an openable file (no FileViewer, unresolvable path, or no such
   * file).
   */
  open: (() => void) | null;
  /**
   * True when the path is *definitively* not openable — resolution rejected
   * it outright (traversal segments, the root itself, …), or a parent
   * listing genuinely completed without finding it. False while the check is
   * still in flight, skipped, errored, or waiting on the workspace root, so
   * a link renderer can distinguish "known dead" (give the user feedback)
   * from "not verified yet" (stay inert).
   */
  unopenable: boolean;
  /** The path resolution produced, for feedback messaging; "" when none. */
  resolvedPath: string;
  /** Clipboard path: host-absolute when the root is known, else the cited path. */
  copyPath: string;
}

/**
 * Resolves `text` to an openable file, returning the click handler that opens
 * it in the FileViewer plus the openability verdict. Shared by the
 * inline-code and link renderers so both judge a path the same way.
 */
function useWorkspaceFileOpener(text: string, explicitLink = false): WorkspaceFileOpener {
  const openFile = useFileViewer();
  const isChangedPath = useIsChangedPath();
  const conversationId = useFileViewerConversationId();
  const { root, home } = useWorkspacePaths();

  // Agents cite a file with the position they mean, `docs/notes.md:12` or
  // `:12:7`. The position is not part of the filename, so no such path is ever
  // in the changed-files list or on disk; drop it before resolving, but keep
  // the line so the viewer can land on the cited change.
  const citation = splitWorkspaceFileCitation(text);
  const cited = citation.path;
  const citedLine = citation.line;
  // Collapse absolute / "~"-relative forms onto a workspace-relative path
  // (matching the changed-files list and relative filesystem routes), or keep
  // an outside-workspace path host-absolute — the FileViewer opens both.
  // null = unresolvable (the root itself, traversal segments, "~" with no
  // home, …) → never a link.
  const resolution = cited ? resolveChatFilePath(cited, root, home) : null;
  const linkPath = resolution?.path ?? null;
  const copyPath = linkPath === null ? cited : (absoluteWorkspacePath(linkPath, root) ?? linkPath);

  // Only relative paths can be in the changed-files list (it speaks
  // workspace-relative); an outside-workspace absolute is never a change.
  const isChanged = !!linkPath && !linkPath.startsWith("/") && isChangedPath(linkPath);
  // Explicit links also verify basenames; inline code keeps its path heuristic.
  const { exists, settled } = useWorkspaceFileExists(
    conversationId,
    openFile && linkPath && !isChanged ? linkPath : null,
    explicitLink || (resolution?.trusted ?? false) || isVideoFile(cited),
  );

  if (!openFile || !linkPath || !(isChanged || exists)) {
    // An absolute / "~"-relative citation is unjudgeable until the workspace
    // root is known — resolution returning null then means "not yet", not
    // "never"; it self-resolves once the environment metadata loads.
    const rootPending = root === null && (cited.startsWith("/") || cited.startsWith("~"));
    return {
      open: null,
      // Without a FileViewer nothing could ever open, so "unopenable" would
      // be noise; with one, a hard-rejected resolution is final immediately
      // and a resolved path is final once its existence check settles with a
      // completed listing (skipped/pending/errored checks stay unverified).
      unopenable: !!openFile && !rootPending && (linkPath === null || (settled && !exists)),
      resolvedPath: linkPath ?? "",
      copyPath,
    };
  }
  return {
    open: () =>
      citedLine === null
        ? openFile(linkPath)
        : openFile(linkPath, {
            line: citedLine,
            ...(citation.column ? { column: citation.column } : {}),
            ...(citation.endLine ? { endLine: citation.endLine } : {}),
          }),
    unopenable: false,
    resolvedPath: linkPath,
    copyPath,
  };
}

/**
 * Promote implicit paths only after the source message's authorized resolver
 * confirms a file; directories, examples and unavailable references stay code.
 */
function WorkspacePathInlineCode({
  children: codeChildren,
  className,
  node: _node,
  ...codeProps
}: WithHastNode<React.ComponentPropsWithoutRef<"code">>) {
  const text = typeof codeChildren === "string" ? codeChildren : "";
  // A backtick span is prose by default (`git status`, `useState`), so a
  // non-openable one just stays styled inline code — only an explicit
  // markdown link (WorkspaceFileLink) earns dead-path feedback.
  const scope = useContext(ChatAttachmentContext);
  const fallback = (
    <InlinePathCode className={className} {...codeProps}>
      {codeChildren}
    </InlinePathCode>
  );
  const citedPath = splitWorkspaceFileCitation(text).path;
  if (
    scope.itemId &&
    (looksLikeWorkspaceFilePath(citedPath) ||
      (citedPath.startsWith("/") && !citedPath.startsWith("//") && !/\s/.test(citedPath)))
  ) {
    return (
      <ChatAttachment
        compact
        sessionId={scope.sessionId}
        itemId={scope.itemId}
        reference={citedPath}
        unresolvedFallback={fallback}
      />
    );
  }
  return fallback;
}

// Streamdown's own anchor styling and marker attribute. Overriding the `a`
// slot replaces its link component wholesale, so both must be reproduced here:
// index.css keys the pointer cursor and the table-cell `overflow-wrap` rule
// (which stops a link-only table column collapsing to ~2ch) on the attribute.
const STREAMDOWN_LINK_CLASS = "wrap-anywhere font-medium text-link underline";

function githubPullRequest(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
    const match = url.pathname.match(/^\/[^/]+\/([^/]+)\/pull\/(\d+)\/?$/);
    return match ? `${match[1]}#${match[2]}` : null;
  } catch {
    return null;
  }
}

function PullRequestLinkLabel({ children }: { children: React.ReactNode }) {
  const words = typeof children === "string" ? children.match(/^(\S+)([\s\S]*)$/) : null;
  const prefix = (
    <>
      <GitPullRequestIcon aria-hidden="true" className="inline-block size-[1em] align-[-0.125em]" />
      {"\u00a0"}
      {words?.[1]}
    </>
  );
  return (
    <>
      {words ? <span className="whitespace-nowrap">{prefix}</span> : prefix}
      {words ? words[2] : children}
    </>
  );
}

/**
 * Anchor renderer for markdown links. A link to a workspace file, its href
 * parked on a fragment by `markWorkspaceFileLinks` and the real path moved to
 * `WORKSPACE_FILE_LINK_ATTR`, opens the FileViewer instead of navigating,
 * matching how an inline-code path behaves. Every other link (http(s), mailto,
 * in-page anchors) still carries its own href and renders as Streamdown would.
 *
 * A marked path that names no workspace file renders as plain text: its href is
 * the parked fragment, so a live link there would go nowhere.
 *
 * A marked path rendered as a link or text offers "Copy path" on right-click
 * (long-press on touch): with no href, neither the browser nor the desktop shell
 * offers to copy it.
 */
function WorkspaceFileLink({
  href,
  children,
  className,
  title,
  node: _node,
  ...props
}: WithHastNode<React.ComponentPropsWithoutRef<"a">>) {
  const marked = (props as Record<string, unknown>)[WORKSPACE_FILE_LINK_ATTR];
  const path = typeof marked === "string" ? marked : "";
  const attachmentScope = useContext(ChatAttachmentContext);
  const {
    open: openWorkspaceFile,
    unopenable,
    resolvedPath,
    copyPath,
  } = useWorkspaceFileOpener(attachmentScope.itemId ? "" : path, true);
  // Scopes the desktop in-app browser route to this conversation's view.
  const conversationId = useFileViewerConversationId();

  if (path && attachmentScope.itemId) {
    const stored = parseSessionFileSource(path);
    if (stored && stored.sessionId === attachmentScope.sessionId)
      return (
        <ChatAttachment
          compact
          label={children}
          sessionId={attachmentScope.sessionId}
          itemId={attachmentScope.itemId}
          attachment={{
            file_id: stored.fileId,
          }}
        />
      );
    return (
      <ChatAttachment
        compact
        label={children}
        sessionId={attachmentScope.sessionId}
        itemId={attachmentScope.itemId}
        reference={splitWorkspaceFileCitation(path).path}
      />
    );
  }
  if (!path) {
    if (typeof href === "string" && isRemoteVideoUrl(href)) {
      return (
        <VideoPlayer
          compact
          src={href}
          title={typeof children === "string" ? children : "Video recording"}
        />
      );
    }
    // Rebase an app-internal link (e.g. an agent's `/clear` "the new chat"
    // `/c/<id>`) under the deployment base path; no-op for external URLs, `#`
    // fragments, and at the origin root. The router basename does not reach raw
    // markdown anchors, so they are prefixed here.
    const rebased = typeof href === "string" ? withBasePath(href) : href;
    // Streamdown renders external links with target="_blank"; those need the
    // popup fallback so a click still works where new tabs can't open.
    const blankHref = props.target === "_blank" && typeof rebased === "string" ? rebased : null;
    const pullRequest = githubPullRequest(rebased);
    return (
      <a
        href={rebased}
        className={cn(STREAMDOWN_LINK_CLASS, className)}
        title={title ?? (pullRequest ? rebased : undefined)}
        data-streamdown="link"
        {...props}
        onClick={
          blankHref === null
            ? props.onClick
            : (event) => {
                props.onClick?.(event);
                followLinkWithPopupFallback(event, blankHref, conversationId);
              }
        }
      >
        {pullRequest ? (
          <PullRequestLinkLabel>{children === href ? pullRequest : children}</PullRequestLinkLabel>
        ) : (
          children
        )}
      </a>
    );
  }

  // Marked but not an openable file. Never leave a link on the parked
  // fragment — it would navigate nowhere.
  if (!openWorkspaceFile) {
    // Known dead (the path failed to resolve, or the existence check settled
    // without finding it): keep a visible, activatable affordance that
    // explains itself. Hover shows the path (desktop); activating it explains
    // why nothing opens — which is all the feedback a touch user can get,
    // where a silent non-link reads as "tapping does nothing".
    if (unopenable) {
      // Two distinct dead ends: a path the resolver rejected outright was
      // never searched (claiming it "wasn't found" would be false), while a
      // resolved path genuinely came up absent from its parent listing.
      const explain = () =>
        showToast(
          resolvedPath
            ? `Can't open ${resolvedPath}: it wasn't found in this session's reachable filesystem.`
            : `Can't open ${path}: it doesn't resolve to an openable file path.`,
        );
      return (
        <FileLinkContextMenu path={copyPath}>
          <span
            role="button"
            tabIndex={0}
            className={cn(
              "cursor-pointer text-muted-foreground underline decoration-dotted underline-offset-2",
              className,
            )}
            title={title ?? path}
            onClick={explain}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                explain();
              }
            }}
          >
            {children}
          </span>
        </FileLinkContextMenu>
      );
    }
    // Not verified yet (existence check still in flight, or it can't run):
    // plain text, with the path on hover so it stays discoverable.
    return (
      <FileLinkContextMenu path={copyPath}>
        <span className={className} title={title ?? path}>
          {children}
        </span>
      </FileLinkContextMenu>
    );
  }

  if (conversationId && isVideoFile(resolvedPath)) {
    return (
      <VideoPlayer
        compact
        conversationId={conversationId}
        path={resolvedPath}
        title={
          typeof children === "string" ? children : (resolvedPath.split("/").pop() ?? resolvedPath)
        }
        onOpenFile={openWorkspaceFile}
      />
    );
  }

  return (
    <FileLinkContextMenu path={copyPath}>
      <span className="inline">
        <InlineFileReference
          contextRelative
          path={copyPath}
          filename={splitWorkspaceFileCitation(path).path.split(/[\\/]/).at(-1)}
          aria-label={props["aria-label"] ?? (typeof children === "string" ? children : undefined)}
          data-streamdown="link"
          onClick={openWorkspaceFile}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openWorkspaceFile();
            }
          }}
        >
          {children}
        </InlineFileReference>
      </span>
    </FileLinkContextMenu>
  );
}

/** Right-click menu that copies the path a file link names. */
function FileLinkContextMenu({ path, children }: { path: string; children: React.ReactElement }) {
  return <FilePreviewMenu actions={{ path }}>{children}</FilePreviewMenu>;
}

// Markdown images open in the shared lightbox on click, matching uploaded and
// generated images. (Remote `src`s are still gated by Streamdown's image
// security; this only adds the zoom affordance to whatever does render.)
function ZoomableMarkdownImage({
  src,
  alt,
  node: _node,
  ...props
}: WithHastNode<React.ComponentProps<"img">>) {
  const scope = useContext(ChatAttachmentContext);
  const reference = (props as Record<string, unknown>)[WORKSPACE_IMAGE_ATTR];
  if (typeof reference === "string")
    return (
      <ChatAttachment sessionId={scope.sessionId} itemId={scope.itemId} reference={reference} />
    );
  const resolvedSrc = typeof src === "string" ? src : undefined;
  return <ZoomableImage {...props} src={resolvedSrc} alt={alt ?? ""} />;
}

/** Only an image-only paragraph forms a row; intervening text stays in place. */
function MediaParagraph({
  children,
  node: _node,
  ...props
}: WithHastNode<React.ComponentProps<"p">>) {
  const contents = Array.isArray(children) ? children : [children];
  const images = contents.filter((child) => !(typeof child === "string" && child.trim() === ""));
  if (
    images.length > 1 &&
    images.every((child) => isValidElement(child) && child.type === ZoomableMarkdownImage)
  )
    return <MediaBatch>{images}</MediaBatch>;
  return <p {...props}>{children}</p>;
}

// Stable module-level override map so MessageResponse's shallow prop compare
// never sees a new `components` identity and re-parses needlessly.
const FILE_PATH_AWARE_COMPONENTS = {
  inlineCode: WorkspacePathInlineCode,
  img: ZoomableMarkdownImage,
  a: WorkspaceFileLink,
  p: MediaParagraph,
};

// How often the live (growing) assistant bubble re-parses its markdown. The
// store pump commits a new, longer text up to once per animation frame (~60/s);
// without this the whole accumulated message is re-parsed on every commit. ~10/s
// is smooth to read and cuts the per-frame parse cost. Trailing-edge, so the
// final text still appears within this window of the last token.
const STREAM_MARKDOWN_THROTTLE_MS = 100;

// Defense-in-depth against a pathological text block locking the tab.
// A user message whose text is a ~50KB unbroken base64 data URL
// — e.g. an image block accidentally serialized into the text stream — both
// jams the full markdown pipeline (Shiki/KaTeX/mermaid + rehype) on the main
// thread AND forces the browser to lay out one ~50K-char line with no break
// opportunities. Either heuristic below routes such a block to plain,
// break-anywhere rendering that bypasses markdown entirely.
//
// `MAX_MARKDOWN_TEXT_LENGTH`: total size above which we never run markdown.
// `MAX_UNBROKEN_TOKEN_LENGTH`: longest run of non-whitespace chars above which
//   layout becomes pathological regardless of total size (base64, long URLs).
// `MAX_PLAINTEXT_DISPLAY_LENGTH`: hard cap on what we paint even as plain text,
//   so a multi-MB payload can't blow up the DOM; the rest is elided.
const MAX_MARKDOWN_TEXT_LENGTH = 50_000;
const MAX_UNBROKEN_TOKEN_LENGTH = 5_000;
const MAX_PLAINTEXT_DISPLAY_LENGTH = 200_000;

/**
 * Longest run of consecutive non-whitespace characters in `text`. ASCII
 * whitespace (space, tab, CR, LF, FF, VT) resets the run — those are the
 * break opportunities the layout engine can use. O(n), single pass.
 */
function longestUnbrokenRun(text: string): number {
  let max = 0;
  let current = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // 32 = space; 9..13 = tab, LF, VT, FF, CR.
    if (code === 32 || (code >= 9 && code <= 13)) {
      current = 0;
    } else {
      current += 1;
      if (current > max) max = current;
    }
  }
  return max;
}

/**
 * Whether `text` should bypass the markdown pipeline because rendering it
 * there would risk locking the tab. See the constants above for the why.
 */
function isPathologicalText(text: string): boolean {
  return (
    text.length > MAX_MARKDOWN_TEXT_LENGTH || longestUnbrokenRun(text) > MAX_UNBROKEN_TOKEN_LENGTH
  );
}

/**
 * Plain, break-anywhere fallback for a pathological text block — no markdown.
 * `whitespace-pre-wrap` keeps newlines; `break-all` gives the layout engine a
 * break opportunity inside an otherwise unbreakable token. Over-long payloads
 * are elided so the DOM node itself can't grow without bound.
 */
function PlainTextFallback({ text }: { text: string }) {
  const truncated = text.length > MAX_PLAINTEXT_DISPLAY_LENGTH;
  const shown = truncated ? text.slice(0, MAX_PLAINTEXT_DISPLAY_LENGTH) : text;
  return (
    <div data-chat-plain-text className="whitespace-pre-wrap break-all font-mono text-sm">
      {shown}
      {truncated && (
        <span className="text-muted-foreground">
          {`\n… [${text.length - MAX_PLAINTEXT_DISPLAY_LENGTH} more characters not shown]`}
        </span>
      )}
    </div>
  );
}

/**
 * Wraps `MessageResponse` with {@link WorkspacePathInlineCode} via Streamdown's
 * `inlineCode` slot — NOT `code` — so fenced code blocks keep their default
 * `<pre>` wrapper and Shiki highlighting. Overriding `code` here would replace
 * block rendering too, stripping `<pre>` and collapsing whitespace.
 *
 * When `breaks` is set, single newlines render as `<br>` (remark-breaks)
 * instead of collapsing to spaces per CommonMark. Used for user bubbles,
 * where people type multi-line messages without blank-line paragraph
 * separators and expect their line breaks preserved. NOTE: Streamdown's
 * `remarkPlugins` prop *replaces* its defaults rather than merging, so we
 * extend `defaultRemarkPlugins` (which carries remark-gfm) — passing
 * `[remarkBreaks]` alone would silently drop GFM tables / strikethrough.
 */
export function FilePathAwareMessageResponse({
  children,
  breaks = false,
  sourceItemId = null,
  ...props
}: React.ComponentProps<typeof MessageResponse> & {
  breaks?: boolean;
  sourceItemId?: string | null;
}) {
  const components = FILE_PATH_AWARE_COMPONENTS;
  const sessionId = useScopedConversationId();
  const scope = useMemo(() => ({ sessionId, itemId: sourceItemId }), [sessionId, sourceItemId]);

  // Extend (don't replace) Streamdown's defaults so remark-gfm survives;
  // append remark-breaks only when requested. Canonicalize authorized images
  // before the existing sanitizer and remote-image hardening.
  const remarkPlugins = useMemo<React.ComponentProps<typeof MessageResponse>["remarkPlugins"]>(
    () => [
      [canonicalSessionImages, { sessionId }],
      remarkMediaBatches,
      ...Object.values(defaultRemarkPlugins),
      ...(breaks ? [remarkBreaks] : []),
    ],
    [breaks, sessionId],
  );

  // Throttle the markdown so the live (still-growing) bubble re-parses a few
  // times per second instead of on every store commit. `children` is a string
  // at both call sites (a text RenderItem and the user bubble); finalized/static
  // text changes once, which emits immediately, so this is a no-op off the
  // streaming path. The hook must be called unconditionally (rules of hooks), so
  // non-string children (none today) pass an inert "" and bypass the result.
  const isString = typeof children === "string";
  const normalizedText = useMemo(
    () => (isString ? normalizeExplicitMathDelimiters(children as string) : ""),
    [isString, children],
  );
  const throttledText = useThrottledValue(normalizedText, STREAM_MARKDOWN_THROTTLE_MS);
  const artifactParts = useMemo(
    () => (isString ? splitArtifactMarkdown(throttledText) : []),
    [isString, throttledText],
  );

  // Defense-in-depth: a string child that is huge or carries a
  // giant unbroken token (e.g. a base64 data URL serialized into the text
  // stream) would lock the tab in the markdown pipeline + layout. Render it as
  // plain break-anywhere text instead. Both call sites (assistant text blocks
  // and the user bubble) flow through here, so this one guard covers both.
  const pathological = useMemo(
    () => isString && isPathologicalText(children as string),
    [isString, children],
  );
  if (pathological) {
    return <PlainTextFallback text={children as string} />;
  }

  return (
    <ChatAttachmentContext.Provider value={scope}>
      {isString ? (
        artifactParts.map((part) =>
          part.kind === "artifact" ? (
            <Suspense
              key={`artifact:${part.offset}`}
              fallback={<p role="status">Loading artifact…</p>}
            >
              <UploadedArtifact sessionId={sessionId} reference={part.reference} />
            </Suspense>
          ) : (
            <MessageResponse
              key={`markdown:${part.offset}`}
              {...props}
              components={components}
              remarkPlugins={remarkPlugins}
              markFileLinks
            >
              {part.text}
            </MessageResponse>
          ),
        )
      ) : (
        <MessageResponse
          {...props}
          components={components}
          remarkPlugins={remarkPlugins}
          markFileLinks
        >
          {children}
        </MessageResponse>
      )}
    </ChatAttachmentContext.Provider>
  );
}
