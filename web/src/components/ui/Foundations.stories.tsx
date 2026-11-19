// Modified for Triune; inherited notices remain applicable.
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";
import {
  Archive,
  BellIcon,
  CheckIcon,
  InfoIcon,
  Link as LinkIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { DEFAULT_DIFF_COMPARISON, DiffComparisonControls } from "@/shell/DiffComparisonControls";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./alert";
import { Avatar, AvatarBadge, AvatarFallback, AvatarGroup, AvatarGroupCount } from "./avatar";
import { Badge } from "./badge";
import { Button } from "./button";
import { ButtonGroup } from "./button-group";
import { Input } from "./input";
import { Switch } from "./switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

const buttonVariants = ["default", "secondary", "outline", "ghost", "destructive", "link"] as const;
const badgeVariants = ["default", "secondary", "outline", "ghost", "destructive", "link"] as const;
const panel = "space-y-2 rounded-lg border bg-card p-3";

const meta = {
  title: "Foundations/Primitives",
  tags: ["visual-snapshot"],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const MediumButton: Story = {
  render: () => (
    <div className="grid justify-items-start gap-3">
      {(["default", "ghost", "secondary"] as const).map((variant) => (
        <div role="group" aria-label={variant} key={variant} className="flex flex-wrap gap-2">
          <Button type="button" variant={variant} tooltip={false}>
            <Archive aria-hidden />
            Archive chat
          </Button>
          <Button type="button" variant={variant} tooltip={false}>
            <LinkIcon aria-hidden />
            Copy link
          </Button>
        </div>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    for (const button of within(canvasElement).getAllByRole("button")) {
      const style = getComputedStyle(button);
      const unit = Math.max(1, parseFloat(style.fontSize) / 14);
      const box = button.getBoundingClientRect();
      const glyph = button.querySelector("svg")!.getBoundingClientRect();
      const ink = within(button).getByText(/Archive chat|Copy link/);
      const label = ink.parentElement!.getBoundingClientRect();
      expect(box.height).toBeCloseTo(2 + 30 * unit, 1);
      expect(glyph.height).toBeCloseTo(14 * unit, 1);
      expect(glyph.width).toBeCloseTo(glyph.height, 1);
      expect(glyph.top - box.top).toBeCloseTo(1 + 8 * unit, 1);
      expect(glyph.left - box.left).toBeCloseTo(1 + 8 * unit, 1);
      expect(box.right - label.right).toBeCloseTo(1 + 8 * unit, 1);
      expect(label.left - glyph.right).toBeCloseTo(6 * unit, 1);
      expect(label.top).toBeCloseTo(glyph.top, 1);
      expect(label.height).toBeCloseTo(glyph.height, 1);
      expect(getComputedStyle(ink).top).toBe("-0.5px");
    }
  },
};

export const GhostMenuFeedback: Story = {
  render: function ComparisonMenu() {
    const [comparison, setComparison] = useState(DEFAULT_DIFF_COMPARISON);
    return <DiffComparisonControls repositoryRoot value={comparison} onChange={setComparison} />;
  },
};

export const MediumTouchTargets: Story = {
  // This story exercises hit testing on a device with a coarse pointer.
  tags: ["!visual-snapshot"],
  render: () => (
    <div className="grid justify-items-start gap-4">
      <div role="group" aria-label="Pages" className="flex items-center">
        <Button type="button">1</Button>
        <Button asChild>
          <a href="#page-2">2</a>
        </Button>
        <Button type="button" size="sm">
          Next
        </Button>
      </div>
      <div role="group" aria-label="Stacked" className="flex flex-col items-start">
        <Button type="button">Retry</Button>
        <Button type="button">Cancel</Button>
      </div>
      {(["horizontal", "vertical"] as const).map((orientation) => (
        <ButtonGroup key={orientation} orientation={orientation} aria-label={orientation}>
          <Button type="button" variant="outline">
            A
          </Button>
          <Button type="button" variant="outline">
            B
          </Button>
        </ButtonGroup>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    if (!matchMedia("(any-pointer: coarse)").matches) return;
    const controls = within(canvasElement);
    const at = (x: number, y: number) => canvasElement.ownerDocument.elementFromPoint(x, y);
    await waitFor(() => {
      for (const name of ["Pages", "Stacked"]) {
        const group = controls.getByRole("group", { name });
        for (const action of group.querySelectorAll<HTMLElement>(".button-medium")) {
          action.scrollIntoView({ block: "center" });
          const box = action.getBoundingClientRect();
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          for (const offset of [-21, 21]) {
            expect(action.contains(at(x, y + offset))).toBe(true);
            expect(action.contains(at(x + offset, y))).toBe(true);
          }
        }
      }
    });
    for (const name of ["horizontal", "vertical"]) {
      const group = controls.getByRole("group", { name });
      group.scrollIntoView({ block: "center" });
      const [first, second] = within(group).getAllByRole("button");
      const box = first.getBoundingClientRect();
      const horizontal = name === "horizontal";
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const beforeSeam = horizontal
        ? at(Math.floor(box.right) - 1, y)
        : at(x, Math.floor(box.bottom) - 1);
      const afterSeam = horizontal
        ? at(Math.ceil(box.right) + 1, y)
        : at(x, Math.ceil(box.bottom) + 1);
      expect(first.contains(beforeSeam)).toBe(true);
      expect(second.contains(afterSeam)).toBe(true);
    }
  },
};

export const Gallery: Story = {
  render: () => (
    <div className="w-[720px] max-w-full space-y-3 text-foreground">
      <header>
        <h1 className="text-lg font-semibold">Foundation primitives</h1>
        <p className="text-sm text-muted-foreground">Durable variants and component states.</p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2">
        <section className={`${panel} sm:col-span-2`}>
          <h2 className="font-medium">Buttons</h2>
          <div className="flex flex-wrap gap-2">
            {buttonVariants.map((variant) => (
              <Button key={variant} variant={variant}>
                {variant}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs">XS</Button>
            <Button size="sm">Small</Button>
            <Button>Default</Button>
            <Button size="lg">Large</Button>
            <Button variant="outline" size="icon-sm" aria-label="Notifications">
              <BellIcon />
            </Button>
            <Button loading>Loading</Button>
            <Button disabled>Disabled</Button>
          </div>
        </section>
        <section className={panel}>
          <h2 className="font-medium">Badges</h2>
          <div className="flex flex-wrap gap-2">
            {badgeVariants.map((variant, index) => (
              <Badge key={variant} variant={variant}>
                {index === 0 && <CheckIcon data-icon="inline-start" />}
                {variant}
              </Badge>
            ))}
          </div>
        </section>
        <section className={panel}>
          <h2 className="font-medium">Avatars</h2>
          <div className="flex items-center gap-3">
            <Avatar size="lg">
              <AvatarFallback>OM</AvatarFallback>
              <AvatarBadge>
                <CheckIcon />
              </AvatarBadge>
            </Avatar>
            <Avatar>
              <AvatarFallback>UI</AvatarFallback>
            </Avatar>
            <AvatarGroup>
              <Avatar>
                <AvatarFallback>AA</AvatarFallback>
              </Avatar>
              <Avatar>
                <AvatarFallback>BB</AvatarFallback>
              </Avatar>
              <AvatarGroupCount>+3</AvatarGroupCount>
            </AvatarGroup>
          </div>
        </section>
        <section className={panel}>
          <h2 className="font-medium">Inputs</h2>
          <Input aria-label="Default input" placeholder="Placeholder" />
          <Input aria-label="Invalid input" aria-invalid="true" defaultValue="Invalid value" />
          <Input aria-label="Disabled input" defaultValue="Disabled value" disabled />
        </section>
        <section className={panel}>
          <h2 className="font-medium">Switches</h2>
          <SwitchRow label="Checked">
            <Switch aria-label="Checked switch" defaultChecked />
          </SwitchRow>
          <SwitchRow label="Small">
            <Switch aria-label="Small switch" size="sm" />
          </SwitchRow>
          <SwitchRow label="Disabled">
            <Switch aria-label="Disabled switch" defaultChecked disabled />
          </SwitchRow>
        </section>
        <section className={`${panel} sm:col-span-2`}>
          <h2 className="font-medium">Tabs</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <TabsExample variant="default" />
            <TabsExample variant="line" />
            <TabsExample variant="pill" />
          </div>
        </section>
        <section className={`${panel} sm:col-span-2`}>
          <h2 className="font-medium">Alerts</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            <Alert>
              <InfoIcon />
              <AlertTitle>Informational alert</AlertTitle>
              <AlertDescription>Title, description, icon, and action.</AlertDescription>
              <AlertAction>
                <Button variant="outline" size="xs">
                  Action
                </Button>
              </AlertAction>
            </Alert>
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>Destructive alert</AlertTitle>
              <AlertDescription>A concise failure using destructive tokens.</AlertDescription>
            </Alert>
          </div>
        </section>
      </div>
    </div>
  ),
};

function SwitchRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between rounded-md border px-2.5 py-2">
      <span className="text-ui">{label}</span>
      {children}
    </div>
  );
}

function TabsExample({ variant }: { variant: "default" | "line" | "pill" }) {
  return (
    <Tabs defaultValue="active">
      <TabsList variant={variant} aria-label={`${variant} tabs`}>
        <TabsTrigger value="active">Active</TabsTrigger>
        <TabsTrigger value="idle">Idle</TabsTrigger>
        <TabsTrigger value="disabled" disabled>
          Disabled
        </TabsTrigger>
      </TabsList>
      <TabsContent value="active" className="pt-1 text-muted-foreground">
        Active content
      </TabsContent>
    </Tabs>
  );
}
