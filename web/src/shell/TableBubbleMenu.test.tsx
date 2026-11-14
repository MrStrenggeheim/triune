// Modified for Triune.
// Tests for the <TableHandles> React component (TableBubbleMenu.tsx) — the
// hover-revealed row/column grips and the menus they open. The pure
// position/move helpers (freshCellPos, moveRowToIndex, …) are covered in
// tableActions.test.ts; this file exercises the *component wiring*:
//
//   - a mousemove over a cell portals the row + column grips into <body>
//     (or the embed root when embedded),
//   - clicking a grip opens its dropdown menu,
//   - clicking each menu item runs the matching TipTap command against the
//     cell the grip belongs to (Insert row above/below, Delete row; Insert
//     column before/after, Delete column),
//   - right-clicking a cell opens the "Delete table" context menu.
//
// A real headless TipTap Editor (with a table) backs the component so the
// assertions are end-to-end on the resulting table structure — each test
// fails if the corresponding command is mis-wired. The editor is mounted into
// a real container and the component's <body> portals are queried directly.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { StarterKit } from "@tiptap/starter-kit";
import { setEmbedRoot } from "@/lib/host";
import { TableHandles } from "./TableBubbleMenu";

/** Minimal 3×3 table: one header row + two body rows. */
const TABLE_3X3 = `
  <table>
    <tr><th>H1</th><th>H2</th><th>H3</th></tr>
    <tr><td>R2C1</td><td>R2C2</td><td>R2C3</td></tr>
    <tr><td>R3C1</td><td>R3C2</td><td>R3C3</td></tr>
  </table>
`;

let editor: Editor;

function makeEditor(content = TABLE_3X3): Editor {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: [
      StarterKit,
      Table.configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
    ],
    content,
  });
}

function rows(): HTMLTableRowElement[] {
  return Array.from(editor.view.dom.querySelectorAll("tr")) as HTMLTableRowElement[];
}

function rowText(row: HTMLTableRowElement): string[] {
  return Array.from(row.cells).map((c) => c.textContent ?? "");
}

function allCellText(): string[] {
  return rows().flatMap(rowText);
}

function renderHandles(scrollContainer?: HTMLDivElement) {
  const ref = createRef<HTMLDivElement>();
  if (scrollContainer) ref.current = scrollContainer;
  return render(<TableHandles editor={editor} scrollContainerRef={ref} />);
}

/** Hovers the cell at (rowIndex, colIndex), revealing the grips. */
function hoverCell(rowIndex: number, colIndex: number): HTMLTableCellElement {
  const cell = rows()[rowIndex].cells[colIndex];
  // mousemove must bubble from a real cell so the component's closest()/indexOf
  // logic resolves the row + column indices.
  fireEvent.mouseMove(cell, { bubbles: true });
  return cell;
}

/** Opens the row grip menu over (rowIndex, colIndex) and returns its items. */
function openRowMenu(rowIndex: number, colIndex = 0): HTMLElement {
  hoverCell(rowIndex, colIndex);
  fireEvent.click(screen.getByRole("button", { name: "Row options" }));
  return screen.getByText("Delete row").closest("[data-table-handle-menu]") as HTMLElement;
}

/** Opens the column grip menu over (rowIndex, colIndex) and returns its items. */
function openColMenu(rowIndex: number, colIndex: number): HTMLElement {
  hoverCell(rowIndex, colIndex);
  fireEvent.click(screen.getByRole("button", { name: "Column options" }));
  return screen.getByText("Delete column").closest("[data-table-handle-menu]") as HTMLElement;
}

beforeEach(() => {
  editor = makeEditor();
});

afterEach(() => {
  cleanup();
  editor.destroy();
  setEmbedRoot(null);
});

describe("TableHandles — grip visibility", () => {
  it("reveals the row and column grips when a table cell is hovered", () => {
    // WHY: the grips are portaled in only on hover; before any mousemove the
    // toolbar must be absent, and a mousemove over a cell must reveal both.
    renderHandles();
    expect(screen.queryByRole("button", { name: "Row options" })).toBeNull();
    hoverCell(1, 1);
    expect(screen.getByRole("button", { name: "Row options" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Column options" })).toBeInTheDocument();
  });

  it("opens the row menu on grip click and the column menu on its grip click", () => {
    // WHY: clicking each grip must open exactly its own dropdown with the
    // expected insert/delete items.
    renderHandles();
    const rowMenu = openRowMenu(1);
    expect(within(rowMenu).getByText("Insert row above")).toBeInTheDocument();
    expect(within(rowMenu).getByText("Insert row below")).toBeInTheDocument();
    expect(within(rowMenu).getByText("Delete row")).toBeInTheDocument();

    const colMenu = openColMenu(1, 1);
    expect(within(colMenu).getByText("Insert column before")).toBeInTheDocument();
    expect(within(colMenu).getByText("Insert column after")).toBeInTheDocument();
    expect(within(colMenu).getByText("Delete column")).toBeInTheDocument();
  });
});

describe("TableHandles — row menu commands", () => {
  it("Insert row above adds an empty row above the gripped row", () => {
    // WHY: the menu must run addRowBefore against the gripped row — inserting
    // an empty row at that index and shifting the original down.
    renderHandles();
    const menu = openRowMenu(1);
    fireEvent.click(within(menu).getByText("Insert row above"));
    const r = rows();
    expect(r).toHaveLength(4);
    expect(rowText(r[1]).every((t) => t === "")).toBe(true);
    expect(rowText(r[2])).toContain("R2C1");
  });

  it("Insert row below adds an empty row beneath the gripped row", () => {
    // WHY: addRowAfter on row 1 must drop a fresh row at index 2, pushing the
    // original row 2 (R3C1) down to index 3.
    renderHandles();
    const menu = openRowMenu(1);
    fireEvent.click(within(menu).getByText("Insert row below"));
    const r = rows();
    expect(r).toHaveLength(4);
    expect(rowText(r[2]).every((t) => t === "")).toBe(true);
    expect(rowText(r[3])).toContain("R3C1");
  });

  it("Delete row removes exactly the gripped row", () => {
    // WHY: deleteRow must drop the gripped row (R2…) and keep header + R3.
    renderHandles();
    const menu = openRowMenu(1);
    fireEvent.click(within(menu).getByText("Delete row"));
    expect(rows()).toHaveLength(2);
    expect(allCellText()).not.toContain("R2C1");
    expect(allCellText()).toContain("R3C1");
  });

  it("closes the menu after an item is chosen", () => {
    // WHY: selecting an item must dismiss the dropdown (onClose), not leave a
    // stale menu portal behind.
    renderHandles();
    const menu = openRowMenu(1);
    fireEvent.click(within(menu).getByText("Insert row above"));
    expect(screen.queryByText("Delete row")).toBeNull();
  });
});

describe("TableHandles — column menu commands", () => {
  it("Insert column before adds an empty column at the gripped column", () => {
    // WHY: addColumnBefore on column 1 must widen every row to 4 cells and put
    // a blank cell at index 1.
    renderHandles();
    const menu = openColMenu(0, 1);
    fireEvent.click(within(menu).getByText("Insert column before"));
    rows().forEach((r) => expect(r.cells).toHaveLength(4));
    expect(rows()[0].cells[1].textContent).toBe("");
  });

  it("Insert column after adds an empty column past the gripped column", () => {
    // WHY: addColumnAfter on column 1 widens to 4 cells with the blank at
    // index 2, leaving the original column-1 header (H2) in place.
    renderHandles();
    const menu = openColMenu(0, 1);
    fireEvent.click(within(menu).getByText("Insert column after"));
    rows().forEach((r) => expect(r.cells).toHaveLength(4));
    expect(rows()[0].cells[1].textContent).toBe("H2");
    expect(rows()[0].cells[2].textContent).toBe("");
  });

  it("Delete column removes exactly the gripped column", () => {
    // WHY: deleteColumn on column 1 must narrow every row to 2 cells and drop
    // the middle column's content (H2 / R2C2 / R3C2).
    renderHandles();
    const menu = openColMenu(0, 1);
    fireEvent.click(within(menu).getByText("Delete column"));
    rows().forEach((r) => expect(r.cells).toHaveLength(2));
    expect(allCellText()).not.toContain("H2");
    expect(allCellText()).not.toContain("R2C2");
  });
});

describe("TableHandles — context menu", () => {
  it("right-clicking a cell opens a Delete table item that removes the table", () => {
    // WHY: the cell contextmenu must surface a "Delete table" action whose
    // click runs deleteTable, leaving no <table> behind.
    renderHandles();
    fireEvent.contextMenu(rows()[1].cells[1], { bubbles: true, clientX: 10, clientY: 10 });
    const item = screen.getByText("Delete table");
    fireEvent.click(item);
    expect(editor.view.dom.querySelector("table")).toBeNull();
  });
});

describe("TableHandles — touch context menu", () => {
  const pointer = { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 30 };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    fireEvent.keyDown(document, { key: "Escape" });
    document.getSelection()?.removeAllRanges();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it.each([0, 1])(
    "opens the existing menu after a stationary hold on row %i without editing",
    (rowIndex) => {
      renderHandles();
      const cell = rows()[rowIndex].cells[1];
      const paragraph = cell.querySelector("p")!;
      const before = editor.getJSON();
      const selection = editor.state.selection.toJSON();
      expect(fireEvent.pointerDown(paragraph, pointer)).toBe(true);
      expect(fireEvent.pointerMove(paragraph, { ...pointer, clientX: 24 })).toBe(true);
      act(() => vi.advanceTimersByTime(499));
      expect(screen.queryByText("Delete table")).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByText("Delete table").closest("[data-table-handle-menu]")).toHaveStyle({
        top: "30px",
        left: "20px",
      });
      expect(editor.getJSON()).toEqual(before);
      expect(editor.state.selection.toJSON()).toEqual(selection);
      fireEvent.pointerUp(paragraph, pointer);
    },
  );

  it("discards the held release over a menu action, then lets a deliberate tap delete only its table", () => {
    editor.commands.setContent(TABLE_3X3 + TABLE_3X3.replace("H1", "Other H1"));
    renderHandles();
    const cell = rows()[4].cells[1];
    fireEvent.pointerDown(cell, pointer);
    act(() => vi.advanceTimersByTime(500));
    const action = screen.getByRole("button", { name: "Delete table" });
    expect(fireEvent.pointerUp(action, pointer)).toBe(false);
    fireEvent.click(action);
    expect(editor.view.dom.querySelectorAll("table")).toHaveLength(2);
    fireEvent.pointerDown(action, { ...pointer, pointerId: 2 });
    fireEvent.pointerUp(action, { ...pointer, pointerId: 2 });
    fireEvent.click(action);
    expect(editor.view.dom.querySelectorAll("table")).toHaveLength(1);
    expect(allCellText()).toEqual([
      "H1",
      "H2",
      "H3",
      "R2C1",
      "R2C2",
      "R2C3",
      "R3C1",
      "R3C2",
      "R3C3",
    ]);
  });

  it("keeps a short tap and subsequent typing in the cell available to the editor", () => {
    renderHandles();
    const cell = rows()[1].cells[1];
    editor.commands.setTextSelection(editor.view.posAtDOM(cell, 0) + 1);
    expect(fireEvent.pointerDown(cell, pointer)).toBe(true);
    act(() => vi.advanceTimersByTime(100));
    expect(fireEvent.pointerUp(cell, pointer)).toBe(true);
    editor.commands.insertContent("!");
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByText("Delete table")).toBeNull();
    expect(cell.textContent).toBe("!R2C2");
  });

  it("gives movement at 10px to native scrolling even if the finger returns", () => {
    renderHandles();
    const cell = rows()[1].cells[1];
    fireEvent.pointerDown(cell, pointer);
    expect(fireEvent.pointerMove(cell, { ...pointer, clientX: 30 })).toBe(true);
    act(() => vi.advanceTimersByTime(500));
    fireEvent.pointerMove(cell, pointer);
    expect(fireEvent.pointerUp(cell, pointer)).toBe(true);
    expect(screen.queryByText("Delete table")).toBeNull();
  });

  it.each(["pointercancel", "multitouch", "scroll", "unmount"])(
    "cancels a pending hold on %s",
    (reason) => {
      const scrollContainer = editor.view.dom.parentElement as HTMLDivElement;
      const handles = renderHandles(scrollContainer);
      const cell = rows()[1].cells[1];
      fireEvent.pointerDown(cell, pointer);
      if (reason === "pointercancel") fireEvent.pointerCancel(cell, pointer);
      if (reason === "multitouch") fireEvent.pointerDown(cell, { ...pointer, pointerId: 2 });
      if (reason === "scroll") fireEvent.scroll(scrollContainer);
      if (reason === "unmount") {
        handles.unmount();
        fireEvent.pointerDown(cell, pointer);
      }
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByText("Delete table")).toBeNull();
      fireEvent.pointerUp(cell, pointer);
    },
  );

  it("preserves native text selection instead of opening a menu", () => {
    renderHandles();
    const paragraph = rows()[1].cells[1].querySelector("p")!;
    fireEvent.pointerDown(paragraph, pointer);
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent(document, new Event("selectionchange"));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByText("Delete table")).toBeNull();
    expect(selection.toString()).toBe("R2C2");
    expect(fireEvent.pointerUp(paragraph, pointer)).toBe(true);
  });

  it("dismisses an opened menu when its editor scrolls", () => {
    const scrollContainer = editor.view.dom.parentElement as HTMLDivElement;
    renderHandles(scrollContainer);
    const cell = rows()[1].cells[1];
    fireEvent.pointerDown(cell, pointer);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByText("Delete table")).toBeInTheDocument();
    fireEvent.scroll(scrollContainer);
    expect(screen.queryByText("Delete table")).toBeNull();
    expect(fireEvent.pointerUp(cell, pointer)).toBe(false);
  });

  it.each(["input", "a", "resize", "outside"])("leaves %s interactions alone", (targetKind) => {
    renderHandles();
    const target = document.createElement(
      targetKind === "input" ? "input" : targetKind === "a" ? "a" : "span",
    );
    if (targetKind === "resize") target.className = "column-resize-handle";
    const parent = targetKind === "outside" ? editor.view.dom : rows()[1].cells[1];
    parent.append(target);
    expect(fireEvent.pointerDown(target, pointer)).toBe(true);
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByText("Delete table")).toBeNull();
    fireEvent.pointerUp(target, pointer);
    target.remove();
  });
});

describe("TableHandles — embedded portal target", () => {
  it("portals grips, menus and overlays into the embed root", () => {
    // WHY: managed CSS is scoped under the embed root; body-level portals
    // render unstyled, so the table controls become invisible and unusable.
    const embedRoot = document.createElement("div");
    document.body.appendChild(embedRoot);
    onTestFinished(() => embedRoot.remove());
    setEmbedRoot(embedRoot);
    renderHandles();
    // Any portal into <body> would add a direct child beyond these.
    const bodyChildren = Array.from(document.body.children);

    const rowMenu = openRowMenu(1);
    expect(embedRoot).toContainElement(screen.getByRole("button", { name: "Column options" }));
    expect(embedRoot).toContainElement(rowMenu);

    // Hovering the grip shows the selection overlay; dragging it shows the
    // ghost, target and drop-indicator overlays.
    const rowGrip = screen.getByRole("button", { name: "Row options" });
    expect(embedRoot).toContainElement(rowGrip);
    fireEvent.mouseEnter(rowGrip);
    fireEvent.mouseDown(rowGrip, { clientX: 0, clientY: 0 });
    fireEvent.mouseMove(document, { clientX: 0, clientY: 40 });
    expect(Array.from(document.body.children)).toEqual(bodyChildren);
    expect(embedRoot.childElementCount).toBeGreaterThan(3);
    fireEvent.mouseUp(document, { clientX: 0, clientY: 40 });

    fireEvent.contextMenu(rows()[1].cells[1], { bubbles: true, clientX: 10, clientY: 10 });
    expect(embedRoot).toContainElement(screen.getByText("Delete table"));
    expect(Array.from(document.body.children)).toEqual(bodyChildren);
  });
});
