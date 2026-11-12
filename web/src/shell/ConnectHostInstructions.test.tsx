// Modified for Triune.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { CapabilitiesProvider } from "@/lib/CapabilitiesContext";
import { FALLBACK_SERVER_INFO } from "@/lib/capabilities";
import { setOmnigentHostConfig } from "@/lib/host";
import { ConnectHostDialog, ConnectHostInstructions } from "./ConnectHostInstructions";

afterEach(() => {
  cleanup();
  setOmnigentHostConfig({});
  delete window.__OMNIGENT_BASE_PATH__;
});

it.each(["loading", false, true] as const)(
  "preserves deployment commands and copies quoted server URLs (Databricks: %s)",
  async (databricks) => {
    const user = userEvent.setup();
    const serverUrl = "https://omni.example.test/api?profile=dev&name=it's";
    const quotedUrl = "'https://omni.example.test/api?profile=dev&name=it'\"'\"'s'";
    render(
      <CapabilitiesProvider
        info={
          databricks === "loading"
            ? "loading"
            : { ...FALLBACK_SERVER_INFO, databricks_features: databricks }
        }
      >
        <ConnectHostInstructions serverUrl={serverUrl} label="Connect your machine" />
      </CapabilitiesProvider>,
    );
    expect(screen.getByText("Connect your machine")).toBeVisible();
    const command = `triune host --server ${quotedUrl}`;
    expect(screen.getByTestId("connect-host-command")).toHaveTextContent(command);
    await user.click(screen.getByTestId("connect-host-copy"));
    expect(await navigator.clipboard.readText()).toBe(command);
    if (databricks === true) {
      await user.click(screen.getByRole("tab", { name: "Databricks Lakebox" }));
      expect(screen.getByTestId("connect-lakebox-create-command")).toHaveTextContent(
        "triune sandbox create --provider lakebox",
      );
      const lakebox = `triune sandbox connect --provider lakebox --sandbox-id <id> --server ${quotedUrl}`;
      expect(screen.getByTestId("connect-lakebox-connect-command")).toHaveTextContent(lakebox);
      await user.click(screen.getByTestId("connect-lakebox-connect-copy"));
      expect(await navigator.clipboard.readText()).toBe(lakebox);
    } else {
      expect(screen.queryByRole("tab")).toBeNull();
      expect(screen.queryByTestId("connect-lakebox-create-command")).toBeNull();
    }
  },
);

it("uses the deployment's base path and embedded CLI suffix in the shared dialog", () => {
  window.__OMNIGENT_BASE_PATH__ = "/proxy/6767";
  setOmnigentHostConfig({ cliServerUrlSuffix: "/api?profile=dev&glob=*" });
  render(
    <ConnectHostDialog open onOpenChange={() => {}}>
      <button type="button">Add host…</button>
    </ConnectHostDialog>,
  );
  expect(screen.getByRole("dialog", { name: "Connect a host" })).toBeVisible();
  expect(screen.getByTestId("connect-host-command")).toHaveTextContent(
    `triune host --server '${window.location.origin}/proxy/6767/api?profile=dev&glob=*'`,
  );
});
