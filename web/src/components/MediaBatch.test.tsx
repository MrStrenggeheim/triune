// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  groupAdjacentMedia,
  isVisualAttachment,
  MediaBatchItems,
  mediaPreviewSize,
  remarkMediaBatches,
} from "./MediaBatch";
import { InlineImage } from "./SessionImage";

afterEach(cleanup);

it("groups only adjacent visual items without crossing intervening prose or files", () => {
  const items = [
    "first.png",
    "second.svg",
    "intervening text",
    "third.webp",
    "fourth.png",
    "notes.txt",
    "last.png",
  ];
  expect(groupAdjacentMedia(items, (item) => isVisualAttachment({ filename: item }))).toEqual([
    ["first.png", "second.svg"],
    ["intervening text"],
    ["third.webp", "fourth.png"],
    ["notes.txt"],
    ["last.png"],
  ]);
});

it("renders shared 256px stages and proportional widths while retaining tiny original pixels", () => {
  const images = [
    { filename: "landscape.png", width: 1600, height: 800 },
    { filename: "portrait.png", width: 600, height: 1200 },
    { filename: "tiny.png", width: 2, height: 1 },
  ];
  render(
    <MediaBatchItems
      items={images}
      renderItem={(image) => (
        <InlineImage
          key={image.filename}
          src={`data:image/png;base64,${image.filename}`}
          alt={image.filename}
        />
      )}
    />,
  );
  const row = screen.getByRole("group", { name: "Media previews" });
  expect(row).toHaveClass("flex-nowrap", "overflow-x-auto");
  for (const image of images) {
    const img = screen.getByRole("img", { name: image.filename });
    Object.defineProperties(img, {
      naturalWidth: { value: image.width },
      naturalHeight: { value: image.height },
    });
    fireEvent.load(img);
    expect(img.parentElement?.parentElement).toHaveStyle({
      width: `${(image.width / image.height) * 256}px`,
      height: "256px",
    });
  }
  expect(mediaPreviewSize({ width: 2, height: 1 }, false)).toEqual({ width: 2, height: 1 });
  expect(screen.getByRole("img", { name: "tiny.png" })).toHaveStyle({ width: "2px" });
});

it("joins adjacent image paragraphs without crossing text or altering image order", () => {
  const image = (url: string) => ({ type: "paragraph", children: [{ type: "image", url }] });
  const text = { type: "paragraph", children: [{ type: "text", value: "Boundary" }] };
  const first = image("one");
  const tree = { type: "root", children: [first, image("two"), text, image("three")] };
  remarkMediaBatches()(tree);
  expect(tree.children).toHaveLength(3);
  expect(first.children.filter((node) => node.type === "image").map((node) => node.url)).toEqual([
    "one",
    "two",
  ]);
  expect(tree.children[1]).toBe(text);
});
