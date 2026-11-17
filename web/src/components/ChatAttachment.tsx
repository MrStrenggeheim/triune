// Modified for Triune.
import { useMediaBatch, mediaPreviewSize } from "./MediaBatch";
import "./chatAttachment.css";
import { PreviewHeaderContext } from "./PreviewHeaderContext";
import { parseSessionFileSource } from "@/lib/remoteImagePolicy";
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
import { createPortal } from "react-dom";
import { ContentSkeleton } from "@/components/ui/loading";
import { fetchChatFileLocation } from "@/lib/chatFileReferences";
import {
  CopyIcon,
  CodeIcon,
  DownloadIcon,
  FolderOpenIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PanelsTopLeftIcon,
  ScanEyeIcon,
  EyeIcon,
  ZoomInIcon,
  ZoomOutIcon,
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
import { useImagePreviewSize, ZoomableImage } from "./ImageLightbox";
import { galleryAttachmentSource } from "./imageGallery";
import { CodeBlock } from "./ai-elements/code-block";
import { detectLang } from "@/shell/codeViewerHelpers";
import { formatBytes } from "@/shell/fileStatusUtils";
import type { FileContentResponse } from "@/hooks/useFileContent";

const PdfViewer = lazy(() => import("@/shell/PdfViewer").then((m) => ({ default: m.PdfViewer })));
const MarkdownPreview = lazy(() =>
  import("@/shell/CodeViewer").then((m) => ({ default: m.MarkdownPreview })),
);
const ArtifactFrame = lazy(() =>
  import("@/artifacts/ArtifactFrame").then((module) => ({ default: module.ArtifactFrame })),
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
  children,
  mimeType,
  className,
  contextRelative = false,
  ...props
}: ComponentPropsWithoutRef<"button"> & {
  path: string;
  filename?: string;
  mimeType?: string;
  contextRelative?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <TooltipButton
          {...props}
          type="button"
          className={cn(
            "not-prose inline-flex max-w-full items-baseline gap-1.5 rounded-md border border-border/60 bg-muted/70 px-1.5 py-0.5 align-baseline text-sm leading-none text-link hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            contextRelative && "text-[1em]",
            className,
          )}
        >
          <WorkspaceFileIcon path={filename} mimeType={mimeType} className="self-center" />
          <span className="truncate leading-normal">{children ?? filename}</span>
        </TooltipButton>
      </TooltipTrigger>
      <TooltipContent className="break-all">{path}</TooltipContent>
    </Tooltip>
  );
}

/** The same context-relative sizing as ordinary Streamdown inline code. */
export function InlinePathCode({ className, ...props }: ComponentPropsWithoutRef<"code">) {
  return (
    <code
      {...props}
      data-streamdown="inline-code"
      className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-[0.875em]", className)}
    />
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
  const storedReference = reference ? parseSessionFileSource(reference) : null;
  const foreignReference = !!storedReference && storedReference.sessionId !== sessionId;
  const fileId =
    attachment?.file_id ??
    (storedReference && !foreignReference ? storedReference.fileId : undefined);
  const base = `/v1/sessions/${encodeURIComponent(sessionId ?? "")}`;
  const url = fileId?.startsWith("pending:")
    ? undefined
    : fileId
      ? `${base}/resources/files/${encodeURIComponent(fileId)}/content`
      : reference && itemId && !storedReference
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
  const video = /\.(mp4|webm|mov|m4v|ogv)$/i.test(filename) || inline?.startsWith("data:video/");
  const content = useQuery({
    queryKey: ["chat-attachment-bytes", sessionId, fileId ?? itemId, reference, inline],
    enabled:
      ((!!url && !!sessionId) || !!inline?.startsWith("data:")) &&
      ((loadImages && (image || video)) || preview || eager),
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
    video,
    metadata,
    content,
    blobUrl,
    mime,
    error,
    download,
    details,
    size,
    resourceKey: JSON.stringify([sessionId, fileId ?? itemId, reference]),
  };
}

/** One authenticated file surface for uploads, agent artifacts and captured Markdown references. */
export function ChatAttachment({
  sessionId,
  attachment: rawAttachment,
  reference,
  itemId,
  compact = false,
  label,
  unresolvedFallback,
}: {
  sessionId: string | null;
  attachment?: AttachmentContent;
  reference?: string;
  itemId?: string | null;
  compact?: boolean;
  /** Preserve an authored Markdown caption independently of captured file metadata. */
  label?: ReactNode;
  /** Implicit prose stays unchanged until its captured reference resolves to a file. */
  unresolvedFallback?: ReactNode;
}) {
  const batched = useMediaBatch();
  const [videoSize, setVideoSize] = useState<{ src: string; width: number; height: number }>();
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [failedImage, setFailedImage] = useState<string>();
  const storedReference = reference ? parseSessionFileSource(reference) : null;
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
    video,
    metadata,
    content,
    blobUrl,
    error,
    download,
    details,
    size,
  } = resource;
  const preview = useImagePreviewSize(blobUrl);
  const stage = mediaPreviewSize(
    video && videoSize?.src === blobUrl ? videoSize : preview.size,
    batched,
  );
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
    return unresolvedFallback ?? <InlinePathCode>{label ?? reference}</InlinePathCode>;
  if (unresolvedFallback !== undefined && !location.data && !content.data)
    return unresolvedFallback;
  return (
    <>
      <FilePreviewMenu actions={menuActions} onOpenChange={setMenuOpen}>
        <span
          className={
            compact
              ? "not-prose inline"
              : cn(
                  "not-prose @container/attachment my-2 flex w-[640px] min-w-[min(100%,12rem)] max-w-full flex-col rounded-lg border border-border bg-background",
                  // Two 24px controls + 2px gap + 24px padding + 2px border need 76px.
                  batched && "my-0 min-w-[76px] shrink-0 max-w-none",
                )
          }
          style={
            !compact && (image || video) && failedImage !== blobUrl && stage
              ? { width: `calc(${stage.width}px + 2px)` }
              : undefined
          }
          data-testid="chat-attachment"
        >
          {!compact && image && blobUrl && failedImage !== blobUrl && (
            <span
              className="flex min-w-0 max-w-full items-center justify-center overflow-hidden rounded-t-lg"
              style={{ height: batched ? 256 : undefined }}
            >
              <ZoomableImage
                src={blobUrl}
                alt={filename}
                gallerySource={
                  sessionId
                    ? galleryAttachmentSource(sessionId, attachment, reference, itemId)
                    : undefined
                }
                galleryItemId={itemId}
                gallerySessionId={sessionId}
                className="block h-auto max-h-64 max-w-full object-contain"
                style={{ width: preview.size?.width }}
                onLoad={preview.onLoad}
                onError={() => setFailedImage(blobUrl)}
              />
            </span>
          )}
          {!compact && video && blobUrl && (
            <span
              className="flex items-center justify-center overflow-hidden rounded-t-lg"
              style={{ height: batched ? 256 : undefined }}
            >
              <video
                src={blobUrl}
                controls
                preload="metadata"
                aria-label={filename}
                className="block h-auto max-h-64 max-w-full object-contain"
                onLoadedMetadata={(event) => {
                  const { videoWidth, videoHeight } = event.currentTarget;
                  if (videoWidth > 0 && videoHeight > 0) {
                    const scale = Math.min(1, 256 / videoHeight);
                    setVideoSize({
                      src: blobUrl,
                      width: videoWidth * scale,
                      height: videoHeight * scale,
                    });
                  }
                }}
                onError={() => toast.error("Video playback unavailable. Download the original.")}
              />
            </span>
          )}
          {compact ? (
            <InlineFileReference
              contextRelative
              path={reference ?? filename}
              filename={filename}
              mimeType={metadata.data?.metadata.content_type}
              onClick={openPreview}
            >
              {label}
            </InlineFileReference>
          ) : (
            <span
              className={cn(
                "chat-attachment-footer flex min-w-0 items-center rounded-b-lg",
                batched && "flex-wrap",
              )}
            >
              <span className="chat-attachment-file-icon flex shrink-0 items-center justify-center rounded-md bg-muted">
                <WorkspaceFileIcon
                  path={filename}
                  mimeType={metadata.data?.metadata.content_type}
                  className="size-5"
                />
              </span>
              <span
                className={cn(
                  "flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 self-center",
                  batched && "basis-32",
                )}
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <TooltipButton
                      type="button"
                      className="block min-w-0 max-w-full flex-[0_1_auto] truncate text-left text-sm font-semibold hover:text-link focus-visible:outline-ring"
                      onClick={openPreview}
                    >
                      {filename}
                    </TooltipButton>
                  </TooltipTrigger>
                  <TooltipContent className="break-all">{reference ?? filenameHint}</TooltipContent>
                </Tooltip>
                <span
                  className={cn(
                    "flex min-w-0 items-center gap-2 text-xs text-muted-foreground",
                    menuActions.path ? "flex-[1_1_8rem]" : "flex-[1_1_auto]",
                    batched && "flex-wrap",
                  )}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span tabIndex={0} className="min-w-0 flex-1 truncate">
                        {details}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="break-all">{details}</TooltipContent>
                  </Tooltip>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-0.5">
                {size && (
                  <span className="mr-1 shrink-0 text-xs text-muted-foreground">{size}</span>
                )}
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
            <AttachmentPreviewBody
              resource={resource}
              request={request}
              sessionId={sessionId ?? ""}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Docked and fallback previews share the captured-byte loader and browser viewers. */
export function AttachmentPreviewView({ request }: { request: AttachmentPreviewRequest }) {
  const resource = useAttachmentResource(request, { preview: true });
  const [headerTarget, setHeaderTarget] = useState<HTMLDivElement | null>(null);
  const isHtml =
    /\.html?$/i.test(resource.filename) || /^text\/html/.test(resource.content.data?.type ?? "");
  return (
    <section
      className="flex h-full min-h-0 min-w-0 flex-col"
      aria-label={`Preview ${resource.filename}`}
    >
      <header className="workspace-control-header flex min-w-0 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{resource.filename}</span>
        <div ref={setHeaderTarget} className="flex shrink-0 items-center gap-1" />
        {!isHtml && <AttachmentPreviewActions request={request} resource={resource} header />}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <PreviewHeaderContext.Provider value={headerTarget}>
          <AttachmentPreviewBody
            resource={resource}
            request={request}
            sessionId={request.sessionId}
          />
        </PreviewHeaderContext.Provider>
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
      {header && (
        <FilePreviewMenu
          dropdown
          actions={{
            path: request.reference,
            download: resource.available ? () => void resource.download() : undefined,
            reveal: canReveal
              ? () => {
                  if (context.canRevealAttachment?.(request) !== false)
                    void context.revealAttachment?.(request);
                }
              : undefined,
          }}
        >
          <HeaderActionButton aria-label="More preview actions" tooltip={false}>
            <MoreHorizontalIcon />
          </HeaderActionButton>
        </FilePreviewMenu>
      )}
      {!header && canReveal && (
        <Action
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            if (context.canRevealAttachment?.(request) !== false)
              void context.revealAttachment?.(request);
          }}
        >
          <FolderOpenIcon />
          Reveal in Explorer
        </Action>
      )}
    </div>
  );
}

function AttachmentPreviewBody({
  resource,
  request,
  sessionId,
}: {
  resource: AttachmentResource;
  request: AttachmentPreviewRequest;
  sessionId: string;
}) {
  const { content, error, blobUrl, filename } = resource;
  if (content.isFetching && !content.data) return <ContentSkeleton label="Loading file…" />;
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
      artifactIdentity={resource.fileId ? `${sessionId}:${resource.fileId}` : resource.resourceKey}
      request={request}
    />
  );
}

export function AttachmentPreview({
  blob,
  url,
  filename,
  sessionId,
  artifactIdentity,
  request,
}: {
  blob: Blob;
  url: string;
  filename: string;
  sessionId: string;
  artifactIdentity?: string;
  request?: AttachmentPreviewRequest;
}) {
  const previewContext = useContext(AttachmentPreviewContext);
  const canOpenTab =
    !!request &&
    !!previewContext.openAttachment &&
    previewContext.canOpenAttachment?.(request, "tab") !== false;
  const lang = detectLang(filename);
  const html =
    /\.html?$/i.test(filename) || /^(text\/html|application\/xhtml\+xml)(;|$)/i.test(blob.type);
  const isText =
    html ||
    blob.type.startsWith("text/") ||
    /\.(md|txt|log|json|ya?ml|csv|tsv|[cm]?[jt]sx?|py|sh|rs|go|html?)$/i.test(filename);
  const [text, setText] = useState<string>();
  const [source, setSource] = useState(false);
  useEffect(() => {
    let active = true;
    if (isText)
      void blob
        .slice(0, html ? blob.size : TEXT_BYTES)
        .text()
        .then((value) => {
          if (active) setText(value);
        });
    return () => {
      active = false;
    };
  }, [blob, isText, html]);
  if (blob.type.startsWith("image/") || /\.(svg|png|jpe?g|webp|avif|gif)$/i.test(filename))
    return <AttachmentImagePreview url={url} filename={filename} blob={blob} />;
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
      <Suspense fallback={<ContentSkeleton label="Loading PDF…" />}>
        <AttachmentPdf blob={blob} filename={filename} sessionId={sessionId} />
      </Suspense>
    );
  if (!isText)
    return (
      <p className="text-sm text-muted-foreground">
        Preview is unavailable for this format. Download the original to open it.
      </p>
    );
  if (text === undefined) return <ContentSkeleton label="Loading text…" />;
  if (html)
    return (
      <Suspense fallback={<ContentSkeleton label="Preparing artifact…" />}>
        <ArtifactFrame
          html={text}
          identity={artifactIdentity ?? `${sessionId}:${filename}`}
          title={filename}
          onDownloadOriginal={() => downloadBlob(blob, filename)}
          onRevealInExplorer={
            request?.itemId &&
            request.reference &&
            !parseSessionFileSource(request.reference) &&
            previewContext.revealAttachment &&
            previewContext.canRevealAttachment?.(request) !== false
              ? () => {
                  if (previewContext.canRevealAttachment?.(request) !== false)
                    void previewContext.revealAttachment?.(request);
                }
              : undefined
          }
          onOpenTab={
            canOpenTab
              ? () => previewContext.openAttachment?.(request!, { placement: "tab" })
              : undefined
          }
        />
      </Suspense>
    );
  const markdown = lang === "markdown";
  return (
    <div className="space-y-2">
      {markdown && (
        <Button type="button" variant="outline" size="sm" onClick={() => setSource(!source)}>
          {source ? "Preview" : "Source"}
        </Button>
      )}
      {blob.size > TEXT_BYTES && (
        <p role="status" className="text-xs text-muted-foreground">
          Preview limited to 512 KiB. Download for the complete file.
        </p>
      )}
      {markdown && !source ? (
        <Suspense fallback={<ContentSkeleton label="Loading Markdown…" />}>
          <MarkdownPreview content={text} path={null} tocOpen={false} onTocOpenChange={() => {}} />
        </Suspense>
      ) : (
        <CodeBlock code={text} language={lang} wrap />
      )}
    </div>
  );
}

function AttachmentImagePreview({
  url,
  filename,
  blob,
}: {
  url: string;
  filename: string;
  blob: Blob;
}) {
  const headerTarget = useContext(PreviewHeaderContext);
  const [zoom, setZoom] = useState(1);
  const [source, setSource] = useState(false);
  const [svgSource, setSvgSource] = useState<string>();
  const svg = blob.type === "image/svg+xml" || /\.svg$/i.test(filename);
  useEffect(() => {
    if (!svg || !headerTarget) return;
    let active = true;
    void blob.text().then((text) => {
      if (active) setSvgSource(text);
    });
    return () => {
      active = false;
    };
  }, [blob, svg, headerTarget]);
  return (
    <>
      {headerTarget &&
        createPortal(
          <>
            {svg && (
              <HeaderActionButton
                aria-label={source ? "Preview" : "Source"}
                onClick={() => setSource(!source)}
              >
                {source ? <EyeIcon /> : <CodeIcon />}
              </HeaderActionButton>
            )}
            <HeaderActionButton
              aria-label="Zoom out"
              disabled={zoom <= 1}
              onClick={() => setZoom((value) => Math.max(1, value - 0.5))}
            >
              <ZoomOutIcon />
            </HeaderActionButton>
            <Button variant="ghost" size="sm" aria-label="Fit image" onClick={() => setZoom(1)}>
              {zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`}
            </Button>
            <HeaderActionButton
              aria-label="Zoom in"
              disabled={zoom >= 8}
              onClick={() => setZoom((value) => Math.min(8, value + 0.5))}
            >
              <ZoomInIcon />
            </HeaderActionButton>
          </>,
          headerTarget,
        )}
      {source ? (
        <CodeBlock code={svgSource ?? ""} language="xml" wrap />
      ) : (
        <ZoomableImage
          src={url}
          alt={filename}
          className="max-h-[65dvh] max-w-full object-contain"
          style={{ zoom }}
        />
      )}
    </>
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
