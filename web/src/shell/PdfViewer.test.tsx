// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { useEffect, useRef, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FileContentResponse } from "@/hooks/useFileContent";

const { documentLoads, pageRenders, observe, disconnect } = vi.hoisted(() => {
  vi.stubGlobal("Worker", vi.fn());
  return { documentLoads: vi.fn(), pageRenders: vi.fn(), observe: vi.fn(), disconnect: vi.fn() };
});
vi.mock("@/hooks/usePermissions", () => ({ useCanEdit: () => true }));
vi.mock("./FileSelectionMenu", () => ({ FileSelectionMenu: () => null }));
vi.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: {} },
  Document: ({
    file,
    children,
    onLoadSuccess,
  }: {
    file: Blob;
    children: ReactNode;
    onLoadSuccess: (doc: { numPages: number }) => void;
  }) => {
    const load = useRef(onLoadSuccess);
    load.current = onLoadSuccess;
    useEffect(() => {
      documentLoads(file);
      load.current({ numPages: 2 });
    }, [file]);
    return <div data-testid="pdf-document">{children}</div>;
  },
  Page: (props: {
    pageNumber: number;
    renderMode: string;
    renderTextLayer: boolean;
    renderAnnotationLayer: boolean;
    onLoadSuccess: (page: { getViewport: () => { width: number; height: number } }) => void;
  }) => {
    const { pageNumber, onLoadSuccess } = props;
    const load = useRef(onLoadSuccess);
    load.current = onLoadSuccess;
    pageRenders(props);
    useEffect(() => {
      load.current({ getViewport: () => ({ width: 200, height: 300 }) });
    }, [pageNumber]);
    return <div data-testid={`pdf-page-${pageNumber}`} data-page-number={pageNumber} />;
  },
}));

import { PdfViewer } from "./PdfViewer";
import { encodePdfAnchor } from "./pdfCommentHelpers";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("defers a hidden PDF, cancels hidden page rendering and retains document, zoom and geometry across A/B/A", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = observe;
      disconnect = disconnect;
    },
  );
  const data: FileContentResponse = {
    object: "session.environment.filesystem.file_content",
    path: "notes.pdf",
    content_type: "application/pdf",
    encoding: "base64",
    content: "AAAA",
    bytes: 4,
    truncated: false,
  };
  const view = render(<PdfViewer data={data} conversationId="chat" active={false} />);
  expect(documentLoads).not.toHaveBeenCalled();
  expect(observe).not.toHaveBeenCalled();
  view.rerender(<PdfViewer data={data} conversationId="chat" active />);
  await waitFor(() => expect(screen.getByText("2 pages")).toBeInTheDocument());
  const document = screen.getByTestId("pdf-document");
  const page = screen.getByTestId("pdf-page-1");
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("125%");
  const layout = page.parentElement!;
  const height = layout.style.height;
  expect(height).toBe("300px");
  const selection = encodePdfAnchor(1, [], "selected comment");
  const scrollIntoView = vi.fn();
  page.scrollIntoView = scrollIntoView;
  view.rerender(<PdfViewer data={data} conversationId="chat" active activeSelection={selection} />);
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  view.rerender(
    <PdfViewer data={data} conversationId="chat" active={false} activeSelection={selection} />,
  );
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(pageRenders).toHaveBeenLastCalledWith(
    expect.objectContaining({
      renderMode: "none",
      renderTextLayer: false,
      renderAnnotationLayer: false,
    }),
  );
  expect(screen.getByTestId("pdf-page-1")).toBe(page);
  expect(page.parentElement).toBe(layout);
  expect(layout.style.height).toBe(height);
  view.rerender(<PdfViewer data={data} conversationId="chat" active activeSelection={selection} />);
  expect(scrollIntoView).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId("pdf-document")).toBe(document);
  expect(documentLoads).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveTextContent("125%");
  expect(observe).toHaveBeenCalledTimes(2);
  expect(pageRenders).toHaveBeenLastCalledWith(expect.objectContaining({ renderMode: "canvas" }));
});
