// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { Meta, StoryObj } from "@storybook/react-vite";
import { authenticatedFetch } from "@/lib/identity";
import interactions from "../../../design-system/triune/interactions.json";

interface StoryEntry {
  type: string;
  id: string;
  importPath: string;
  exportName: string;
}

async function loadDirectory() {
  const response = await authenticatedFetch("./index.json");
  if (!response.ok) throw new Error(`Storybook directory returned ${response.status}`);
  const index: { entries: Record<string, StoryEntry> } = await response.json();
  const stories = new Map(
    Object.values(index.entries)
      .filter((entry) => entry.type === "story")
      .map((entry) => [`${entry.importPath}#${entry.exportName}`, entry.id]),
  );
  return {
    rows: interactions.map(({ task, owner, story }) => {
      const id = stories.get(`./src/${story}`);
      if (!id) throw new Error(`No indexed story for ${story}`);
      return { task, owner, id };
    }),
  };
}

const meta = {
  title: "Design review/Start here",
  loaders: [loadDirectory],
} satisfies Meta;

export default meta;

export const Interactions: StoryObj<typeof meta> = {
  render: (_, context) => {
    const { rows } = context.loaded as Awaited<ReturnType<typeof loadDirectory>>;
    return (
      <main className="mx-auto max-w-3xl p-4 text-foreground">
        <h1 className="mb-4 text-lg font-semibold">Review an interaction</h1>
        <ul className="density-list flex flex-col">
          {rows.map(({ task, owner, id }) => (
            <li key={task} className="density-row flex flex-wrap items-baseline justify-between">
              <a href={`./?path=/story/${id}`} target="_top" className="text-primary underline">
                {task}
              </a>
              <code className="text-xs text-muted-foreground">{owner.split("/").at(-1)}</code>
            </li>
          ))}
        </ul>
      </main>
    );
  },
};
