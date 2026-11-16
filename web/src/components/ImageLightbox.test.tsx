// Modified for Triune.
// Tests for the shared image lightbox: a ZoomableImage renders a button around
// an <img>; activating it opens a full-screen Dialog showing the same source,
// which closes via Escape, the "x" button or a vertical swipe at fit.

import { act, cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// getEmbedRoot decides the Radix portal container; null → portal to body.
vi.mock("@/lib/host", () => ({
  getEmbedRoot: () => null,
}));

import { fitImagePreviewSize, ImageLightboxProvider, ZoomableImage } from "./ImageLightbox";
import * as GalleryScope from "./ChatImageGallery";

afterEach(cleanup);

describe("inline image fitting", () => {
  it.each([
    [1600, 800, 640, 512, 256],
    [600, 1200, 640, 128, 256],
    [400, 100, 240, 240, 60],
    [120, 60, 640, 120, 60],
    [800, 600, 180, 180, 135],
  ])(
    "fits %sx%s within %spx without changing ratio",
    (width, height, maxWidth, expectedWidth, expectedHeight) => {
      const fitted = fitImagePreviewSize(width, height, maxWidth)!;
      expect(fitted.width).toBeCloseTo(expectedWidth);
      expect(fitted.height).toBeCloseTo(expectedHeight);
      expect(fitted.width / fitted.height).toBeCloseTo(width / height);
    },
  );

  it.each([
    [0, 100],
    [100, 0],
    [-1, 100],
    [Infinity, 100],
    [100, NaN],
  ])("ignores undecoded or invalid dimensions %sx%s", (width, height) => {
    expect(fitImagePreviewSize(width, height)).toBeUndefined();
  });
});

function renderWithProvider() {
  return render(
    <ImageLightboxProvider>
      <ZoomableImage src="/pic.png" alt="diagram" className="size-10" />
    </ImageLightboxProvider>,
  );
}

describe("ZoomableImage + ImageLightboxProvider", () => {
  it("renders a button wrapping an image (keeps the img role/name)", () => {
    renderWithProvider();
    expect(screen.getByRole("button", { name: "Zoom image: diagram" })).toBeInTheDocument();
    // The inner <img> keeps its image role and alt-derived name.
    const img = screen.getByRole("img", { name: "diagram" });
    expect(img).toHaveAttribute("src", "/pic.png");
    expect(img).toHaveClass("size-10");
  });

  it("does not render a dialog until the image is activated", () => {
    renderWithProvider();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a dialog showing the full image on click", () => {
    renderWithProvider();
    fireEvent.click(screen.getByRole("button", { name: "Zoom image: diagram" }));
    const dialog = screen.getByRole("dialog");
    // The dialog hosts its own copy of the image at the same source.
    const dialogImg = screen.getAllByRole("img", { name: "diagram" }).at(-1)!;
    expect(dialog).toContainElement(dialogImg);
    expect(dialogImg).toHaveAttribute("src", "/pic.png");
  });

  it("closes the dialog with Escape", () => {
    renderWithProvider();
    fireEvent.click(screen.getByRole("button", { name: "Zoom image: diagram" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the dialog with the x button", () => {
    renderWithProvider();
    fireEvent.click(screen.getByRole("button", { name: "Zoom image: diagram" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("zooms in and out via the toolbar, updating the scale and label", () => {
    renderWithProvider();
    fireEvent.click(screen.getByRole("button", { name: "Zoom image: diagram" }));

    // Starts at fit (100%); zoom-out disabled, the preview img is unscaled.
    const previewImg = screen.getAllByRole("img", { name: "diagram" }).at(-1)!;
    expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("100%");
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeDisabled();
    expect(previewImg).toHaveStyle({ transform: "translate(0px, 0px) scale(1)" });

    // One zoom-in step is +0.5 → 150%, and the transform scales up.
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("150%");
    expect(screen.getByRole("button", { name: "Zoom out" })).toBeEnabled();
    expect(previewImg).toHaveStyle({ transform: "translate(0px, 0px) scale(1.5)" });

    // The percentage acts as a reset back to fit.
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("100%");
    expect(previewImg).toHaveStyle({ transform: "translate(0px, 0px) scale(1)" });
  });
});

describe("content overlay visibility and gesture isolation", () => {
  /** Open the preview and return its image and the stage around it. */
  function openPreview() {
    renderWithProvider();
    fireEvent.click(screen.getByRole("button", { name: "Zoom image: diagram" }));
    const previewImg = screen.getAllByRole("img", { name: "diagram" }).at(-1)!;
    const stage = previewImg.parentElement!;
    // jsdom has no pointer capture; panning calls it on the stage.
    stage.setPointerCapture = vi.fn();
    stage.releasePointerCapture = vi.fn();
    return { previewImg, stage };
  }

  it("toggles controls on a stage click without closing", () => {
    const { stage } = openPreview();
    fireEvent.click(stage);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.click(stage);
    expect(screen.getByRole("button", { name: "Close" })).toBeVisible();
  });

  it("toggles the same controls when clicking image content", () => {
    const { previewImg } = openPreview();
    fireEvent.click(previewImg);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  it("stays open when a toolbar button is clicked", () => {
    openPreview();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("toggles controls on a plain click while zoomed in", () => {
    const { stage } = openPreview();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(stage);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("stays open when a pan drag ends on the stage", () => {
    // Panning a zoomed image releases the pointer over the stage, which the
    // browser then reports as a click there. Dismissing on it would close the
    // preview every time someone repositions the image.
    const { stage } = openPreview();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    fireEvent.pointerDown(stage, { isPrimary: true, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 180, clientY: 140 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 180, clientY: 140 });
    fireEvent.click(stage);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("toggles only on the plain click that follows a pan", () => {
    // The drag suppression lasts for that gesture only.
    const { stage } = openPreview();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    fireEvent.pointerDown(stage, { isPrimary: true, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 180, clientY: 140 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 180, clientY: 140 });
    fireEvent.click(stage);

    fireEvent.pointerDown(stage, { isPrimary: true, pointerId: 2, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(stage, { pointerId: 2, clientX: 50, clientY: 50 });
    fireEvent.click(stage);

    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

// Two indexed images have no mounted transcript preview in these cases.
const galleryImages = ["Old history", "Current screenshot", "Later output"].map((alt, index) => ({
  id: `message-${index}:0`,
  itemId: `message-${index}`,
  sessionId: "chat",
  alt,
  source: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><text y="12">${index}</text></svg>`)}`,
}));

describe("whole-chat lightbox gallery", () => {
  afterEach(() => vi.restoreAllMocks());
  async function openGallery() {
    vi.spyOn(GalleryScope, "useChatImageGallery").mockReturnValue({
      conversationId: "chat",
      load: async () => galleryImages,
    });
    render(
      <ImageLightboxProvider>
        <ZoomableImage
          src="blob:current-preview"
          alt="Current screenshot"
          gallerySource={galleryImages[1].source}
          galleryItemId="message-1"
        />
      </ImageLightboxProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Zoom image: Current screenshot" }));
    await screen.findByRole("button", { name: "Previous image" });
    return screen.getByRole("dialog");
  }
  it("opens the clicked occurrence and navigates history via arrows, keys and thumbnails", async () => {
    const dialog = await openGallery();
    expect(within(dialog).getByText("2 / 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
    expect(within(dialog).getByRole("img", { name: "Old history" })).toHaveAttribute(
      "src",
      galleryImages[0].source,
    );
    expect(screen.getByRole("button", { name: "Previous image" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    fireEvent.click(screen.getByRole("button", { name: "View image 3: Later output" }));
    expect(within(dialog).getByRole("img", { name: "Later output" })).toHaveAttribute(
      "src",
      galleryImages[2].source,
    );
    expect(screen.getByRole("button", { name: "Next image" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "View image 3: Later output" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });
  it("absorbs disabled endpoint controls and isolates enabled navigation from stage gestures", async () => {
    const dialog = await openGallery();
    const stageClick = vi.fn();
    const stage = screen.getByTestId("lightbox-stage");
    stage.addEventListener("click", stageClick);
    fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
    const previous = screen.getByRole("button", { name: "Previous image" });
    expect(previous).toBeDisabled();
    expect(previous).toHaveClass("disabled:pointer-events-auto");
    fireEvent.click(previous);
    fireEvent.click(previous);
    expect(within(dialog).getByText("1 / 3")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    const next = screen.getByRole("button", { name: "Next image" });
    expect(next).toBeDisabled();
    fireEvent.click(next);
    expect(within(dialog).getByText("3 / 3")).toBeVisible();
    expect(stageClick).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close" })).toBeVisible();
  });

  it("preserves hidden controls across selection and reveals them from keyboard navigation", async () => {
    const dialog = await openGallery();
    fireEvent.click(screen.getByTestId("lightbox-stage"));
    expect(document.activeElement).toBe(dialog);
    expect(screen.queryByRole("button", { name: "Next image" })).toBeNull();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(screen.getByText("3 / 3")).toBeVisible();
    fireEvent.click(screen.getByTestId("lightbox-stage"));
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close" })).toBeVisible();
    fireEvent.click(screen.getByTestId("lightbox-stage"));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps chrome hidden through swipe selection and its release click", async () => {
    await openGallery();
    const stage = screen.getByTestId("lightbox-stage");
    fireEvent.click(stage);
    fireEvent.pointerDown(stage, { isPrimary: true, pointerId: 1, clientX: 200, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByTestId("lightbox-stage"));
    expect(screen.getByRole("status")).toHaveTextContent("Image 3 of 3");
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close" })).toBeVisible();
  });

  it("keeps double-click zoom independent of chrome and roll wheel independent of image zoom", async () => {
    await openGallery();
    const stage = screen.getByTestId("lightbox-stage");
    expect(stage).toHaveStyle({ cursor: "default" });
    fireEvent.click(stage, { detail: 1 });
    fireEvent.click(stage, { detail: 2 });
    fireEvent.doubleClick(stage);
    expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("200%");
    const roll = screen.getByRole("group", { name: "Chat images" });
    expect(fireEvent.wheel(roll, { deltaY: 40 })).toBe(false);
    expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("200%");
    fireEvent.wheel(stage, { deltaY: -40 });
    expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("250%");
  });

  it("holds the opening stage/source through delayed history, skeletons, failure and retry", async () => {
    let resolve!: (images: typeof galleryImages) => void;
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(
        () =>
          new Promise<typeof galleryImages>((done) => {
            resolve = done;
          }),
      );
    vi.spyOn(GalleryScope, "useChatImageGallery").mockReturnValue({ conversationId: "chat", load });
    render(
      <ImageLightboxProvider>
        <ZoomableImage
          src="blob:current-preview"
          alt="Current screenshot"
          gallerySource={galleryImages[1].source}
        />
      </ImageLightboxProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Zoom image: Current screenshot" }));
    const stage = screen.getByTestId("lightbox-stage");
    const image = within(screen.getByRole("dialog")).getByRole("img", {
      name: "Current screenshot",
    });
    expect(stage).toHaveClass("inset-0");
    expect(stage.style.bottom).toBe("");
    fireEvent.click(await screen.findByRole("button", { name: "Retry image history" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading chat images");
    expect(screen.getByRole("status")).toHaveClass("sr-only");
    await act(async () => resolve(galleryImages));
    expect(screen.getByTestId("lightbox-stage")).toBe(stage);
    expect(
      within(screen.getByRole("dialog")).getByRole("img", { name: "Current screenshot" }),
    ).toBe(image);
    expect(image).toHaveAttribute("src", "blob:current-preview");
    expect(stage.style.bottom).toBe("");
    const thumbnail = screen.getByRole("button", { name: "View image 2: Current screenshot" });
    const thumbnailImage = thumbnail.querySelector("img")!;
    let decode!: () => void;
    thumbnailImage.decode = () =>
      new Promise<void>((done) => {
        decode = done;
      });
    expect(thumbnail).toHaveAttribute("aria-busy", "true");
    fireEvent.load(thumbnailImage);
    expect(thumbnail).toHaveAttribute("aria-busy", "true");
    await act(async () => decode());
    expect(thumbnail).toHaveAttribute("aria-busy", "false");
    expect(thumbnailImage).not.toHaveClass("opacity-0");
    expect(thumbnail.querySelector("[data-gallery-thumbnail-visual]")).toHaveClass("scale-110");
  });

  it("loads remote main images and thumbnails directly without the authenticated session loader", async () => {
    const sources = await import("./SessionImage");
    const authenticatedImageLoader = vi.spyOn(sources, "loadSessionImageSource");
    const asset = "https://github.com/user-attachments/assets/381e47c8-e3f1-4c3e-9b3d-aac5cfb3557b";
    vi.spyOn(GalleryScope, "useChatImageGallery").mockReturnValue({
      conversationId: "chat",
      load: async () => [
        galleryImages[1],
        {
          id: "remote:0",
          itemId: "remote",
          sessionId: "chat",
          source: asset,
          alt: "Remote screenshot",
        },
      ],
    });
    render(
      <ImageLightboxProvider>
        <ZoomableImage
          src={galleryImages[1].source}
          alt="Current screenshot"
          gallerySource={galleryImages[1].source}
        />
      </ImageLightboxProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Zoom image: Current screenshot" }));
    fireEvent.click(await screen.findByRole("button", { name: "Next image" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getByRole("img", { name: "Remote screenshot" }),
      ).toHaveAttribute("src", asset),
    );
    const remoteImages = screen.getByRole("dialog").querySelectorAll(`img[src="${asset}"]`);
    expect(remoteImages).toHaveLength(2);
    for (const image of remoteImages)
      expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(authenticatedImageLoader).not.toHaveBeenCalled();
  });
  it("swipes only at fit and suppresses the release click across image changes", async () => {
    await openGallery();
    const stage = screen.getByTestId("lightbox-stage");
    stage.setPointerCapture = vi.fn();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.pointerDown(stage, { isPrimary: true, pointerId: 1, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.click(stage);
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    fireEvent.pointerDown(stage, { isPrimary: true, pointerId: 2, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.click(screen.getByTestId("lightbox-stage"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
  });
  it("dismisses on a vertical swipe at fit", async () => {
    await openGallery();
    const stage = screen.getByTestId("lightbox-stage");
    fireEvent.pointerDown(stage, { isPrimary: true, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 110, clientY: 200 });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
