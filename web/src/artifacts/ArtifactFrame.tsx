// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PreviewHeaderContext } from "@/components/PreviewHeaderContext";
import { ContentSkeleton } from "@/components/ui/loading";
import {
  CodeIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  MoreHorizontalIcon,
  MaximizeIcon,
  PanelsTopLeftIcon,
  WrapTextIcon,
} from "lucide-react";
import { useWrapPreference } from "@/hooks/useWrapPreference";
import { Button } from "@/components/ui/button";
import { HeaderActionButton } from "@/components/HeaderActionButton";
import { useResolvedThemeMode } from "@/components/theme/useResolvedThemeMode";
import { getArtifactThemeVariables } from "@/lib/designContract";
import { getStyleRoot } from "@/lib/host";
import { withBasePath } from "@/lib/basePath";
import { useViewerId } from "@/hooks/useViewerId";
import { useConversationChatVisible } from "@/workbench/ScopedChatStore";
import { openHtmlArtifactInNewTab } from "@/shell/codeViewerHelpers";
import { toast } from "@/lib/notifications";
import { useInlinePreviewBoundary } from "./inlinePreviewBoundary";
import { artifactKit } from "./kit";
import { ARTIFACT_SANDBOX, buildArtifactDocument, type ArtifactTheme } from "./artifactDocument";
import { serializeArtifactState } from "./artifactProtocol";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { downloadBlob } from "@/lib/explorerOperations";

const memory = new Map<string, unknown>();

function readState(key: string): unknown {
  if (memory.has(key)) return memory.get(key);
  try {
    const stored = localStorage.getItem(key);
    if (!stored || !serializeArtifactState(JSON.parse(stored))) return undefined;
    return JSON.parse(stored) as unknown;
  } catch (error) {
    console.warn("Artifact state could not be restored", error);
    return undefined;
  }
}

/** One opaque document boundary for uploaded inline artifacts and existing HTML attachments. */
export function ArtifactFrame({
  html,
  identity,
  title,
  onOpenTab,
  inline = false,
  onDownloadOriginal,
  onRevealInExplorer,
}: {
  html: string;
  identity: string;
  title: string;
  onOpenTab?: () => void;
  /** In-chat embeds use the owning view cap; standalone previews keep their full area. */
  inline?: boolean;
  onDownloadOriginal?: () => void;
  onRevealInExplorer?: () => void;
}) {
  const headerTarget = useContext(PreviewHeaderContext);
  const viewerId = useViewerId();
  const chatVisible = useConversationChatVisible();
  const themeMode = useResolvedThemeMode();
  const themeModeRef = useRef(themeMode);
  themeModeRef.current = themeMode;
  const currentTheme = useRef<ArtifactTheme | undefined>(undefined);
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const header = useRef<HTMLElement>(null);
  const [maximumHeight, setMaximumHeight] = useState<number>();
  const [maximumBodyHeight, setMaximumBodyHeight] = useState<number>();
  const bodyHeightRef = useRef<number | undefined>(undefined);
  bodyHeightRef.current = maximumBodyHeight;
  const boundaryStyle = useInlinePreviewBoundary(container, inline, setMaximumHeight);
  const documentIdentity = useMemo(
    () => ({ html, identity, viewerId, channel: crypto.randomUUID() }),
    [html, identity, viewerId],
  );
  const channel = documentIdentity.channel;
  const [documentHtml, setDocumentHtml] = useState<string>();
  const [source, setSource] = useState(false);
  const [wrap, setWrap] = useWrapPreference("chat");
  const [height, setHeight] = useState(360);
  const [intersecting, setIntersecting] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState !== "hidden");
  const active = chatVisible && intersecting && documentVisible && !source;
  const activeRef = useRef(active);
  activeRef.current = active;
  const storageKey = viewerId
    ? `omnigent:artifact-state:1:${JSON.stringify([location.origin, withBasePath("/"), viewerId, identity])}`
    : null;
  const persistenceWarning = useRef(false);

  useLayoutEffect(() => {
    const node = container.current;
    if (!node || !inline || maximumHeight === undefined) return;
    const measure = () => {
      const style = getComputedStyle(node);
      const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      setMaximumBodyHeight(
        Math.max(0, maximumHeight - (header.current?.offsetHeight ?? 0) - (border || 0)),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (header.current) observer.observe(header.current);
    observer.observe(node);
    return () => observer.disconnect();
  }, [maximumHeight, inline]);

  useEffect(() => {
    const node = container.current;
    if (!node || !storageKey) return;
    const hostRoot = getStyleRoot() ?? document.documentElement;
    function theme() {
      return {
        mode: themeModeRef.current,
        density: (hostRoot.dataset.listDensity === "comfortable" ? "comfortable" : "compact") as
          "comfortable" | "compact",
        variables: getArtifactThemeVariables(node!),
      };
    }
    const state = readState(storageKey);
    currentTheme.current = theme();
    setDocumentHtml(
      buildArtifactDocument(html, {
        channel,
        kit: artifactKit,
        theme: currentTheme.current,
        state,
        active: activeRef.current,
      }),
    );
    function update() {
      currentTheme.current = theme();
      frame.current?.contentWindow?.postMessage(
        {
          type: "triune-artifact:update",
          channel,
          theme: currentTheme.current,
          active: activeRef.current,
          maximumBodyHeight: bodyHeightRef.current,
        },
        "*",
      );
    }
    function message(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow) return;
      const data: unknown = event.data;
      if (!data || typeof data !== "object") return;
      const value = data as Record<string, unknown>;
      if (value.channel !== channel) return;
      if (value.type === "triune-artifact:ready") update();
      if (
        value.type === "triune-artifact:resize" &&
        typeof value.height === "number" &&
        Number.isFinite(value.height) &&
        value.height >= 0 &&
        value.height <= 4096
      )
        setHeight(Math.max(1, Math.min(4096, value.height)));
      if (value.type === "triune-artifact:state") {
        const serialized = serializeArtifactState(value.value);
        if (!serialized) return;
        const validated: unknown = JSON.parse(serialized);
        memory.set(storageKey!, validated);
        if (memory.size > 100) memory.delete(memory.keys().next().value!);
        try {
          localStorage.setItem(storageKey!, serialized);
        } catch (error) {
          if (!persistenceWarning.current) console.warn("Artifact state could not be saved", error);
          persistenceWarning.current = true;
        }
      }
    }
    const observer = new MutationObserver(update);
    observer.observe(hostRoot, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme", "data-list-density"],
    });
    if (hostRoot !== document.documentElement)
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "style", "data-theme"],
      });
    window.addEventListener("message", message);
    window.addEventListener("resize", update);
    container.current?.addEventListener("triune-artifact:update", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("message", message);
      window.removeEventListener("resize", update);
      node.removeEventListener("triune-artifact:update", update);
    };
  }, [html, channel, storageKey]);

  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => setIntersecting(entry.isIntersecting));
    if (container.current) observer?.observe(container.current);
    return () => {
      document.removeEventListener("visibilitychange", update);
      observer?.disconnect();
    };
  }, []);

  useEffect(() => {
    container.current?.dispatchEvent(new Event("triune-artifact:update"));
  }, [active, themeMode, maximumBodyHeight]);

  function completeDocument() {
    return buildArtifactDocument(html, {
      channel: crypto.randomUUID(),
      kit: artifactKit,
      theme: currentTheme.current,
      state: storageKey ? readState(storageKey) : undefined,
      active: true,
    });
  }

  function openWindow() {
    if (
      !openHtmlArtifactInNewTab(completeDocument(), title, window, {
        sandbox: ARTIFACT_SANDBOX,
        newWindow: true,
        prepared: true,
      })
    )
      toast.error("The artifact window was blocked. Allow popups and retry.");
  }

  const actions = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <HeaderActionButton
            aria-label="Source"
            aria-pressed={source}
            onClick={() => setSource(!source)}
          >
            <CodeIcon />
          </HeaderActionButton>
        </TooltipTrigger>
        <TooltipContent>Show artifact source</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <HeaderActionButton
            aria-label="Download artifact"
            disabled={!documentHtml}
            onClick={() => {
              downloadBlob(
                new Blob([completeDocument()], { type: "text/html;charset=utf-8" }),
                /\.html?$/i.test(title) ? title : `${title}.html`,
              );
            }}
          >
            <DownloadIcon />
          </HeaderActionButton>
        </TooltipTrigger>
        <TooltipContent>Download artifact</TooltipContent>
      </Tooltip>
      {inline && (
        <HeaderActionButton
          aria-label="Expand artifact"
          tooltip="Expand artifact"
          disabled={!documentHtml}
          onClick={onOpenTab ?? openWindow}
        >
          <MaximizeIcon />
        </HeaderActionButton>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <HeaderActionButton aria-label="More" tooltip={false}>
            <MoreHorizontalIcon />
          </HeaderActionButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {onDownloadOriginal && (
            <DropdownMenuItem onSelect={onDownloadOriginal}>
              <DownloadIcon /> Download original
            </DropdownMenuItem>
          )}
          {onRevealInExplorer && (
            <DropdownMenuItem onSelect={onRevealInExplorer}>
              <FolderOpenIcon /> Reveal in Explorer
            </DropdownMenuItem>
          )}
          <DropdownMenuItem disabled={!onOpenTab} onSelect={onOpenTab}>
            <PanelsTopLeftIcon /> Open in tab
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!documentHtml} onSelect={openWindow}>
            <ExternalLinkIcon /> Open in new window
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
  return (
    <div
      ref={container}
      className={`not-prose flex min-h-0 min-w-0 flex-col overflow-hidden bg-background ${headerTarget ? "h-full" : "rounded-lg border border-border"}`}
      style={boundaryStyle}
      data-triune-artifact={identity}
      data-inline-preview={inline || undefined}
    >
      {headerTarget ? (
        createPortal(actions, headerTarget)
      ) : (
        <header
          ref={header}
          className="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-2"
        >
          <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
          {actions}
        </header>
      )}
      <div
        className={
          inline && !source ? "min-h-0 overflow-hidden" : "min-h-0 overflow-auto overscroll-contain"
        }
        role="region"
        aria-label={`${title} preview`}
        tabIndex={inline && !source ? undefined : 0}
      >
        {!documentHtml && <ContentSkeleton label="Preparing artifact…" />}
        {documentHtml && (
          <iframe
            ref={frame}
            title={title}
            sandbox={ARTIFACT_SANDBOX}
            referrerPolicy="no-referrer"
            srcDoc={documentHtml}
            hidden={source}
            className="block w-full border-0"
            style={{
              height:
                inline && maximumBodyHeight !== undefined
                  ? Math.min(height, maximumBodyHeight)
                  : height,
              display: source ? "none" : undefined,
            }}
            onLoad={() => container.current?.dispatchEvent(new Event("triune-artifact:update"))}
          />
        )}
        {source && (
          <div>
            <CodeBlock
              className="rounded-none border-0"
              code={html}
              language={html.length > 512 * 1024 ? "text" : "html"}
              wrap={wrap}
            >
              <CodeBlockHeader>
                <CodeBlockTitle>HTML</CodeBlockTitle>
                <CodeBlockActions>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Toggle word wrap"
                    aria-pressed={wrap}
                    onClick={() => setWrap(!wrap)}
                  >
                    <WrapTextIcon />
                  </Button>
                  <CodeBlockCopyButton aria-label="Copy source" />
                </CodeBlockActions>
              </CodeBlockHeader>
            </CodeBlock>
          </div>
        )}
      </div>
    </div>
  );
}
