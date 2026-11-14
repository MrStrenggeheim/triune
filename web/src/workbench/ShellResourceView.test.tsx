// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { getNotificationSnapshot, toast } from "@/lib/notifications";
import { shellResourceErrorMessage } from "@/lib/shellResourceError";
import { authenticatedFetch } from "@/lib/identity";
import * as terminals from "@/hooks/useTerminals";
import { ShellResourceView } from "./ShellResourceView";

vi.mock("@/lib/identity", () => ({
  authenticatedFetch: vi.fn(),
  getCurrentUserId: () => "shell-view-test",
}));
const fetch = vi.mocked(authenticatedFetch);
let client: QueryClient;
const identity = { source: "codex_native" as const, resource_id: "item/7" };
const record = {
  ...identity,
  session_id: "captured-chat",
  command: "printf actual-command",
  status: "completed",
  exit_code: 0,
  output: "first line\n\u001b[32mlast captured line\u001b[0m\n",
};
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  toast.dismiss();
  fetch.mockReset().mockResolvedValue(Response.json(record));
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  toast.dismiss();
});

it.each(["codex_native", "claude_native"] as const)(
  "opens %s output without calling createTerminal or attaching a terminal",
  async (source) => {
    const createTerminal = vi.spyOn(terminals, "createTerminal");
    fetch.mockResolvedValueOnce(Response.json({ ...record, source }));
    render(
      <ShellResourceView
        conversationId="captured-chat"
        shellResource={{ ...identity, source }}
        active
      />,
      {
        wrapper,
      },
    );
    expect(await screen.findByLabelText("Retained shell output")).toHaveTextContent(
      "first line last captured line",
    );
    expect(screen.getByText("Read-only output")).toBeVisible();
    expect(screen.getByText("Exit code: 0")).toBeVisible();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      `/v1/sessions/captured-chat/resources/shells/${source}/item%2F7`,
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /New shell|Attach/ })).toBeNull();
    expect(createTerminal).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Refresh shell output" })).toHaveAttribute(
      "data-header-action-button",
    );
  },
);

it("keeps retained output after refresh failure and never reuses it for another session", async () => {
  const view = render(
    <ShellResourceView conversationId="captured-chat" shellResource={identity} active />,
    { wrapper },
  );
  await screen.findByLabelText("Retained shell output");
  fetch.mockRejectedValueOnce(new Error("Runtime unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh shell output" }));
  await waitFor(() =>
    expect(getNotificationSnapshot().entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Shell output unavailable",
          description: shellResourceErrorMessage(new Error("Runtime unavailable")),
          action: expect.objectContaining({ label: "Refresh" }),
        }),
      ]),
    ),
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.body).not.toHaveTextContent("Runtime unavailable");
  expect(screen.getByLabelText("Retained shell output")).toHaveTextContent("last captured line");
  let finish!: (response: Response) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  view.rerender(<ShellResourceView conversationId="other-chat" shellResource={identity} active />);
  expect(screen.queryByText(/last captured line/)).toBeNull();
  view.rerender(
    <ShellResourceView conversationId="other-chat" shellResource={identity} active={false} />,
  );
  expect(fetch.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
  await act(async () => finish(Response.json({ ...record, session_id: "other-chat" })));
  expect(screen.queryByText(/last captured line/)).toBeNull();
});

it("rejects an arbitrary stored URL before making a request", async () => {
  render(
    <ShellResourceView
      conversationId="captured-chat"
      shellResource={{
        ...identity,
        resource_url: "/v1/sessions/other/resources/shells/codex_native/item%2F7",
      }}
      active
    />,
    { wrapper },
  );
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Shell output is unavailable"),
  );
  expect(fetch).not.toHaveBeenCalled();
});

it("retains a neutral stopped outcome and deduplicates offline notices without exposing runtime identifiers", async () => {
  fetch.mockResolvedValue(
    Response.json({
      ...record,
      status: "stopped",
      exit_code: -1,
      live_error: "runner_token_secret",
    }),
  );
  const view = render(
    <ShellResourceView conversationId="captured-chat" shellResource={identity} active />,
    { wrapper },
  );
  expect(await screen.findByRole("status", { name: "Stopped" })).toBeVisible();
  expect(screen.getByText("Exit code: -1")).toBeVisible();
  expect(screen.getByLabelText("Retained shell output")).toHaveTextContent("last captured line");
  const notice = () =>
    getNotificationSnapshot().entries.find((entry) => String(entry.id).startsWith("shell-output:"));
  expect(notice()).toMatchObject({
    title: "Shell runtime offline",
    action: expect.objectContaining({ label: "Refresh" }),
  });
  const id = notice()!.id;
  fireEvent.click(screen.getByRole("button", { name: "Refresh shell output" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(getNotificationSnapshot().entries.filter((entry) => entry.id === id)).toHaveLength(1);
  expect(document.body).not.toHaveTextContent("runner_token_secret");
  expect(JSON.stringify(notice())).not.toContain("runner_token_secret");
  view.rerender(
    <ShellResourceView conversationId="captured-chat" shellResource={identity} active={false} />,
  );
  expect(notice()).toMatchObject({ visible: false, action: undefined });
});

it("recognizes the safe offline response contract without requiring legacy live_error", async () => {
  fetch.mockResolvedValue(
    Response.json({ ...record, availability: "offline", warning: "Retained output only" }),
  );
  render(<ShellResourceView conversationId="captured-chat" shellResource={identity} active />, {
    wrapper,
  });
  expect(await screen.findByLabelText("Retained shell output")).toHaveTextContent(
    "last captured line",
  );
  expect(getNotificationSnapshot().entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        title: "Shell runtime offline",
        action: expect.objectContaining({ label: "Refresh" }),
      }),
    ]),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});
