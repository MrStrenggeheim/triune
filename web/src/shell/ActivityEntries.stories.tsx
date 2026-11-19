// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { ChildSessionInfo } from "@/hooks/useChildSessions";
import { StoryQueryRouter } from "@/storybook/StoryProviders";
import { AgentResourceRow } from "./ChatActivityPanel";
import "@/components/composer/composerShelves.css";
import "@/listDensity.css";

const child: ChildSessionInfo = {
  id: "review-agent",
  agent_name: "Scout",
  title: "researcher:Scout",
  session_name: "Scout",
  tool: "researcher",
  task_summary: "Check workspace changes",
  last_message_preview: "Reading the updated files.",
  current_task_status: "in_progress",
  busy: true,
  pending_elicitations_count: 0,
};

const meta = {
  title: "Components/Activity/Resource entry",
  component: AgentResourceRow,
  args: {
    child,
    conversationId: "review-session",
    active: true,
    onOpen: fn(),
    canStopAgent: () => true,
  },
  decorators: [
    (Story) => (
      <StoryQueryRouter>
        <Story />
      </StoryQueryRouter>
    ),
  ],
} satisfies Meta<typeof AgentResourceRow>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RunningAgent: Story = {
  render: function Example(args) {
    const [stopped, setStopped] = useState(false);
    return (
      <AgentResourceRow
        {...args}
        child={
          stopped ? { ...args.child, busy: false, current_task_status: "cancelled" } : args.child
        }
        onStopAgent={async () => setStopped(true)}
      />
    );
  },
};
