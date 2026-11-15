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
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  ImageIcon,
} from "lucide-react";

import { getEmbedRoot } from "@/lib/host";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useChatImageGallery, type ChatGalleryScope } from "./ChatImageGallery";
import { gallerySwipe, type GalleryImage } from "./imageGallery";
import { authenticatedFetch } from "@/lib/identity";
import { downloadBlob } from "@/lib/explorerOperations";
import { toast } from "@/lib/notifications";

// Zoom bounds and step for the lightbox viewer. 1 = fit-to-viewport.
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 0.25;

/** Pointer travel that separates a pan from a click, in CSS pixels. */
const DRAG_SLOP_PX = 4;

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
    if (selected) node.scrollIntoView?.({ block: "nearest", inline: "nearest" });
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
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      aria-label={`View image ${index + 1}: ${image.alt}`}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "h-12 w-16 shrink-0 overflow-hidden rounded-md border p-0",
        selected ? "border-primary ring-1 ring-primary" : "border-border bg-background/80",
      )}
      onClick={onSelect}
    >
      {display.src ? (
        <img
          src={display.src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-cover"
        />
      ) : (
        <ImageIcon className="size-4 text-muted-foreground" />
      )}
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
 * Zoom: scroll wheel, the +/- toolbar buttons, or
 * double-click to toggle between fit and 2x. Pan: drag while zoomed in. The
 * image is `object-contain` within a fixed-size viewport that clips overflow,
 * so the zoomed image never escapes the card. A click on the empty stage
 * around the image dismisses the preview.
 */
function ZoomViewer({
  image,
  onClose,
  onNavigate,
  gallery,
  suppressClick,
}: {
  image: LightboxImage;
  onClose: () => void;
  onNavigate: (direction: -1 | 1) => void;
  gallery: boolean;
  suppressClick: React.MutableRefObject<boolean>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // Active pointer drag (panning); null when not dragging.
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  // Whether the current gesture panned, so its closing click isn't a dismiss.
  const pannedRef = suppressClick;
  const display = useGalleryImageSource(image.source ?? image.src, image.src);

  const resetView = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const applyZoom = useCallback((next: number) => setZoom(clampZoom(next)), []);

  // Wheel-to-zoom. Attached as a non-passive native listener so preventDefault
  // works (React's onWheel is passive and would warn), keeping the page behind
  // the modal from scrolling while zooming.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => clampZoom(z - Math.sign(e.deltaY) * ZOOM_STEP * 2));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Drop pan offset whenever zoom returns to fit.
  useEffect(() => {
    if (zoom === MIN_ZOOM) setOffset({ x: 0, y: 0 });
  }, [zoom]);

  const onPointerDown = (e: React.PointerEvent) => {
    pannedRef.current = false;
    if (e.button > 0 || e.isPrimary === false) {
      pannedRef.current = true;
      dragRef.current = null;
      return;
    }
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX - offset.x,
      startY: e.clientY - offset.y,
      originX: e.clientX,
      originY: e.clientY,
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (Math.hypot(e.clientX - drag.originX, e.clientY - drag.originY) > DRAG_SLOP_PX) {
      pannedRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    if (zoom > MIN_ZOOM) setOffset({ x: e.clientX - drag.startX, y: e.clientY - drag.startY });
  };
  const endDrag = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    if (Math.hypot(e.clientX - drag.originX, e.clientY - drag.originY) > DRAG_SLOP_PX)
      pannedRef.current = true;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (e.type === "pointercancel") {
      pannedRef.current = true;
      return;
    }
    const action = gallerySwipe(e.clientX - drag.originX, e.clientY - drag.originY, zoom);
    if (action && (gallery || action === "dismiss")) {
      pannedRef.current = true;
      e.preventDefault();
      if (action === "dismiss") onClose();
      else onNavigate(action === "next" ? 1 : -1);
    }
  };

  // A click on the stage dismisses, but only a real one: a click whose target
  // is the image (or the toolbar) is not "outside", and the click a pan leaves
  // behind when the pointer is released would otherwise close the preview
  // every time someone repositions a zoomed image.
  const onStageClick = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget || pannedRef.current) return;
    onClose();
  };

  const zoomed = zoom > MIN_ZOOM;

  return (
    <>
      <div
        ref={viewportRef}
        className="absolute inset-x-0 top-0 flex items-center justify-center overflow-hidden"
        data-testid="lightbox-stage"
        onClick={onStageClick}
        onDoubleClick={() => applyZoom(zoomed ? MIN_ZOOM : 2)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        style={{
          bottom: gallery ? "calc(7rem + var(--omnigent-safe-bottom, 0px))" : 0,
          touchAction: "none",
          cursor: zoomed ? (dragRef.current ? "grabbing" : "grab") : "zoom-in",
        }}
      >
        <img
          src={display.src}
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
          <p role="status" className="text-sm text-white">
            Loading image…
          </p>
        )}
        {display.error && (
          <p role="alert" className="text-sm text-white">
            Image unavailable. Close and reopen to retry.
          </p>
        )}
      </div>
      {/* Zoom toolbar — bottom-center pill. */}
      <div
        style={{
          bottom: gallery
            ? "calc(6rem + var(--omnigent-safe-bottom, 0px))"
            : "calc(0.75rem + var(--omnigent-safe-bottom, 0px))",
        }}
        className={cn(
          "absolute left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-background/80 p-1 shadow-sm ring-1 ring-foreground/10 backdrop-blur-xs",
          gallery ? "bottom-24" : "bottom-3",
        )}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom out"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => applyZoom(zoom - ZOOM_STEP * 2)}
        >
          <ZoomOutIcon />
        </Button>
        <TooltipButton
          type="button"
          aria-label="Reset zoom"
          className="min-w-[3ch] cursor-pointer text-center text-sm tabular-nums text-muted-foreground hover:text-foreground"
          onClick={resetView}
        >
          {Math.round(zoom * 100)}%
        </TooltipButton>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom in"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => applyZoom(zoom + ZOOM_STEP * 2)}
        >
          <ZoomInIcon />
        </Button>
      </div>
    </>
  );
}

/**
 * Provides a single shared full-screen image viewer for the whole app. Any
 * image wired with {@link useImageZoomProps} opens here. Built on the Radix
 * Dialog primitive, so Escape closes it for free; an explicit "x" button and a
 * click on the empty stage around the image give the other two close
 * affordances.
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
  const open = useCallback((img: LightboxImage) => {
    setImage(img);
    setOpening(img);
    setImages([]);
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
      if (!next) return;
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
    [images],
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
              "fixed inset-0 z-[60] bg-black/80 duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
              "data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
              "motion-reduce:animate-none motion-reduce:transition-none",
            )}
          />
          {/* Full-screen stage (Slack-style): the image sits centered on the
              dark backdrop and can zoom to fill the whole viewport, clipped to
              the screen rather than to a small card. */}
          <DialogPrimitive.Content
            className={cn(
              "fixed inset-0 z-[60] outline-none",
              "duration-150 ease-[cubic-bezier(0.16,1,0.3,1)]",
              "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95",
              "data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
              "motion-reduce:animate-none motion-reduce:transition-none",
            )}
            // The image carries its own description; the title is for a11y only.
            aria-describedby={undefined}
            // The stage fills the viewport, so no click is ever "outside" it
            // as far as Radix is concerned; dismissing on a click around the
            // image is the stage's own handler, which can tell a click on the
            // image or a finished pan from a real one.
            onInteractOutside={(e) => e.preventDefault()}
            onKeyDown={(event) => {
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
              />
            )}
            {images.length > 1 && (
              <>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Previous image"
                  disabled={selected === 0}
                  className="absolute top-1/2 left-3 bg-background/80"
                  onClick={() => navigate(-1)}
                >
                  <ChevronLeftIcon />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Next image"
                  disabled={selected === images.length - 1}
                  className="absolute top-1/2 right-3 bg-background/80"
                  onClick={() => navigate(1)}
                >
                  <ChevronRightIcon />
                </Button>
                <div
                  className="absolute inset-x-3 bottom-3 flex flex-col items-center gap-1"
                  style={{ paddingBottom: "var(--omnigent-safe-bottom, 0px)" }}
                >
                  <p aria-live="polite" className="text-xs text-white">
                    {selected + 1} / {images.length}
                  </p>
                  <div
                    role="group"
                    aria-label="Chat images"
                    className="flex max-w-full gap-1 overflow-x-auto p-1"
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
                  </div>
                </div>
              </>
            )}
            {historyState === "loading" && (
              <p role="status" className="absolute bottom-16 left-3 text-xs text-white">
                Loading chat images…
              </p>
            )}
            {historyState === "error" && (
              <Button
                type="button"
                variant="secondary"
                className="absolute bottom-16 left-3"
                onClick={() => setRetry((count) => count + 1)}
              >
                Retry image history
              </Button>
            )}
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Download image"
              className="absolute left-3 bg-background/70 hover:bg-background/90"
              style={{ top: "calc(0.75rem + var(--omnigent-safe-top, 0px))" }}
              onClick={() => void downloadImage()}
            >
              <DownloadIcon />
            </Button>
            <DialogPrimitive.Close asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                // Offset by the top safe-area inset so the button clears the
                // status bar / notch on native shells and stays tappable.
                style={{
                  top: "calc(0.75rem + var(--omnigent-safe-top, 0px))",
                  right: "calc(0.75rem + var(--omnigent-safe-right, 0px))",
                }}
                className="absolute bg-background/70 hover:bg-background/90"
              >
                <XIcon />
                <span className="sr-only">Close</span>
              </Button>
            </DialogPrimitive.Close>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </LightboxContext.Provider>
  );
}
