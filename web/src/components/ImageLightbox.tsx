// Modified for Triune.
import { TooltipButton } from "@/components/ui/tooltip";
import * as React from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as DialogPrimitive from "radix-ui/dialog";
import {
  ZoomInIcon,
  ZoomOutIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ImageIcon,
} from "lucide-react";

import { getEmbedRoot } from "@/lib/host";
import { Button } from "@/components/ui/button";
import { CloseButton } from "@/components/CloseButton";
import { WorkspaceTabsScroller } from "@/shell/WorkspaceTabsScroller";
import { cn } from "@/lib/utils";
import { useChatImageGallery, type ChatGalleryScope } from "./ChatImageGallery";
import { gallerySwipe, type GalleryImage } from "./imageGallery";
import { authenticatedFetch } from "@/lib/identity";
import { downloadBlob } from "@/lib/explorerOperations";
import { toast } from "@/lib/notifications";
import { ContentSkeleton } from "@/components/ui/loading";

// Zoom bounds and step for the lightbox viewer. 1 = fit-to-viewport.
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.25;

/** Pointer travel that separates a pan from a click, in CSS pixels. */
const DRAG_SLOP_PX = 4;

const PREVIEW_CONTROL_SURFACE =
  "bg-background/80 text-foreground shadow-sm ring-1 ring-foreground/10 backdrop-blur-xs";

/** Existing button/close roles with one material and isolated overlay hit targets. */
const PreviewControl = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof Button> & { close?: boolean; grouped?: boolean }
>(function PreviewControl({ close, grouped, className, onClick, onPointerDown, ...props }, ref) {
  const Control = close ? CloseButton : Button;
  return (
    <Control
      type="button"
      variant="ghost"
      size="icon"
      {...props}
      ref={ref}
      className={cn(
        !grouped && PREVIEW_CONTROL_SURFACE,
        "disabled:pointer-events-auto motion-reduce:transition-none [@media(any-pointer:coarse)]:min-h-11 [@media(any-pointer:coarse)]:min-w-11",
        className,
      )}
      onPointerDown={(event) => {
        event.stopPropagation();
        onPointerDown?.(event);
      }}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
    />
  );
});

function useGalleryImageSource(source: string, initial?: string, enabled = true) {
  // External previews follow the browser's image path, never the session fetcher.
  const direct = initial || (/^(?:data:image\/|https?:\/\/)/i.test(source) ? source : undefined);
  const [resolved, setResolved] = useState<{ source: string; src?: string; error?: boolean }>();
  useEffect(() => {
    if (direct || !enabled) return;
    let cancelled = false;
    void import("./SessionImage")
      .then((module) => module.loadSessionImageSource(source))
      .then(
        (src) => {
          if (!cancelled) setResolved({ source, src });
        },
        () => {
          if (!cancelled) setResolved({ source, error: true });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [source, direct, enabled]);
  return direct ? { src: direct, error: false } : resolved?.source === source ? resolved : {};
}

function GalleryThumbnail({
  image,
  selected,
  index,
  onSelect,
}: {
  image: GalleryImage;
  selected: boolean;
  index: number;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [selected]);
  const display = useGalleryImageSource(image.source, undefined, visible || selected);
  const [decoded, setDecoded] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const unavailable = display.error || (!!display.src && failed === display.src);
  const loading = !unavailable && (!display.src || decoded !== display.src);
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      aria-label={`View image ${index + 1}: ${image.alt}`}
      aria-current={selected ? "true" : undefined}
      aria-busy={loading}
      aria-description={unavailable ? "Thumbnail unavailable" : undefined}
      className="h-16 w-20 shrink-0 p-0 motion-reduce:transition-none"
      onClick={onSelect}
    >
      <span
        data-gallery-thumbnail-visual
        className={cn(
          "relative flex h-12 w-16 items-center justify-center overflow-hidden rounded-md border bg-muted",
          selected ? "scale-110 border-primary ring-1 ring-primary" : "border-border",
        )}
      >
        {loading && <span aria-hidden="true" className="absolute inset-0 bg-muted" />}
        {display.src && !unavailable && (
          <img
            src={display.src}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className={cn("size-full object-cover", loading && "opacity-0")}
            onLoad={async (event) => {
              const node = event.currentTarget;
              const src = display.src;
              try {
                await node.decode?.();
                setDecoded(src);
              } catch {
                setFailed(src);
              }
            }}
            onError={() => setFailed(display.src)}
          />
        )}
        {unavailable && <ImageIcon className="size-4 text-muted-foreground" />}
      </span>
    </Button>
  );
}

function clampZoom(z: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

interface LightboxImage {
  src: string;
  alt: string;
  filename?: string;
  source?: string;
  itemId?: string | null;
  gallery?: ChatGalleryScope | null;
  download?: () => void | Promise<void>;
}

interface LightboxContextValue {
  open: (image: LightboxImage) => void;
}

// No-op fallback so image components keep working (just non-zoomable) when
// rendered outside the provider — e.g. in isolated unit tests.
const NOOP: LightboxContextValue = { open: () => {} };

const LightboxContext = createContext<LightboxContextValue | null>(null);

export function useLightbox(): LightboxContextValue {
  return useContext(LightboxContext) ?? NOOP;
}

export const IMAGE_PREVIEW_MAX_HEIGHT = 256;

/** Fit intrinsic pixels without upscaling; CSS may further constrain the width. */
export function fitImagePreviewSize(width: number, height: number, maxWidth = Infinity) {
  if (!(width > 0 && height > 0 && maxWidth > 0) || !Number.isFinite(width + height))
    return undefined;
  const scale = Math.min(1, IMAGE_PREVIEW_MAX_HEIGHT / height, maxWidth / width);
  return { width: width * scale, height: height * scale };
}

/** Keep decoded geometry tied to its source when a retained preview changes files. */
export function useImagePreviewSize(src?: string) {
  const [loaded, setLoaded] = useState<{
    src?: string;
    size: { width: number; height: number };
  }>();
  return {
    size: loaded?.src === src ? loaded?.size : undefined,
    onLoad: (event: React.SyntheticEvent<HTMLImageElement>) => {
      const { naturalWidth, naturalHeight } = event.currentTarget;
      const size = fitImagePreviewSize(naturalWidth, naturalHeight);
      if (size) setLoaded({ src, size });
    },
  };
}

export interface ZoomableImageProps extends React.ComponentProps<"img"> {
  /** Display source. May be undefined while the image is still resolving. */
  src?: string;
  alt: string;
  /** Stable authorized source; blob URLs are only a display detail. */
  gallerySource?: string;
  galleryItemId?: string | null;
  gallerySessionId?: string | null;
  onDownload?: () => void | Promise<void>;
}

/**
 * An `<img>` wrapped in a `<button>` that opens it in the shared lightbox. The
 * button carries the interaction (click + Enter/Space + focus ring, all native
 * to a button); the inner `<img>` keeps its `role="img"` and alt-derived name,
 * so screen readers and tests still see a real image. Activation is a no-op
 * until `src` resolves. `className` styles the inner `<img>` (sizing,
 * `object-contain`, etc.) — the button is a layout-transparent wrapper.
 */
export function ZoomableImage({
  src,
  alt,
  className,
  gallerySource,
  galleryItemId,
  gallerySessionId,
  onDownload,
  ...imgProps
}: ZoomableImageProps) {
  const { open } = useLightbox();
  const gallery = useChatImageGallery();
  return (
    <TooltipButton
      type="button"
      aria-label={alt ? `Zoom image: ${alt}` : "Zoom image"}
      className="m-0 inline-flex min-w-0 max-w-full cursor-zoom-in appearance-none border-0 bg-transparent p-0 leading-none"
      onClick={() => {
        if (src)
          open({
            src,
            alt,
            source: gallerySource ?? gallery?.imageSource ?? src,
            itemId: galleryItemId ?? gallery?.imageItemId,
            gallery:
              gallerySessionId && gallerySessionId !== gallery?.conversationId ? null : gallery,
            download: onDownload,
          });
      }}
    >
      <img {...imgProps} src={src} alt={alt} className={className} />
    </TooltipButton>
  );
}

/**
 * The zoomable image inside the lightbox card. Holds its own zoom/pan state and
 * is keyed by `src` in the provider so that state resets per image.
 *
 * Zoom: pinch, scroll wheel, the +/- toolbar buttons, or
 * double-click to toggle between fit and 2x. Pan: drag while zoomed in. The
 * image is `object-contain` within a fixed-size viewport that clips overflow,
 * so the zoomed image never escapes the card. Content clicks toggle overlays.
 */
function ZoomViewer({
  image,
  onClose,
  onNavigate,
  gallery,
  suppressClick,
  controlsVisible,
  onToggleControls,
}: {
  image: LightboxImage;
  onClose: () => void;
  onNavigate: (direction: -1 | 1) => void;
  gallery: boolean;
  suppressClick: React.MutableRefObject<boolean>;
  controlsVisible: boolean;
  onToggleControls: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [view, setView] = useState({ zoom: MIN_ZOOM, x: 0, y: 0 });
  const viewRef = useRef(view);
  const { zoom, ...offset } = view;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragRef = useRef<{
    pointerId: number;
    originX: number;
    originY: number;
    swipe: boolean;
  } | null>(null);
  const pinchRef = useRef<{
    distance: number;
    x: number;
    y: number;
    view: typeof view;
  } | null>(null);
  const pannedRef = suppressClick;
  const display = useGalleryImageSource(image.source ?? image.src, image.src);

  const applyView = useCallback((nextZoom: number, x: number, y: number) => {
    const fittedZoom = clampZoom(nextZoom);
    const viewport = viewportRef.current;
    const preview = imageRef.current;
    const limitX = Math.max(
      0,
      ((preview?.offsetWidth ?? 0) * fittedZoom - (viewport?.clientWidth ?? 0)) / 2,
    );
    const limitY = Math.max(
      0,
      ((preview?.offsetHeight ?? 0) * fittedZoom - (viewport?.clientHeight ?? 0)) / 2,
    );
    const next = {
      zoom: fittedZoom,
      x: fittedZoom === MIN_ZOOM ? 0 : Math.max(-limitX, Math.min(limitX, x)),
      y: fittedZoom === MIN_ZOOM ? 0 : Math.max(-limitY, Math.min(limitY, y)),
    };
    viewRef.current = next;
    setView(next);
  }, []);

  const clearGesture = useCallback(
    (viewport = viewportRef.current) => {
      const active = [...pointers.current.keys()];
      pointers.current.clear();
      dragRef.current = null;
      pinchRef.current = null;
      if (active.length) pannedRef.current = true;
      for (const pointerId of active) {
        if (viewport?.hasPointerCapture?.(pointerId)) viewport.releasePointerCapture(pointerId);
      }
    },
    [pannedRef],
  );

  const resetView = useCallback(() => {
    clearGesture();
    applyView(MIN_ZOOM, 0, 0);
  }, [applyView, clearGesture]);

  const applyZoom = useCallback(
    (next: number) => {
      clearGesture();
      applyView(next, viewRef.current.x, viewRef.current.y);
    },
    [applyView, clearGesture],
  );

  // Non-passive wheel handling keeps desktop zoom from scrolling the page.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      applyZoom(viewRef.current.zoom - Math.sign(event.deltaY) * ZOOM_STEP * 2);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyZoom]);

  const resizeView = useCallback(() => {
    clearGesture();
    const current = viewRef.current;
    applyView(current.zoom, current.x, current.y);
  }, [applyView, clearGesture]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const observer = new ResizeObserver(resizeView);
    if (viewport) observer.observe(viewport);
    if (imageRef.current) observer.observe(imageRef.current);
    window.addEventListener("resize", resizeView);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", resizeView);
      clearGesture(viewport);
    };
  }, [resizeView, clearGesture]);

  // Rebase at each contact-count change so lifting a finger never jumps the image.
  const rebaseGesture = () => {
    const contacts = [...pointers.current.entries()];
    dragRef.current = null;
    pinchRef.current = null;
    if (contacts.length === 2) {
      const [, first] = contacts[0];
      const [, second] = contacts[1];
      pannedRef.current = true;
      pinchRef.current = {
        distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
        view: viewRef.current,
      };
    } else if (contacts.length === 1) {
      const [pointerId, point] = contacts[0];
      dragRef.current = {
        pointerId,
        originX: point.x,
        originY: point.y,
        swipe: viewRef.current.zoom === MIN_ZOOM && !pannedRef.current,
      };
    }
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button > 0 || (event.isPrimary === false && event.pointerType !== "touch")) return;
    if (pointers.current.size >= 2) return;
    if (!pointers.current.size) pannedRef.current = false;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    rebaseGesture();
  };
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pinch = pinchRef.current;
    if (pinch) {
      const [first, second] = [...pointers.current.values()];
      const nextZoom = clampZoom(
        (pinch.view.zoom * Math.hypot(second.x - first.x, second.y - first.y)) / pinch.distance,
      );
      const ratio = nextZoom / pinch.view.zoom;
      const bounds = event.currentTarget.getBoundingClientRect();
      const centerX = bounds.left + bounds.width / 2;
      const centerY = bounds.top + bounds.height / 2;
      applyView(
        nextZoom,
        (first.x + second.x) / 2 - centerX - (pinch.x - centerX - pinch.view.x) * ratio,
        (first.y + second.y) / 2 - centerY - (pinch.y - centerY - pinch.view.y) * ratio,
      );
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY) > DRAG_SLOP_PX)
      pannedRef.current = true;
    const current = viewRef.current;
    if (current.zoom > MIN_ZOOM)
      applyView(
        current.zoom,
        current.x + event.clientX - previous.x,
        current.y + event.clientY - previous.y,
      );
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    if (event.type !== "pointerup") {
      clearGesture();
      return;
    }
    const drag = dragRef.current;
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    rebaseGesture();
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.originX;
    const dy = event.clientY - drag.originY;
    if (Math.hypot(dx, dy) > DRAG_SLOP_PX) pannedRef.current = true;
    const action = drag.swipe ? gallerySwipe(dx, dy, viewRef.current.zoom) : null;
    if (action && (gallery || action === "dismiss")) {
      pannedRef.current = true;
      event.preventDefault();
      if (action === "dismiss") onClose();
      else onNavigate(action === "next" ? 1 : -1);
    }
  };

  const onStageClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (pannedRef.current) return;
    if (event.target === event.currentTarget) {
      onClose();
      return;
    }
    // The two clicks of a double-click cancel, leaving chrome unchanged.
    onToggleControls();
  };

  const zoomed = zoom > MIN_ZOOM;

  return (
    <>
      <div
        ref={viewportRef}
        className="absolute inset-0 flex items-center justify-center overflow-hidden"
        data-testid="lightbox-stage"
        onClick={onStageClick}
        onDoubleClick={() => applyZoom(zoomed ? MIN_ZOOM : 2)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        style={{
          touchAction: "none",
          cursor: zoomed ? (dragRef.current ? "grabbing" : "grab") : "default",
        }}
      >
        <img
          ref={imageRef}
          src={display.src}
          onLoad={resizeView}
          referrerPolicy="no-referrer"
          hidden={!display.src}
          alt={image.alt}
          draggable={false}
          className="max-h-full max-w-[94vw] origin-center object-contain select-none"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          }}
        />
        {!display.src && !display.error && (
          <ContentSkeleton label="Loading image…" className="max-w-sm" />
        )}
        {display.error && (
          <p role="alert" className={cn("rounded-md px-3 py-2 text-sm", PREVIEW_CONTROL_SURFACE)}>
            Image unavailable. Close and reopen to retry.
          </p>
        )}
      </div>
      <div hidden={!controlsVisible}>
        <div
          style={{
            top: "calc(0.75rem + var(--omnigent-safe-top, 0px))",
          }}
          className={cn(
            "absolute left-1/2 flex h-10 -translate-x-1/2 items-center gap-0 rounded-md md:h-8 [@media(any-pointer:coarse)]:h-11",
            PREVIEW_CONTROL_SURFACE,
          )}
        >
          <PreviewControl
            grouped
            variant="ghost"
            size="icon"
            aria-label="Zoom out"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => applyZoom(zoom - ZOOM_STEP * 2)}
          >
            <ZoomOutIcon />
          </PreviewControl>
          <PreviewControl
            grouped
            type="button"
            aria-label="Reset zoom"
            size="sm"
            className="h-10 min-w-[3ch] cursor-pointer text-center text-sm tabular-nums text-muted-foreground hover:text-foreground md:h-8"
            onClick={resetView}
          >
            {Math.round(zoom * 100)}%
          </PreviewControl>
          <PreviewControl
            grouped
            variant="ghost"
            size="icon"
            aria-label="Zoom in"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => applyZoom(zoom + ZOOM_STEP * 2)}
          >
            <ZoomInIcon />
          </PreviewControl>
        </div>
      </div>
    </>
  );
}

/**
 * Provides a single shared full-screen image viewer for the whole app. Any
 * image wired with {@link useImageZoomProps} opens here. Built on the Radix
 * Dialog primitive, so Escape closes it for free; an explicit "x" button and a
 * vertical swipe at fit provide the other close affordances.
 */
export function ImageLightboxProvider({ children }: { children: React.ReactNode }) {
  const [image, setImage] = useState<LightboxImage | null>(null);
  const [opening, setOpening] = useState<LightboxImage | null>(null);
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [selected, setSelected] = useState(0);
  const [viewKey, setViewKey] = useState(0);
  const [historyState, setHistoryState] = useState<"loading" | "ready" | "error">("ready");
  const [retry, setRetry] = useState(0);
  const suppressClick = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const toggleControls = useCallback(() => {
    // Move focus out before hiding the overlay that currently owns it.
    dialogRef.current?.focus({ preventScroll: true });
    setControlsVisible((visible) => !visible);
  }, []);
  const open = useCallback((img: LightboxImage) => {
    setControlsVisible(true);
    setImage(img);
    setOpening(img);
    setImages([]);
    setHistoryState(img.gallery ? "loading" : "ready");
    setSelected(0);
    setViewKey((key) => key + 1);
    suppressClick.current = false;
  }, []);
  const close = useCallback(() => {
    setImage(null);
    setOpening(null);
    setImages([]);
  }, []);
  const value = useMemo(() => ({ open }), [open]);
  useEffect(() => {
    if (!opening?.gallery) {
      setHistoryState("ready");
      return;
    }
    const scope = opening.gallery;
    const controller = new AbortController();
    setHistoryState("loading");
    scope.load(controller.signal).then(
      (found) => {
        if (controller.signal.aborted) return;
        // Match source identity, never a mounted row's position or a temporary blob URL.
        const index = found.findIndex(
          (candidate) =>
            candidate.source === opening.source &&
            (!opening.itemId || candidate.itemId === opening.itemId),
        );
        const all =
          index >= 0
            ? found
            : [
                ...found,
                {
                  id: "opened-image",
                  source: opening.source ?? opening.src,
                  alt: opening.alt,
                  sessionId: scope.conversationId,
                  itemId: opening.itemId,
                },
              ];
        setImages(all);
        setSelected(index >= 0 ? index : all.length - 1);
        setHistoryState("ready");
      },
      () => {
        if (!controller.signal.aborted) setHistoryState("error");
      },
    );
    return () => controller.abort();
  }, [opening, retry]);
  const select = useCallback(
    (index: number) => {
      const next = images[index];
      if (!next || index === selected) return;
      setSelected(index);
      setImage({
        src: "",
        source: next.source,
        alt: next.alt,
        filename: next.filename,
        itemId: next.itemId,
      });
      setViewKey((key) => key + 1);
    },
    [images, selected],
  );
  const navigate = useCallback(
    (direction: -1 | 1) => select(selected + direction),
    [select, selected],
  );
  async function downloadImage() {
    if (!image) return;
    try {
      if (image.download) {
        await image.download();
        return;
      }
      const source = image.source || image.src;
      const filename = image.filename || image.alt.split(/[\\/]/).at(-1) || "image";
      if (!source.startsWith("/v1/")) {
        const link = document.createElement("a");
        link.href = source;
        link.download = filename;
        link.rel = "noopener";
        link.click();
        return;
      }
      const response = await authenticatedFetch(source);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      downloadBlob(await response.blob(), filename);
    } catch (failure) {
      toast.error("Could not download image", { description: String(failure) });
    }
  }

  return (
    <LightboxContext.Provider value={value}>
      {children}
      <DialogPrimitive.Root
        open={image !== null}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogPrimitive.Portal container={getEmbedRoot() ?? undefined}>
          {/* Dark backdrop — dims the whole page to focus on the preview. */}
          <DialogPrimitive.Overlay
            className={cn(
              "fixed inset-0 z-[60] bg-background/70 backdrop-blur-md duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
              "data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
              "motion-reduce:animate-none motion-reduce:transition-none",
            )}
          />
          {/* Full-screen stage (Slack-style): the image sits centered on the
              dark backdrop and can zoom to fill the whole viewport, clipped to
              the screen rather than to a small card. */}
          <DialogPrimitive.Content
            ref={dialogRef}
            className={cn(
              "fixed inset-0 z-[60] outline-none",
              "duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
              "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
              "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              "motion-reduce:animate-none motion-reduce:transition-none",
            )}
            // The image carries its own description; the title is for a11y only.
            aria-describedby={undefined}
            onClick={(event) => {
              const target = event.target;
              if (
                !suppressClick.current &&
                target instanceof Element &&
                !target.closest("button, img, a, [role=alert], [role=status]")
              )
                close();
            }}
            onInteractOutside={(e) => e.preventDefault()}
            onKeyDown={(event) => {
              if (
                !controlsVisible &&
                ["Tab", "ArrowLeft", "ArrowRight", "Enter", " "].includes(event.key)
              ) {
                setControlsVisible(true);
                if (event.key === "Tab") event.preventDefault();
              }
              if (images.length > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                event.preventDefault();
                event.stopPropagation();
                navigate(event.key === "ArrowRight" ? 1 : -1);
              }
            }}
          >
            <DialogPrimitive.Title className="sr-only">
              {image?.alt || "Image preview"}
            </DialogPrimitive.Title>
            {/* key by src so zoom/pan state resets when a new image opens. */}
            {image && (
              <ZoomViewer
                key={viewKey}
                image={image}
                onClose={close}
                onNavigate={navigate}
                gallery={images.length > 1}
                suppressClick={suppressClick}
                controlsVisible={controlsVisible}
                onToggleControls={toggleControls}
              />
            )}
            <p role="status" className="sr-only">
              {historyState === "loading"
                ? "Loading chat images…"
                : historyState === "error"
                  ? "Could not load chat images. Retry image history."
                  : images.length
                    ? `Image ${selected + 1} of ${images.length}`
                    : ""}
            </p>
            <div hidden={!controlsVisible} data-lightbox-controls>
              {images.length > 1 && (
                <>
                  <PreviewControl
                    size="icon"
                    aria-label="Previous image"
                    disabled={selected === 0}
                    className="absolute top-1/2 -translate-y-1/2"
                    style={{ left: "calc(0.75rem + var(--omnigent-safe-left, 0px))" }}
                    onClick={() => navigate(-1)}
                  >
                    <ChevronLeftIcon />
                  </PreviewControl>
                  <PreviewControl
                    size="icon"
                    aria-label="Next image"
                    disabled={selected === images.length - 1}
                    className="absolute top-1/2 -translate-y-1/2"
                    style={{ right: "calc(0.75rem + var(--omnigent-safe-right, 0px))" }}
                    onClick={() => navigate(1)}
                  >
                    <ChevronRightIcon />
                  </PreviewControl>
                </>
              )}
              <div
                className="absolute flex flex-col items-center gap-1"
                style={{
                  left: "calc(0.75rem + var(--omnigent-safe-left, 0px))",
                  right: "calc(0.75rem + var(--omnigent-safe-right, 0px))",
                  bottom: "calc(0.75rem + var(--omnigent-safe-bottom, 0px))",
                }}
              >
                {historyState === "loading" && (
                  <div
                    aria-hidden="true"
                    className="flex h-16 max-w-full items-center gap-1 overflow-hidden"
                  >
                    {[0, 1, 2].map((slot) => (
                      <span key={slot} className="h-12 w-16 shrink-0 rounded-md bg-muted" />
                    ))}
                  </div>
                )}
                {historyState === "ready" && images.length > 0 && (
                  <>
                    <p
                      aria-hidden="true"
                      className={cn(
                        "rounded-md px-1.5 text-[10px] leading-4",
                        PREVIEW_CONTROL_SURFACE,
                      )}
                    >
                      {selected + 1} / {images.length}
                    </p>
                    <WorkspaceTabsScroller
                      role="group"
                      aria-label="Chat images"
                      grow={false}
                      activeAlignment="center"
                      activeKey={images[selected]?.id}
                      containWheel
                      data-scrollbar="hidden"
                      className="gallery-thumbnail-roll w-full"
                      contentClassName="gap-1"
                    >
                      {images.map((entry, index) => (
                        <GalleryThumbnail
                          key={entry.id}
                          image={entry}
                          index={index}
                          selected={index === selected}
                          onSelect={() => select(index)}
                        />
                      ))}
                    </WorkspaceTabsScroller>
                  </>
                )}
                {historyState === "error" && (
                  <PreviewControl size="sm" onClick={() => setRetry((count) => count + 1)}>
                    Retry image history
                  </PreviewControl>
                )}
              </div>
              <PreviewControl
                aria-label="Download image"
                className="absolute"
                style={{
                  top: "calc(0.75rem + var(--omnigent-safe-top, 0px))",
                  left: "calc(0.75rem + var(--omnigent-safe-left, 0px))",
                }}
                onClick={() => void downloadImage()}
              >
                <DownloadIcon />
              </PreviewControl>
              <DialogPrimitive.Close asChild>
                <PreviewControl
                  close
                  aria-label="Close"
                  className="absolute"
                  style={{
                    top: "calc(0.75rem + var(--omnigent-safe-top, 0px))",
                    right: "calc(0.75rem + var(--omnigent-safe-right, 0px))",
                  }}
                />
              </DialogPrimitive.Close>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </LightboxContext.Provider>
  );
}
