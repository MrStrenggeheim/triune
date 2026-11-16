import { useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import {
  useAcceptedConversationRoute,
  useConversationOwnerNavigation,
} from "./useAcceptedConversationRoute";

const onError = vi.fn();
afterEach(cleanup);
function RouteHarness({
  accept,
  onAccepted,
}: {
  accept: (id: string) => Promise<boolean>;
  onAccepted: (id: string) => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const skip = useRef<string | null>(null);
  const href = location.pathname + location.search + location.hash;
  const active = !location.pathname.startsWith("/canvas");
  const id = location.pathname.match(/^\/c\/(.+)$/)?.[1];
  const accepted = useAcceptedConversationRoute({
    active,
    conversationId: id,
    href,
    scopeKey: "scope",
    skip,
    accept,
    onAccepted,
    navigate,
    onError,
  });
  return (
    <>
      <output aria-label="url">{href}</output>
      <output aria-label="accepted">{accepted}</output>
      <button type="button" onClick={() => navigate("/c/b")}>
        Open B
      </button>
      <button type="button" onClick={() => navigate("/canvas")}>
        Canvas
      </button>
    </>
  );
}
it("restores the full accepted URL on cancel and accepts a repeated selection", async () => {
  const accept = vi.fn(async (id: string) => id !== "b");
  const onAccepted = vi.fn();
  render(
    <MemoryRouter initialEntries={["/c/a?file=keep#anchor"]}>
      <RouteHarness accept={accept} onAccepted={onAccepted} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(onAccepted).toHaveBeenCalledWith("a"));
  fireEvent.click(screen.getByText("Open B"));
  await waitFor(() => expect(accept).toHaveBeenCalledWith("b"));
  await waitFor(() =>
    expect(screen.getByLabelText("url")).toHaveTextContent("/c/a?file=keep#anchor"),
  );
  expect(accept.mock.calls.filter(([id]) => id === "a")).toHaveLength(1);
  accept.mockResolvedValue(true);
  fireEvent.click(screen.getByText("Open B"));
  await waitFor(() => expect(screen.getByLabelText("accepted")).toHaveTextContent("/c/b"));
  expect(accept.mock.calls.filter(([id]) => id === "b")).toHaveLength(2);
});
it("ignores an outstanding route decision after the workbench becomes inactive", async () => {
  let finish!: (allowed: boolean) => void;
  const accept = vi.fn((id: string) =>
    id === "b"
      ? new Promise<boolean>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(true),
  );
  const onAccepted = vi.fn();
  render(
    <MemoryRouter initialEntries={["/c/a"]}>
      <RouteHarness accept={accept} onAccepted={onAccepted} />
    </MemoryRouter>,
  );
  await waitFor(() => expect(onAccepted).toHaveBeenCalledWith("a"));
  fireEvent.click(screen.getByText("Open B"));
  await waitFor(() => expect(finish).toBeDefined());
  fireEvent.click(screen.getByText("Canvas"));
  await act(async () => finish(false));
  expect(screen.getByLabelText("url")).toHaveTextContent("/canvas");
  expect(onAccepted).not.toHaveBeenCalledWith("b");
});

function ownerOptions() {
  return {
    active: true,
    scopeKey: "scope",
    ownerId: "a",
    href: "/c/a",
    acceptedHref: "/c/a" as string | null,
    selectOwner: vi.fn(async (_id: string) => true),
    navigate: vi.fn(),
    onSelected: vi.fn(),
    onError: vi.fn(),
  };
}

it("retains search completion until its layout owner and full route are accepted", async () => {
  const options = ownerOptions();
  const done = vi.fn();
  const { result, rerender } = renderHook(useConversationOwnerNavigation, {
    initialProps: options,
  });
  await act(async () => {
    result.current("/c/b?message=exact", done);
  });
  expect(options.selectOwner).toHaveBeenCalledWith("b");
  expect(options.navigate).toHaveBeenCalledWith("/c/b?message=exact");
  expect(done).not.toHaveBeenCalled();
  rerender({ ...options, ownerId: "b", href: "/c/b?message=exact", acceptedHref: null });
  expect(done).not.toHaveBeenCalled();
  rerender({
    ...options,
    ownerId: "b",
    href: "/c/b?message=exact",
    acceptedHref: "/c/b?message=exact",
  });
  expect(options.onSelected).toHaveBeenCalledExactlyOnceWith("b");
  expect(done).toHaveBeenCalledOnce();
  rerender({
    ...options,
    ownerId: "b",
    href: "/c/b?message=exact",
    acceptedHref: "/c/b?message=exact",
  });
  expect(done).toHaveBeenCalledOnce();
});

it.each(["refused", "stale query", "other route", "other scope", "inactive"])(
  "ignores a %s owner selection without losing a later request",
  async (scenario) => {
    let finish!: (allowed: boolean) => void;
    const options = ownerOptions();
    options.selectOwner.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result, rerender } = renderHook(useConversationOwnerNavigation, {
      initialProps: options,
    });
    const done = vi.fn();
    let relevant = true;
    act(() => {
      result.current("/c/b", done, () => relevant);
    });
    if (scenario === "stale query") relevant = false;
    if (scenario === "other route") rerender({ ...options, href: "/c/c" });
    if (scenario === "other scope") rerender({ ...options, scopeKey: "other" });
    if (scenario === "inactive") rerender({ ...options, active: false });
    await act(async () => {
      finish(scenario !== "refused");
    });
    expect(options.navigate).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  },
);

it("keeps only the newest search activation while owner decisions overlap", async () => {
  const options = ownerOptions();
  const finishes = new Map<string, (allowed: boolean) => void>();
  options.selectOwner.mockImplementation(
    (id) =>
      new Promise((resolve) => {
        finishes.set(id, resolve);
      }),
  );
  const first = vi.fn();
  const latest = vi.fn();
  const { result, rerender } = renderHook(useConversationOwnerNavigation, {
    initialProps: options,
  });
  act(() => {
    result.current("/c/b", first);
    result.current("/c/c", latest);
  });
  await act(async () => {
    finishes.get("c")!(true);
    finishes.get("b")!(true);
  });
  expect(options.navigate).toHaveBeenCalledExactlyOnceWith("/c/c");
  rerender({ ...options, ownerId: "c", href: "/c/c", acceptedHref: "/c/c" });
  expect(latest).toHaveBeenCalledOnce();
  expect(first).not.toHaveBeenCalled();
});
