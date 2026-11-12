// Modified for Triune.
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import {
  FILE_ANNOTATION_EVENT,
  FileSelectionMenu,
  FileSelectionScope,
  type FileAnnotation,
} from "./FileSelectionMenu";

const source = { conversationId: "chat-a", path: "notes ü.md", workspaceRoot: "/original" };

function renderMenu(options: { scoped?: boolean; text?: string; x?: number; y?: number } = {}) {
  const comment = vi.fn();
  const close = vi.fn();
  const getText = vi.fn(() => options.text ?? "selected text");
  const menu = (
    <FileSelectionMenu
      x={options.x ?? 100}
      y={options.y ?? 100}
      getText={getText}
      onComment={comment}
      onClose={close}
    />
  );
  const view = render(
    options.scoped === false ? (
      menu
    ) : (
      <FileSelectionScope value={source}>{menu}</FileSelectionScope>
    ),
  );
  return { ...view, comment, close, getText };
}

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("dispatches the originating file scope only when Ask in chat is activated", () => {
  const dispatch = vi.spyOn(window, "dispatchEvent");
  const { comment, close } = renderMenu();
  expect(dispatch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: "Ask in chat" }));
  expect(comment).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
  expect(dispatch).toHaveBeenCalledOnce();
  const event = dispatch.mock.calls[0][0] as CustomEvent<FileAnnotation>;
  expect(event.type).toBe(FILE_ANNOTATION_EVENT);
  expect(event.detail).toEqual({ ...source, text: "selected text" });
});

it("uses the nearest source scope including a null workspace", () => {
  const dispatch = vi.spyOn(window, "dispatchEvent");
  const nested = { conversationId: "chat-b", path: "other.txt", workspaceRoot: null };
  render(
    <FileSelectionScope value={source}>
      <FileSelectionScope value={nested}>
        <FileSelectionMenu
          x={20}
          y={20}
          getText={() => "other selection"}
          onComment={vi.fn()}
          onClose={vi.fn()}
        />
      </FileSelectionScope>
    </FileSelectionScope>,
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Ask in chat" }));
  expect((dispatch.mock.calls[0][0] as CustomEvent<FileAnnotation>).detail).toEqual({
    ...nested,
    text: "other selection",
  });
});

it("keeps commenting available without a source and never emits an annotation for comments", () => {
  const dispatch = vi.spyOn(window, "dispatchEvent");
  const { comment, close } = renderMenu({ scoped: false });
  expect(screen.queryByRole("menuitem", { name: "Ask in chat" })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "Add comment" }));
  expect(comment).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(dispatch).not.toHaveBeenCalled();
});

it.each(["", " \n\t"])("does not emit an annotation for an empty selection (%j)", (text) => {
  const dispatch = vi.spyOn(window, "dispatchEvent");
  const { close } = renderMenu({ text });
  fireEvent.click(screen.getByRole("menuitem", { name: "Ask in chat" }));
  expect(dispatch).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it.each(["mouse", "touch"])("preserves selected text during %s activation", (pointerType) => {
  const dispatch = vi.spyOn(window, "dispatchEvent");
  const { getText, close } = renderMenu();
  const text = document.createTextNode("keep this selection");
  document.body.append(text);
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(text);
  selection.addRange(range);
  getText.mockImplementation(() => selection.toString());
  const ask = screen.getByRole("menuitem", { name: "Ask in chat" });
  const pointerDown = createEvent.pointerDown(ask, { pointerType, cancelable: true });
  Object.defineProperty(pointerDown, "pointerType", { value: pointerType });
  fireEvent(ask, pointerDown);
  expect(pointerDown.defaultPrevented).toBe(true);
  expect(fireEvent.mouseDown(ask)).toBe(false);
  expect(selection.toString()).toBe("keep this selection");
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(ask);
  expect((dispatch.mock.calls[0][0] as CustomEvent<FileAnnotation>).detail.text).toBe(
    "keep this selection",
  );
  text.remove();
});

it("supports Tab entry, arrow wrapping, Home/End and keyboard activation", async () => {
  const user = userEvent.setup();
  const { comment } = renderMenu();
  const add = screen.getByRole("menuitem", { name: "Add comment" });
  const ask = screen.getByRole("menuitem", { name: "Ask in chat" });
  const quote = screen.getByRole("menuitem", { name: "Send to…" });
  await user.tab();
  expect(document.activeElement).toBe(add);
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(ask);
  expect(ask.tabIndex).toBe(0);
  expect(add.tabIndex).toBe(-1);
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(quote);
  await user.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(add);
  await user.keyboard("{ArrowUp}");
  expect(document.activeElement).toBe(quote);
  await user.keyboard("{ArrowLeft}{End}");
  expect(document.activeElement).toBe(quote);
  await user.keyboard("{Home}{Enter}");
  expect(comment).toHaveBeenCalledOnce();
});

it("dismisses with Escape while editor focus remains outside the menu and cleans up listeners", () => {
  const { close, unmount } = renderMenu();
  const escape = createEvent.keyDown(document.body, { key: "Escape", cancelable: true });
  fireEvent(document.body, escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(close).toHaveBeenCalledOnce();
  unmount();
  fireEvent.keyDown(document.body, { key: "Escape" });
  fireEvent.pointerDown(document.body);
  expect(close).toHaveBeenCalledOnce();
});

it("dismisses on an outside pointer press", () => {
  const { close } = renderMenu();
  fireEvent.pointerDown(document.body);
  expect(close).toHaveBeenCalledOnce();
});

it("constrains the measured menu to the visible viewport and repositions on resize", () => {
  const viewport = Object.assign(new EventTarget(), {
    offsetLeft: 20,
    offsetTop: 30,
    width: 200,
    height: 120,
  });
  vi.stubGlobal("visualViewport", viewport);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 160, 60),
  );
  renderMenu({ x: 10000, y: 10000 });
  const menu = screen.getByRole("menu");
  expect(menu.style.left).toBe("52px");
  expect(menu.style.top).toBe("82px");
  expect(menu.style.maxWidth).toBe("184px");
  expect(menu.style.maxHeight).toBe("104px");
  viewport.width = 180;
  viewport.dispatchEvent(new Event("resize"));
  expect(menu.style.left).toBe("32px");
});

it("keeps a menu near the upper-left edge inside the viewport", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 260, 36),
  );
  renderMenu({ x: -100, y: -100 });
  const menu = screen.getByRole("menu");
  expect(menu.style.left).toBe("8px");
  expect(menu.style.top).toBe("8px");
});

it("positions the measured menu immediately above its selection anchor", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 260, 36),
  );
  renderMenu({ x: 120, y: 194 });
  const menu = screen.getByRole("menu");
  expect(menu.style.left).toBe("120px");
  expect(menu.style.top).toBe("158px");
  expect(menu).toHaveAttribute("data-text-selection-menu");
  expect(menu).toHaveAttribute("data-file-selection-menu");
});

it("offers an explicit chat choice instead of a no-op comment for an unowned preview", () => {
  const choose = vi.fn();
  const comment = vi.fn();
  render(
    <FileSelectionScope
      value={{ ...source, conversationId: "", workspaceId: "workspace-a", hostId: "host-a" }}
      onChooseChat={choose}
    >
      <FileSelectionScope value={{ ...source, conversationId: "" }}>
        <FileSelectionMenu
          x={20}
          y={20}
          getText={() => "selected"}
          onComment={comment}
          onClose={vi.fn()}
        />
      </FileSelectionScope>
    </FileSelectionScope>,
  );
  expect(screen.queryByRole("menuitem", { name: "Add comment" })).not.toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "Ask in chat" })).not.toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Send to…" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: "Choose chat" }));
  expect(choose).toHaveBeenCalledOnce();
  expect(comment).toHaveBeenCalledOnce();
  expect(comment.mock.invocationCallOrder[0]).toBeLessThan(choose.mock.invocationCallOrder[0]);
});

it("retains captured machine provenance through the code viewer's matching nested scope", () => {
  const dispatch = vi.spyOn(window, "dispatchEvent");
  render(
    <FileSelectionScope value={{ ...source, workspaceId: "workspace-a", hostId: "host-a" }}>
      <FileSelectionScope value={source}>
        <FileSelectionMenu
          x={20}
          y={20}
          getText={() => "selected"}
          onComment={vi.fn()}
          onClose={vi.fn()}
        />
      </FileSelectionScope>
    </FileSelectionScope>,
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Ask in chat" }));
  expect((dispatch.mock.calls[0][0] as CustomEvent<FileAnnotation>).detail).toMatchObject({
    conversationId: "chat-a",
    workspaceId: "workspace-a",
    hostId: "host-a",
  });
});
