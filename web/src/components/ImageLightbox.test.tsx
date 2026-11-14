// Modified for Triune.
// Tests for the shared image lightbox: a ZoomableImage renders a button around
// an <img>; activating it opens a full-screen Dialog showing the same source,
// which closes via Escape, the "x" button, or a click on the empty stage
// around the image.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// getEmbedRoot decides the Radix portal container; null → portal to body.
vi.mock("@/lib/host", () => ({
  getEmbedRoot: () => null,
}));

import { fitImagePreviewSize, ImageLightboxProvider, ZoomableImage } from "./ImageLightbox";

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

describe("dismissing the lightbox by clicking outside the image", () => {
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

  it("closes when the click lands on the stage, not the image", () => {
    const { stage } = openPreview();
    fireEvent.click(stage);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays open when the click lands on the image itself", () => {
    const { previewImg } = openPreview();
    fireEvent.click(previewImg);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("stays open when a toolbar button is clicked", () => {
    openPreview();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes on a stage click while zoomed in", () => {
    const { stage } = openPreview();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(stage);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("stays open when a pan drag ends on the stage", () => {
    // Panning a zoomed image releases the pointer over the stage, which the
    // browser then reports as a click there. Dismissing on it would close the
    // preview every time someone repositions the image.
    const { stage } = openPreview();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 180, clientY: 140 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 180, clientY: 140 });
    fireEvent.click(stage);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes on a plain click that follows a pan", () => {
    // The drag suppression lasts for that gesture only.
    const { stage } = openPreview();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(stage, { pointerId: 1, clientX: 180, clientY: 140 });
    fireEvent.pointerUp(stage, { pointerId: 1, clientX: 180, clientY: 140 });
    fireEvent.click(stage);

    fireEvent.pointerDown(stage, { pointerId: 2, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(stage, { pointerId: 2, clientX: 50, clientY: 50 });
    fireEvent.click(stage);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
