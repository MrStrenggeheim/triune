// Modified for Triune; inherited notices remain applicable.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SystemMessageView } from "./SystemMessage";

afterEach(cleanup);

describe("SystemMessageView", () => {
  it("hides sub-agent wake notices instead of rendering a centered System row", () => {
    const { container } = render(
      <SystemMessageView
        message={{
          kind: "subagent_wake",
          label: "Sub-agent result ready",
          body: "",
        }}
      />,
    );

    expect(screen.queryByTestId("system-message")).toBeNull();
    expect(container.textContent).toBe("");
  });
});

it("uses one trailing disclosure for the exact System body without footer controls", () => {
  const message = {
    kind: "generic" as const,
    label: "Context retained",
    body: "Captured runtime detail",
  };
  render(<SystemMessageView message={message} />);
  const disclosure = screen.getByRole("button", { name: "Expand activity" });
  const id = disclosure.getAttribute("aria-controls")!;
  expect(screen.getByText("System")).toBeVisible();
  expect(screen.getByText(message.body)).toBeVisible();
  expect(screen.queryByText(message.label)).toBeNull();
  expect(document.getElementById(id)).not.toBeVisible();
  fireEvent.click(disclosure);
  expect(document.getElementById(id)).toHaveTextContent(message.body);
  expect(screen.getAllByText(message.body)).toHaveLength(1);
  expect(disclosure).toHaveAttribute("aria-expanded", "true");
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(screen.queryByTestId("message-timestamp")).toBeNull();
});

it("keeps source navigation outside disclosure and lazily mounts attached content", () => {
  const source = <a href="/c/captured">Captured chat</a>;
  render(
    <SystemMessageView
      message={{ kind: "generic", label: "Runtime input", body: "" }}
      source={source}
      sourceItemId="captured-item"
    >
      <p>Attachment and full captured input</p>
    </SystemMessageView>,
  );
  const disclosure = screen.getByRole("button", { name: "Expand activity" });
  const link = screen.getByRole("link", { name: "Captured chat" });
  expect(link).toHaveAttribute("href", "/c/captured");
  expect(link.closest("button")).toBeNull();
  expect(screen.queryByText("Attachment and full captured input")).toBeNull();
  expect(screen.getByText("Runtime input")).toBeVisible();
  fireEvent.click(link);
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(disclosure);
  expect(screen.getByText("Attachment and full captured input")).toBeVisible();
  expect(screen.queryByText("Runtime input")).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
});

it("does not add an empty disclosure to a System notice without body or attachments", () => {
  render(<SystemMessageView message={{ kind: "generic", label: "Retained notice", body: " " }} />);
  expect(screen.getByText("Retained notice")).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
});

it("uses the first compact notice line without repeating its source label", () => {
  render(
    <SystemMessageView
      source={<span>Recovery</span>}
      message={{
        kind: "generic",
        label: "Recovery",
        body: "\n  Continue   from retained context.\r\nLater runtime details.",
      }}
    />,
  );
  expect(screen.getAllByText("Recovery")).toHaveLength(1);
  expect(screen.getByText("Continue from retained context.")).toBeVisible();
  expect(screen.queryByText(/Later runtime details/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
  expect(screen.getByTestId("system-message")).toHaveTextContent("Later runtime details.");
  expect(
    screen.getByTestId("system-message").textContent?.match(/Continue\s+from retained context\./g),
  ).toHaveLength(1);
});

it("uses body text for the collapsed summary while supplied children own expansion", () => {
  render(
    <SystemMessageView
      message={{
        kind: "generic",
        label: "Framework input",
        body: "Captured input excerpt.\nRaw body fallback.",
      }}
    >
      <p>Attachment renderer and full input</p>
    </SystemMessageView>,
  );
  expect(screen.getByText("Captured input excerpt.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Expand activity" }));
  expect(screen.getByText("Attachment renderer and full input")).toBeVisible();
  expect(screen.queryByText(/Captured input excerpt|Raw body fallback/)).toBeNull();
});

it("keeps the collapsed notice excerpt bounded without a broken surrogate", () => {
  render(
    <SystemMessageView
      message={{ kind: "generic", label: "Notice", body: `${"x".repeat(767)}🙂HIDDEN_TAIL` }}
    />,
  );
  const notice = screen.getByTestId("system-message");
  expect(notice).not.toHaveTextContent("HIDDEN_TAIL");
  expect(notice).not.toHaveTextContent("\uFFFD");
});
