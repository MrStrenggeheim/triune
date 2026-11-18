// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { Button } from "@/components/ui/button";
import type { HostFilesystemEntry } from "@/hooks/useHostFilesystem";
import type { Host } from "@/hooks/useHosts";
import { StoryQueryRouter } from "@/storybook/StoryProviders";
import "@/listDensity.css";
import { parentOf } from "./WorkspacePicker";
import { WorkspaceSelectionDialog, type WorkspaceSelection } from "./WorkspaceSelectionDialog";
import {
  storyDirectory,
  storyFile,
  workspaceStoryHome,
  workspaceStoryHost,
  workspaceStoryProjects,
} from "./workspaceStoryFixtures";

const buildHost = "host-build-story";
const hosts: Host[] = [
  { host_id: workspaceStoryHost, name: "Laptop", status: "online", owner: "story" },
  { host_id: buildHost, name: "Build host", status: "online", owner: "story" },
];

function installHostFixtures() {
  const trees = new Map(
    hosts.map(({ host_id }): [string, HostFilesystemEntry[]] => {
      const project = `${workspaceStoryProjects}/${host_id === buildHost ? "release" : "app"}`;
      return [
        host_id,
        [
          ...["/Users", workspaceStoryHome, workspaceStoryProjects, project, `${project}/src`].map(
            storyDirectory,
          ),
          storyFile(`${project}/README.md`, 2048),
        ],
      ];
    }),
  );
  const fetch = window.fetch;
  window.fetch = async (input, init) => {
    const { pathname } = new URL(input instanceof Request ? input.url : input, location.href);
    if (!pathname.startsWith("/v1/")) return fetch(input, init);
    if (pathname === "/v1/hosts") return Response.json({ hosts });
    const [, , , host, resource, ...segments] = pathname.split("/");
    const entries = trees.get(host);
    if (entries) {
      if (resource === "worktrees") return Response.json({ data: [] });
      if (resource === "directories" && init?.method === "POST") {
        const { path } = JSON.parse(String(init.body)) as { path: string };
        if (entries.some((entry) => entry.path === path)) {
          return Response.json({ detail: "Directory already exists" }, { status: 409 });
        }
        entries.push(storyDirectory(path));
        return Response.json({ path });
      }
      if (resource === "filesystem") {
        const path = segments.length
          ? "/" + segments.map(decodeURIComponent).join("/")
          : workspaceStoryHome;
        if (
          path === "/" ||
          entries.some((entry) => entry.type === "directory" && entry.path === path)
        ) {
          return Response.json({
            data: entries.filter((entry) => parentOf(entry.path) === path),
            has_more: false,
          });
        }
      }
    }
    return Response.json({ detail: "Unknown fixture path" }, { status: 404 });
  };
  return () => {
    window.fetch = fetch;
  };
}

function HostAndFolderFixture() {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<WorkspaceSelection>({
    hostId: workspaceStoryHost,
    path: workspaceStoryProjects,
  });
  return (
    <StoryQueryRouter>
      <Button onClick={() => setOpen(true)}>Select workspace</Button>
      <output className="block text-sm">
        {hosts.find((host) => host.host_id === selection.hostId)?.name} · {selection.path}
      </output>
      <WorkspaceSelectionDialog
        open={open}
        onOpenChange={setOpen}
        hostId={selection.hostId}
        initialPath={selection.path}
        onConfirm={setSelection}
      />
    </StoryQueryRouter>
  );
}

const meta = {
  title: "Components/Workspace/WorkspaceSelectionDialog",
  component: WorkspaceSelectionDialog,
  beforeEach: installHostFixtures,
} satisfies Meta<typeof WorkspaceSelectionDialog>;

export default meta;

export const HostAndFolder: StoryObj = {
  render: () => <HostAndFolderFixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    const open = async () =>
      userEvent.click(await canvas.findByRole("button", { name: "Select workspace" }));
    await open();
    await userEvent.click(await body.findByRole("button", { name: /Build host/ }));
    await userEvent.click(await body.findByRole("button", { name: "projects" }));
    await userEvent.click(await body.findByRole("button", { name: "release" }));
    await expect(await body.findByRole("button", { name: "README.md" })).toBeDisabled();
    await userEvent.click(await body.findByRole("button", { name: "Use workspace" }));
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      `Build host · ${workspaceStoryProjects}/release`,
    );
    await open();
    await userEvent.click(await body.findByRole("button", { name: /Laptop/ }));
    await userEvent.click(body.getByRole("button", { name: "Cancel" }));
    await open();
    await expect(await body.findByRole("button", { name: /Build host/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(await body.findByRole("textbox", { name: "Current folder path" })).toHaveValue(
      `${workspaceStoryProjects}/release`,
    );
  },
};
