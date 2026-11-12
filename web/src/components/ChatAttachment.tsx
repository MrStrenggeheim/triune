// Modified for Triune.
import { normalizeAttachmentContent, type ChatAttachmentContent } from "@/lib/chatAttachments";
import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ContextType,
  type ReactElement,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchChatFileLocation } from "@/lib/chatFileReferences";
import {
  CopyIcon,
  DownloadIcon,
  FolderOpenIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PanelsTopLeftIcon,
  ScanEyeIcon,
} from "lucide-react";
import { authenticatedFetch } from "@/lib/identity";
import { apiErrorFromResponse } from "@/lib/sessionsApi";
import { downloadBlob } from "@/lib/explorerOperations";
import { toast } from "@/lib/notifications";
import { copyText } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { HeaderActionButton } from "@/components/HeaderActionButton";
import { TooltipButton, Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { WorkspaceFileIcon } from "@/shell/WorkspaceFileIcon";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ZoomableImage } from "./ImageLightbox";
import { CodeBlock } from "./ai-elements/code-block";
import { detectLang } from "@/shell/codeViewerHelpers";
import { formatBytes } from "@/shell/fileStatusUtils";
import type { FileContentResponse } from "@/hooks/useFileContent";

const PdfViewer = lazy(() => import("@/shell/PdfViewer").then((m) => ({ default: m.PdfViewer })));
const MarkdownPreview = lazy(() =>
  import("@/shell/CodeViewer").then((m) => ({ default: m.MarkdownPreview })),
);
export const ChatAttachmentContext = createContext<{
  sessionId: string | null;
  itemId: string | null;
}>({ sessionId: null, itemId: null });
export type AttachmentContent = ChatAttachmentContent;

/** Persist this identity in the dock; never replace it with a live filesystem path. */
export interface AttachmentPreviewRequest {
  sessionId: string;
  itemId?: string | null;
  reference?: string;
  attachment?: AttachmentContent;
  filename?: string;
}

export type AttachmentPreviewPlacement = "beside" | "tab" | "default";

export const AttachmentPreviewContext = createContext<{
  /** Place relative to the originating chat (request.sessionId), defaulting to beside. */
  openAttachment?: (
    request: AttachmentPreviewRequest,
    options?: { placement: AttachmentPreviewPlacement },
  ) => void;
  canOpenAttachment?: (
    request: AttachmentPreviewRequest,
    placement: AttachmentPreviewPlacement,
  ) => boolean;
  /** Optional availability veto; the Reveal endpoint authorizes the captured origin. */
  canRevealAttachment?: (request: AttachmentPreviewRequest) => boolean;
  /** Resolve the captured location, guard Explorer reuse and report failures. */
  revealAttachment?: (request: AttachmentPreviewRequest) => void | Promise<void>;
}>({});

const MAX_BYTES = 50 * 1024 * 1024;
const TEXT_BYTES = 512 * 1024;

interface FilePreviewActions {
  openBeside?: () => void;
  openTab?: () => void;
  openModal?: () => void;
  reveal?: () => void;
  path?: string;
  download?: () => void;
  downloading?: boolean;
}

function hasFilePreviewActions(actions: FilePreviewActions) {
  return !!(
    actions.openBeside ||
    actions.openTab ||
    actions.openModal ||
    actions.reveal ||
    actions.path ||
    actions.download
  );
}

/** One action set for file chips, attachment cards and their touch overflow controls. */
export function FilePreviewMenu({
  children,
  actions,
  dropdown = false,
  onOpenChange,
}: {
  children: ReactElement;
  actions: FilePreviewActions;
  dropdown?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  if (!hasFilePreviewActions(actions)) return children;
  const Item = dropdown ? DropdownMenuItem : ContextMenuItem;
  const items = (
    <>
      {actions.openBeside && (
        <Item onSelect={actions.openBeside}>
          <PanelRightIcon /> Open beside chat
        </Item>
      )}
      {actions.openTab && (
        <Item onSelect={actions.openTab}>
          <PanelsTopLeftIcon /> Open as tab
        </Item>
      )}
      {actions.openModal && (
        <Item onSelect={actions.openModal}>
          <ScanEyeIcon /> Open in modal
        </Item>
      )}
      {actions.reveal && (
        <Item onSelect={actions.reveal}>
          <FolderOpenIcon /> Reveal in Explorer
        </Item>
      )}
      {actions.path && (
        <Item
          onSelect={() =>
            void copyText(actions.path!).then(
              () => toast.success("Copied path"),
              () => toast.error("Couldn't copy the path"),
            )
          }
        >
          <CopyIcon /> Copy path
        </Item>
      )}
      {actions.download && (
        <Item disabled={actions.downloading} onSelect={actions.download}>
          <DownloadIcon /> Download original
        </Item>
      )}
    </>
  );
  if (dropdown)
    return (
      <DropdownMenu onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align="end">{items}</DropdownMenuContent>
      </DropdownMenu>
    );
  return (
    <ContextMenu onOpenChange={onOpenChange}>
      <ContextMenuTrigger
        asChild
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          event.preventDefault();
          const bounds = event.currentTarget.getBoundingClientRect();
          event.currentTarget.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: bounds.left,
              clientY: bounds.bottom,
            }),
          );
        }}
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>{items}</ContextMenuContent>
    </ContextMenu>
  );
}

/** Filename-only reference that shares the product's file icons and path tooltip. */
export function InlineFileReference({
  path,
  filename = path.split(/[\\/]/).at(-1) || "Attachment",
  mimeType,
  className,
  ...props
}: ComponentPropsWithoutRef<"button"> & {
  path: string;
  filename?: string;
  mimeType?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <TooltipButton
          {...props}
          type="button"
          className={cn(
            "not-prose inline-flex max-w-full items-baseline gap-1.5 rounded-md border border-border/60 bg-muted/70 px-1.5 py-0.5 align-baseline text-sm leading-none text-link hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            className,
          )}
        >
          <WorkspaceFileIcon path={filename} mimeType={mimeType} className="self-center" />
          <span className="truncate leading-normal">{filename}</span>
        </TooltipButton>
      </TooltipTrigger>
      <TooltipContent className="break-all">{path}</TooltipContent>
    </Tooltip>
  );
}

function useObjectUrl(blob: Blob | undefined) {
  const [value, setValue] = useState<{ blob: Blob; url: string }>();
  useEffect(() => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    setValue({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return value?.blob === blob ? value?.url : undefined;
}

function useAttachmentResource(
  {
    sessionId,
    attachment: rawAttachment,
    reference,
    itemId,
    filename: requestedFilename,
  }: Omit<AttachmentPreviewRequest, "sessionId"> & { sessionId: string | null },
  { preview = false, loadImages = false, eager = false } = {},
) {
  const attachment = normalizeAttachmentContent(rawAttachment);
  const filenameHint =
    attachment?.filename ?? requestedFilename ?? reference?.split(/[\\/]/).at(-1) ?? "Attachment";
  const storedReference = reference?.match(
    /^\/v1\/sessions\/([^/]+)\/resources\/files\/([^/]+)\/content$/,
  );
  const fileId =
    attachment?.file_id ??
    (storedReference && decodeURIComponent(storedReference[1]) === sessionId
      ? decodeURIComponent(storedReference[2])
      : undefined);
  const base = `/v1/sessions/${encodeURIComponent(sessionId ?? "")}`;
  const url = fileId?.startsWith("pending:")
    ? undefined
    : fileId
      ? `${base}/resources/files/${encodeURIComponent(fileId)}/content`
      : reference && itemId
        ? `${base}/attachments/references/${encodeURIComponent(itemId)}?${new URLSearchParams({ path: reference })}`
        : undefined;
  const inline = attachment?.image_url ?? attachment?.file_data;
  const metadata = useQuery({
    queryKey: ["chat-attachment-metadata", sessionId, fileId],
    enabled: !!sessionId && !!fileId && !fileId.startsWith("pending:"),
    retry: false,
    queryFn: async ({ signal }) => {
      const res = await authenticatedFetch(
        `${base}/resources/files/${encodeURIComponent(fileId!)}`,
        { signal },
      );
      if (!res.ok) throw await apiErrorFromResponse(res);
      return res.json() as Promise<{
        name?: string;
        metadata: { bytes: number; content_type?: string };
      }>;
    },
  });
  const filename = (metadata.data?.name ?? filenameHint).split(/[\\/]/).at(-1) || "Attachment";
  const image =
    /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i.test(filename) || inline?.startsWith("data:image/");
  const content = useQuery({
    queryKey: ["chat-attachment-bytes", sessionId, fileId ?? itemId, reference, inline],
    enabled:
      ((!!url && !!sessionId) || !!inline?.startsWith("data:")) &&
      ((loadImages && image) || preview || eager),
    retry: false,
    gcTime: 30_000,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      let response: Response;
      if (url) response = await authenticatedFetch(url, { signal });
      else if (inline?.startsWith("data:")) {
        const match = inline.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
        if (!match || match[2].length > 70 * 1024 * 1024)
          throw new Error("Invalid inline attachment");
        response = new Response(
          Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0)),
          { headers: { "Content-Type": match[1] } },
        );
      } else throw new Error("This attachment has no accessible content.");
      if (!response.ok) throw await apiErrorFromResponse(response);
      if (Number(response.headers.get("Content-Length")) > MAX_BYTES)
        throw new Error("Preview exceeds 50 MB. Download from Files instead.");
      const blob = await response.blob();
      if (blob.size > MAX_BYTES) throw new Error("Preview exceeds 50 MB.");
      return blob;
    },
  });
  const blobUrl = useObjectUrl(content.data);
  const mime =
    content.data?.type ||
    metadata.data?.metadata.content_type ||
    filename.split(".").at(-1)?.toUpperCase() ||
    "File";
  const error = attachment?.error ? new Error(attachment.error) : (content.error ?? metadata.error);
  async function download() {
    try {
      const blob = content.data ?? (await content.refetch()).data;
      if (!blob) throw new Error("The file is unavailable. Retry opening it.");
      downloadBlob(blob, filename);
    } catch (failure) {
      toast.error("Could not download attachment", { description: String(failure) });
    }
  }
  const available = !!url || !!inline?.startsWith("data:");
  const details = [
    reference && !storedReference ? reference : null,
    detectLang(filename) === "markdown" ? "Markdown" : mime,
  ]
    .filter(Boolean)
    .join(" · ");
  const size =
    metadata.data || content.data
      ? formatBytes(content.data?.size ?? metadata.data!.metadata.bytes)
      : null;
  return {
    attachment,
    filenameHint,
    filename,
    fileId,
    storedReference,
    available,
    image,
    metadata,
    content,
    blobUrl,
    mime,
    error,
    download,
    details,
    size,
  };
}

/** One authenticated file surface for uploads, agent artifacts and captured Markdown references. */
export function ChatAttachment({
  sessionId,
  attachment: rawAttachment,
  reference,
  itemId,
  compact = false,
  unresolvedFallback,
}: {
  sessionId: string | null;
  attachment?: AttachmentContent;
  reference?: string;
  itemId?: string | null;
  compact?: boolean;
  /** Implicit prose stays unchanged until its captured reference resolves to a file. */
  unresolvedFallback?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [failedImage, setFailedImage] = useState<string>();
  const storedReference = reference?.startsWith("/v1/sessions/");
  const liveReference =
    compact &&
    !!reference &&
    !!itemId &&
    !!sessionId &&
    !storedReference &&
    !rawAttachment?.file_id;
  const location = useQuery({
    queryKey: ["chat-file-location", sessionId, itemId, reference],
    enabled: liveReference,
    queryFn: ({ signal }) => fetchChatFileLocation(sessionId!, itemId!, reference!, signal),
    staleTime: 30_000,
    retry: false,
  });
  const previewContext = useContext(AttachmentPreviewContext);
  const resource = useAttachmentResource(
    { sessionId, attachment: rawAttachment, reference, itemId },
    { preview: open || menuOpen, loadImages: !compact, eager: false },
  );
  const {
    attachment,
    filenameHint,
    filename,
    fileId,
    available,
    image,
    metadata,
    content,
    blobUrl,
    error,
    download,
    details,
    size,
  } = resource;
  const request: AttachmentPreviewRequest = {
    sessionId: sessionId ?? "",
    attachment,
    reference,
    itemId,
    filename,
  };
  const openModal = () => setOpen(true);
  const canOpen = (placement: AttachmentPreviewPlacement) =>
    !!sessionId &&
    available &&
    !attachment?.error &&
    !!previewContext.openAttachment &&
    previewContext.canOpenAttachment?.(request, placement) !== false;
  const openDock = (placement: AttachmentPreviewPlacement) => {
    if (canOpen(placement)) previewContext.openAttachment?.(request, { placement });
  };
  const menuActions: FilePreviewActions = {
    openBeside: canOpen("beside") ? () => openDock("beside") : undefined,
    openTab: canOpen("tab") ? () => openDock("tab") : undefined,
    openModal: available && !attachment?.error ? openModal : undefined,
    reveal: canRevealAttachment(request, resource, previewContext)
      ? () => {
          if (canRevealAttachment(request, resource, previewContext))
            void previewContext.revealAttachment?.(request);
        }
      : undefined,
    path: reference && !resource.storedReference ? reference : undefined,
    download: available && !attachment?.error ? () => void download() : undefined,
    downloading: content.isFetching,
  };
  const openPreview = () => {
    if (compact && canOpen("default")) openDock("default");
    else openModal();
  };
  const lastError = useRef<unknown>(null);
  useEffect(() => {
    if (compact && error && (open || menuOpen) && lastError.current !== error) {
      lastError.current = error;
      toast.error(`Could not open ${filename}`, { description: error.message });
    }
  }, [compact, error, open, menuOpen, filename]);
  if (liveReference && location.data?.kind !== "file" && location.data?.kind !== "captured")
    return (
      unresolvedFallback ?? (
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-ui">{reference}</code>
      )
    );
  if (unresolvedFallback !== undefined && !location.data && !content.data)
    return unresolvedFallback;
  return (
    <>
      <FilePreviewMenu actions={menuActions} onOpenChange={setMenuOpen}>
        <span
          className={
            compact
              ? "not-prose inline"
              : "not-prose @container/attachment my-2 flex w-[640px] min-w-0 max-w-full flex-col gap-2 rounded-lg border border-border bg-background p-3"
          }
          data-testid="chat-attachment"
        >
          {!compact && image && blobUrl && failedImage !== blobUrl && (
            <ZoomableImage
              src={blobUrl}
              alt={filename}
              className="max-h-64 max-w-full rounded object-contain"
              onError={() => setFailedImage(blobUrl)}
            />
          )}
          {compact ? (
            <InlineFileReference
              path={reference ?? filenameHint}
              filename={filename}
              mimeType={metadata.data?.metadata.content_type}
              onClick={openPreview}
            />
          ) : (
            <span className="flex min-w-0 items-center gap-3">
              <span className="flex h-9 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                <WorkspaceFileIcon
                  path={filename}
                  mimeType={metadata.data?.metadata.content_type}
                  className="size-5"
                />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1 @min-[30rem]/attachment:flex-row @min-[30rem]/attachment:items-center @min-[30rem]/attachment:gap-3">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <TooltipButton
                      type="button"
                      className="block max-w-full truncate text-left text-sm font-semibold hover:text-link focus-visible:outline-ring @min-[30rem]/attachment:max-w-1/2"
                      onClick={openPreview}
                    >
                      {filename}
                    </TooltipButton>
                  </TooltipTrigger>
                  <TooltipContent className="break-all">{reference ?? filenameHint}</TooltipContent>
                </Tooltip>
                <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground @min-[30rem]/attachment:ml-auto @min-[30rem]/attachment:max-w-1/2">
                  <span className="truncate">{details}</span>
                  {size && <span className="shrink-0">{` · ${size}`}</span>}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Download ${filename}`}
                      disabled={!available || content.isFetching}
                      onClick={() => void download()}
                    >
                      <DownloadIcon />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Download original</TooltipContent>
                </Tooltip>
                {hasFilePreviewActions(menuActions) && (
                  <FilePreviewMenu actions={menuActions} dropdown onOpenChange={setMenuOpen}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`More actions for ${filename}`}
                    >
                      <MoreHorizontalIcon />
                    </Button>
                  </FilePreviewMenu>
                )}
              </span>
            </span>
          )}
          {content.isFetching && (
            <span role="status" className={compact ? "sr-only" : "flex items-center gap-1 text-xs"}>
              <Loader2Icon className="size-3 animate-spin" />
              Loading file…
            </span>
          )}
          {blobUrl && failedImage === blobUrl && (
            <span role="alert" className="text-xs text-destructive">
              This image could not be decoded. Download the original to open it.
            </span>
          )}
          {error && !compact && (
            <span role="alert" className="text-xs text-destructive">
              {error.message}{" "}
              <TooltipButton
                type="button"
                className="underline"
                onClick={() => {
                  void content.refetch();
                  if (fileId) void metadata.refetch();
                }}
              >
                Retry
              </TooltipButton>
            </span>
          )}
          {!available && !attachment?.error && (
            <span className="text-xs text-muted-foreground">
              {fileId?.startsWith("pending:")
                ? "Uploading…"
                : "File is not attached. Ask the agent to use triune attach-file."}
            </span>
          )}
        </span>
      </FilePreviewMenu>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-1rem)] max-w-4xl flex-col overflow-hidden sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="break-all">{filename}</DialogTitle>
            <DialogDescription>
              {details}
              {size && ` · ${size}`}
            </DialogDescription>
          </DialogHeader>
          <AttachmentPreviewActions request={request} resource={resource} />
          <div className="min-h-0 overflow-auto">
            <AttachmentPreviewBody resource={resource} sessionId={sessionId ?? ""} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Docked and fallback previews share the captured-byte loader and browser viewers. */
export function AttachmentPreviewView({ request }: { request: AttachmentPreviewRequest }) {
  const resource = useAttachmentResource(request, { preview: true });
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col"
      aria-label={`Preview ${resource.filename}`}
    >
      <header className="workspace-control-header flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{resource.filename}</span>
        <AttachmentPreviewActions request={request} resource={resource} header />
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <AttachmentPreviewBody resource={resource} sessionId={request.sessionId} />
      </div>
    </section>
  );
}

type AttachmentResource = ReturnType<typeof useAttachmentResource>;

function canRevealAttachment(
  request: AttachmentPreviewRequest,
  resource: AttachmentResource,
  context: ContextType<typeof AttachmentPreviewContext>,
) {
  return (
    !!request.itemId &&
    !!request.reference &&
    !resource.storedReference &&
    !!resource.content.data &&
    !resource.error &&
    !!context.revealAttachment &&
    context.canRevealAttachment?.(request) !== false
  );
}

function AttachmentPreviewActions({
  request,
  resource,
  header = false,
}: {
  request: AttachmentPreviewRequest;
  resource: AttachmentResource;
  header?: boolean;
}) {
  const context = useContext(AttachmentPreviewContext);
  const canReveal = canRevealAttachment(request, resource, context);
  const Action = header ? HeaderActionButton : Button;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1">
      {canReveal && (
        <Action
          type="button"
          variant="ghost"
          size={header ? "icon-xs" : "sm"}
          aria-label="Reveal in Explorer"
          onClick={() => {
            if (context.canRevealAttachment?.(request) !== false)
              void context.revealAttachment?.(request);
          }}
        >
          <FolderOpenIcon />
          {!header && "Reveal in Explorer"}
        </Action>
      )}
      <Action
        type="button"
        variant="ghost"
        size={header ? "icon-xs" : "sm"}
        disabled={!resource.available || resource.content.isFetching}
        aria-label={`Download ${resource.filename}`}
        onClick={() => void resource.download()}
      >
        <DownloadIcon />
        {!header && "Download original"}
      </Action>
    </div>
  );
}

function AttachmentPreviewBody({
  resource,
  sessionId,
}: {
  resource: AttachmentResource;
  sessionId: string;
}) {
  const { content, error, blobUrl, filename } = resource;
  if (content.isFetching) return <p role="status">Loading file…</p>;
  if (error)
    return (
      <div role="alert">
        <p>{error.message}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void content.refetch();
            if (resource.fileId) void resource.metadata.refetch();
          }}
        >
          Retry
        </Button>
      </div>
    );
  if (!content.data || !blobUrl) return <p>Preview unavailable. Download the file to open it.</p>;
  return (
    <AttachmentPreview
      key={`${sessionId}:${filename}:${blobUrl}`}
      blob={content.data}
      url={blobUrl}
      filename={filename}
      sessionId={sessionId}
    />
  );
}

export function AttachmentPreview({
  blob,
  url,
  filename,
  sessionId,
}: {
  blob: Blob;
  url: string;
  filename: string;
  sessionId: string;
}) {
  const lang = detectLang(filename);
  const isText =
    blob.type.startsWith("text/") ||
    /\.(md|txt|log|json|ya?ml|csv|tsv|[cm]?[jt]sx?|py|sh|rs|go|html?)$/i.test(filename);
  const [text, setText] = useState<string>();
  const [source, setSource] = useState(false);
  useEffect(() => {
    let active = true;
    if (isText)
      void blob
        .slice(0, TEXT_BYTES)
        .text()
        .then((value) => {
          if (active) setText(value);
        });
    return () => {
      active = false;
    };
  }, [blob, isText]);
  if (blob.type.startsWith("image/") || /\.(svg|png|jpe?g|webp|avif|gif)$/i.test(filename))
    return (
      <ZoomableImage src={url} alt={filename} className="max-h-[65dvh] max-w-full object-contain" />
    );
  if (blob.type.startsWith("audio/"))
    return (
      <audio
        controls
        src={url}
        className="w-full"
        onError={() => toast.error("Audio playback unavailable. Download the original.")}
      />
    );
  if (blob.type.startsWith("video/"))
    return (
      <video
        controls
        src={url}
        className="max-h-[65dvh] w-full"
        onError={() => toast.error("Video playback unavailable. Download the original.")}
      />
    );
  if (blob.type === "application/pdf" || /\.pdf$/i.test(filename))
    return (
      <Suspense fallback={<p>Loading PDF…</p>}>
        <AttachmentPdf blob={blob} filename={filename} sessionId={sessionId} />
      </Suspense>
    );
  if (!isText)
    return (
      <p className="text-sm text-muted-foreground">
        Preview is unavailable for this format. Download the original to open it.
      </p>
    );
  if (text === undefined) return <p role="status">Loading text…</p>;
  const html = /\.html?$/i.test(filename);
  const markdown = lang === "markdown";
  return (
    <div className="space-y-2">
      {(html || markdown) && (
        <Button type="button" variant="outline" size="sm" onClick={() => setSource(!source)}>
          {source ? "Preview" : "Source"}
        </Button>
      )}
      {blob.size > TEXT_BYTES && (
        <p role="status" className="text-xs text-muted-foreground">
          Preview limited to 512 KiB. Download for the complete file.
        </p>
      )}
      {html && !source ? (
        <iframe
          title={filename}
          sandbox=""
          referrerPolicy="no-referrer"
          className="h-[60dvh] w-full border-0"
          srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">${text}`}
        />
      ) : markdown && !source ? (
        <Suspense fallback={<p>Loading Markdown…</p>}>
          <MarkdownPreview content={text} path={null} tocOpen={false} onTocOpenChange={() => {}} />
        </Suspense>
      ) : (
        <CodeBlock code={text} language={lang} wrap />
      )}
    </div>
  );
}
function AttachmentPdf({
  blob,
  filename,
  sessionId,
}: {
  blob: Blob;
  filename: string;
  sessionId: string;
}) {
  const [data, setData] = useState<FileContentResponse>();
  useEffect(() => {
    let active = true;
    const reader = new FileReader();
    reader.onload = () => {
      if (active)
        setData({
          object: "session.environment.filesystem.file_content",
          path: filename,
          content_type: "application/pdf",
          encoding: "base64",
          content: String(reader.result).split(",")[1],
          bytes: blob.size,
        });
    };
    reader.readAsDataURL(blob);
    return () => {
      active = false;
      reader.abort();
    };
  }, [blob, filename]);
  return data ? <PdfViewer data={data} conversationId={sessionId} /> : <p>Loading PDF…</p>;
}
export function ScopedChatAttachment({ reference }: { reference: string }) {
  const { sessionId, itemId } = useContext(ChatAttachmentContext);
  return <ChatAttachment sessionId={sessionId} itemId={itemId} reference={reference} compact />;
}
