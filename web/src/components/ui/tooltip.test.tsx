// Modified for Triune.
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./collapsible";
import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { DisabledActionTooltip } from "@/components/DisabledActionTooltip";
import { ComposerPermissionPicker } from "@/components/composer/ComposerControls";
import { Tooltip, TooltipButton, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { Tabs, TabsList, TabsTrigger } from "./tabs";
import { Dialog, DialogContent, DialogTitle } from "./dialog";
import { ImageLightboxProvider, ZoomableImage } from "@/components/ImageLightbox";
import { setEmbedRoot } from "@/lib/host";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
  setEmbedRoot(null);
});

function panel() {
  return document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')!;
}

describe("canonical button tooltips", () => {
  it.each([Button, TooltipButton])(
    "supports explicit tooltip suppression on %s",
    async (Control) => {
      render(
        <Control tooltip={false} aria-label="Close">
          <svg aria-hidden />
        </Control>,
      );
      const close = screen.getByRole("button", { name: "Close" });
      await userEvent.hover(close);
      fireEvent.focus(close);
      expect(close).not.toHaveAttribute("data-slot", "tooltip-trigger");
      expect(screen.queryByRole("tooltip")).toBeNull();
    },
  );
  it.each([Button, TooltipButton])(
    "preserves implicit form submission through %s",
    async (Control) => {
      const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
      render(
        <form onSubmit={submit}>
          <Control>Save implicitly</Control>
          <Control type="button">Cancel</Control>
        </form>,
      );
      await userEvent.click(screen.getByRole("button", { name: "Save implicitly" }));
      expect(submit).toHaveBeenCalledOnce();
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(submit).toHaveBeenCalledOnce();
    },
  );

  it("keeps lightbox Close guidance suppressed so the first Escape closes the dialog", async () => {
    render(
      <ImageLightboxProvider>
        <ZoomableImage src="/pic.png" alt="diagram" />
      </ImageLightboxProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Zoom image: diagram" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    const close = screen.getByRole("button", { name: "Close" });
    await userEvent.hover(close);
    expect(close).not.toHaveAttribute("data-slot", "tooltip-trigger");
    expect(close).not.toHaveAttribute("title");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("still shows modal button guidance after real keyboard navigation", async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent showCloseButton={false} aria-describedby={undefined}>
          <DialogTitle>Tools</DialogTitle>
          <Button>Reset zoom</Button>
          <Button title="Download the original file without preview conversion">
            Download original
          </Button>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("button", { name: "Reset zoom" })).toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Download original" })).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("without preview conversion");
    expect(document.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(1);
  });

  it("coordinates controlled roots even across separate fallback providers", async () => {
    const closeFirst = vi.fn();
    render(
      <>
        <Tooltip open onOpenChange={closeFirst}>
          <TooltipTrigger>First</TooltipTrigger>
          <TooltipContent>First guidance</TooltipContent>
        </Tooltip>
        <Tooltip open>
          <TooltipTrigger>Second</TooltipTrigger>
          <TooltipContent>Second guidance</TooltipContent>
        </Tooltip>
      </>,
    );
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Second guidance");
    expect(document.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(1);
    expect(closeFirst).toHaveBeenCalledWith(false);
  });

  it("keeps disabled permission guidance accessible on a focusable wrapper", async () => {
    const reason = "Only the session owner can change the permission mode";
    render(
      <ComposerPermissionPicker
        label="Permission mode"
        value="Ask for approval"
        options={[]}
        disabled
        disabledReason={reason}
        onSelect={() => {}}
      />,
    );
    const control = screen.getByRole("button", { name: "Permission mode: Ask for approval" });
    expect(control).toBeDisabled();
    expect(control).not.toHaveAttribute("title");
    const wrapper = screen.getByRole("group", { name: "Permission mode: Ask for approval" });
    await userEvent.tab();
    expect(wrapper).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(reason);
    expect(wrapper).toHaveAccessibleDescription(reason);
    expect(document.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(1);
  });

  it("does not let an empty disabled-action wrapper suppress an enabled button's tooltip", async () => {
    render(
      <DisabledActionTooltip label="Save">
        <TooltipButton title="Save file">Save</TooltipButton>
      </DisabledActionTooltip>,
    );
    await userEvent.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Save file");
    expect(document.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(1);
  });

  it.each([false, true])(
    "keeps a white panel in dark=%s, centered above with the canonical gap",
    async (dark) => {
      document.documentElement.classList.toggle("dark", dark);
      render(
        <Tooltip open>
          <TooltipTrigger>Search files</TooltipTrigger>
          <TooltipContent
            avoidCollisions={false}
            align="start"
            sideOffset={20}
            className="bg-black dark:bg-black"
            shortcut={["Ctrl", "Shift", "F"]}
          >
            Search files
          </TooltipContent>
        </Tooltip>,
      );
      expect(await screen.findByRole("tooltip")).toHaveTextContent("Search files");
      expect(panel()).toHaveStyle({
        backgroundColor: "#fff",
        color: "#30303a",
        borderRadius: "7px",
      });
      expect(panel()).toHaveAttribute("data-side", "top");
      expect(panel()).toHaveAttribute("data-align", "center");
      expect(panel().querySelectorAll("kbd")).toHaveLength(3);
      // Radix measures the real 8px offset in the browser; jsdom has no layout.
      expect(panel().parentElement).toHaveAttribute("data-radix-popper-content-wrapper");
    },
  );

  it("preserves configured bottom placement and puts a description below the label and shortcut", async () => {
    render(
      <Tooltip open>
        <TooltipTrigger>Compare</TooltipTrigger>
        <TooltipContent
          side="bottom"
          avoidCollisions={false}
          description="Choose Git changes or an agent turn."
          shortcut={["Ctrl", "G"]}
        >
          Compare changes
        </TooltipContent>
      </Tooltip>,
    );
    await screen.findByRole("tooltip");
    expect(panel()).toHaveAttribute("data-side", "bottom");
    expect(panel()).toHaveAttribute("data-align", "center");
    expect(panel().firstElementChild).toHaveTextContent("Compare changesCtrlG");
    expect(panel().lastElementChild).toHaveTextContent("Choose Git changes or an agent turn.");
  });

  it.each([undefined, "Inspect the complete command\nincluding its final argument"])(
    "preserves long multiline guidance with description=%s within a wrapping, scrollable panel",
    async (description) => {
      const command = `printf '%s' ${"unbroken-path/".repeat(80)}final-argument\nprintf 'done'`;
      render(
        <Tooltip open>
          <TooltipTrigger>Command details</TooltipTrigger>
          <TooltipContent description={description}>{command}</TooltipContent>
        </Tooltip>,
      );
      await screen.findByRole("tooltip");
      // Inspect rendered text directly to check exact newlines and final arguments.
      const content = panel();
      expect(content.firstElementChild?.textContent).toBe(command);
      if (description) expect(content.lastElementChild?.textContent).toBe(description);
      expect(content).toHaveStyle({
        minWidth: "0",
        maxWidth: "min(272px, var(--radix-popper-available-width, calc(100vw - 16px)))",
        maxHeight: "min(320px, var(--radix-tooltip-content-available-height, calc(100dvh - 16px)))",
        overflow: "auto",
        overflowWrap: "anywhere",
        whiteSpace: "pre-wrap",
      });
    },
  );

  it.each(["object", "callback"])(
    "preserves the %s trigger ref through popup bounds context",
    async (kind) => {
      const objectRef = createRef<HTMLButtonElement>();
      const callbackRef = vi.fn();
      const { unmount } = render(
        <Tooltip open>
          <TooltipTrigger asChild ref={kind === "object" ? objectRef : callbackRef}>
            <button type="button">Command details</button>
          </TooltipTrigger>
          <TooltipContent>Complete command</TooltipContent>
        </Tooltip>,
      );
      await screen.findByRole("tooltip");
      const trigger = screen.getByRole("button", { name: "Command details" });
      if (kind === "object") expect(objectRef.current).toBe(trigger);
      else expect(callbackRef).toHaveBeenLastCalledWith(trigger);
      unmount();
      if (kind === "object") expect(objectRef.current).toBeNull();
      else expect(callbackRef).toHaveBeenLastCalledWith(null);
    },
  );

  it.each(["title", "aria-label", "text"])(
    "opens native %s guidance on focus, retains refs and submits the form",
    async (source) => {
      const ref = createRef<HTMLButtonElement>();
      const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
      render(
        <form onSubmit={submit}>
          <TooltipButton
            ref={ref}
            type="submit"
            name="action"
            value="save"
            {...(source === "text" ? {} : { [source]: "Save file" })}
          >
            {source === "text" ? <span>Save file</span> : <svg aria-hidden />}
          </TooltipButton>
        </form>,
      );
      const button = screen.getByRole("button", { name: "Save file" });
      expect(ref.current).toBe(button);
      expect(button).not.toHaveAttribute("title");
      await userEvent.tab();
      if (source === "text") expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      else {
        expect(await screen.findByRole("tooltip")).toHaveTextContent("Save file");
        expect(button).toHaveAccessibleDescription("Save file");
      }
      await userEvent.keyboard("{Enter}");
      expect(submit).toHaveBeenCalledOnce();
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    },
  );

  it("uses one explicit tooltip around Button or TooltipButton and removes a native title", async () => {
    render(
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button title="Native duplicate">Configure</Button>
            <TooltipButton title="Other duplicate">Other</TooltipButton>
          </span>
        </TooltipTrigger>
        <TooltipContent>Configure model</TooltipContent>
      </Tooltip>,
    );
    fireEvent.focus(screen.getByRole("button", { name: "Configure" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Configure model");
    expect(document.querySelectorAll('[data-slot="tooltip-content"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Configure" })).not.toHaveAttribute("title");
    expect(screen.getByRole("button", { name: "Other" })).not.toHaveAttribute("title");
  });

  it("replaces a raw trigger title without losing its accessible name or click", async () => {
    const click = vi.fn();
    render(
      <Tooltip>
        <TooltipTrigger asChild>
          <button title="Download" onClick={click}>
            <svg />
          </button>
        </TooltipTrigger>
        <TooltipContent>Download file</TooltipContent>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Download" });
    expect(button).not.toHaveAttribute("title");
    fireEvent.focus(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Download file");
    fireEvent.click(button);
    expect(click).toHaveBeenCalledOnce();
  });

  it("portals to the embed root and dismisses on Escape", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    setEmbedRoot(root);
    render(
      <TooltipProvider delayDuration={0}>
        <Button aria-label="Download file">
          <svg />
        </Button>
      </TooltipProvider>,
    );
    await userEvent.tab();
    await screen.findByRole("tooltip");
    expect(root).toContainElement(panel());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    root.remove();
  });

  it("reads rendered text for opaque native button children without mutating their DOM", async () => {
    const Label = () => <span>Open report</span>;
    render(
      <TooltipButton>
        <Label />
      </TooltipButton>,
    );
    await userEvent.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Open report");
    expect(screen.getByRole("button")).toHaveTextContent("Open report");
  });

  it("shows Select guidance, suppresses it while open, and keeps option selection", async () => {
    const change = vi.fn();
    render(
      <Select onValueChange={change}>
        <SelectTrigger aria-label="Effort">
          <SelectValue placeholder="Pick" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="high">High</SelectItem>
        </SelectContent>
      </Select>,
    );
    fireEvent.focus(screen.getByRole("combobox"));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Effort");
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "High" }));
    expect(change).toHaveBeenCalledWith("high");
  });

  it("keeps tab roles, keyboard navigation and selection with canonical guidance", async () => {
    render(
      <Tabs defaultValue="files">
        <TabsList>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="search" aria-label="Search files">
            Search
          </TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const files = screen.getByRole("tab", { name: "Files" });
    fireEvent.focus(files);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Search files" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByRole("tab", { name: "Search files" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

it("keeps disclosure expansion without automatic Expand/Collapse details tooltips", async () => {
  const user = userEvent.setup();
  render(
    <TooltipProvider delayDuration={0}>
      <Collapsible>
        <CollapsibleTrigger>Tool details</CollapsibleTrigger>
        <CollapsibleContent>Command output</CollapsibleContent>
      </Collapsible>
    </TooltipProvider>,
  );
  const trigger = screen.getByRole("button", { name: "Tool details" });
  await user.hover(trigger);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  await user.click(trigger);
  expect(screen.getByText("Command output")).toBeVisible();
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  await user.unhover(trigger);
  await user.hover(trigger);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  await user.keyboard(" ");
  expect(screen.queryByText("Command output")).not.toBeInTheDocument();
});

it("retains explicitly supplied disclosure guidance in the canonical tooltip", async () => {
  render(
    <TooltipProvider delayDuration={0}>
      <Collapsible>
        <CollapsibleTrigger title="Includes stdout and stderr">Tool details</CollapsibleTrigger>
      </Collapsible>
    </TooltipProvider>,
  );
  const trigger = screen.getByRole("button", { name: "Tool details" });
  await userEvent.hover(trigger);
  expect(await screen.findByRole("tooltip")).toHaveTextContent("Includes stdout and stderr");
  expect(trigger).not.toHaveAttribute("title");
});
