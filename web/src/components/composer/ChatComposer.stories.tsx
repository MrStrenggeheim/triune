import type { Meta, StoryObj } from "@storybook/react-vite";
import { ComposerAttachments } from "@/components/ComposerAttachments";
import { ChatComposer, ComposerSendButton } from "./ChatComposer";
import { ComposerAddMenu } from "./ComposerAddMenu";
import { userEvent, within } from "storybook/test";

const KEYBOARD = { submitWithModEnter: false, preventsKeyboardSubmit: false } as const;

const file = (name: string, content = "x", type = "text/plain") =>
  new File([content], name, { type });

const meta = {
  title: "Components/Composer/ChatComposer",
  component: ChatComposer,
  tags: ["visual-snapshot"],
  args: {
    keyboard: KEYBOARD,
    input: { "aria-label": "Message" as const },
  },
  decorators: [
    (Story) => (
      <div className="w-[680px] rounded-2xl bg-muted/30 p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChatComposer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    input: { "aria-label": "Message", placeholder: "Message the agent" },
    actions: {
      leading: <span className="text-ui text-muted-foreground">Context controls</span>,
      trailing: <ComposerSendButton label="Send" />,
    },
  },
};

// Review the production menu inside the composer, including the trigger-to-popup transition.
export const AttachmentMenu: Story = {
  tags: ["!visual-snapshot"],
  args: {
    input: { "aria-label": "Message", placeholder: "Message the agent" },
    actions: {
      leading: <ComposerAddMenu disabled={false} planActive={false} onAttach={() => {}} />,
      trailing: <ComposerSendButton label="Send" />,
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId("composer-attach"));
    await within(canvasElement.ownerDocument.body).findByRole("menu");
  },
};

export const WithDraft: Story = {
  args: {
    input: { "aria-label": "Message", defaultValue: "Summarize the open pull requests" },
    actions: {
      leading: <span className="text-ui text-muted-foreground">Context controls</span>,
      trailing: <ComposerSendButton label="Send" />,
    },
  },
};

export const WithAttachments: Story = {
  args: {
    input: { "aria-label": "Message", placeholder: "Message the agent" },
    slots: {
      attachments: (
        <ComposerAttachments
          files={[file("notes.txt", "hello"), file("src/App.tsx", "code", "text/typescript")]}
          onRemove={() => undefined}
        />
      ),
    },
    actions: {
      leading: <span className="text-ui text-muted-foreground">Context controls</span>,
      trailing: <ComposerSendButton label="Send" />,
    },
  },
};

export const Interrupt: Story = {
  args: {
    input: {
      "aria-label": "Message",
      placeholder: "Queue a follow-up — the agent is working",
    },
    actions: {
      leading: <span className="text-ui text-muted-foreground">Context controls</span>,
      trailing: <ComposerSendButton label="Interrupt" interrupt />,
    },
  },
};
