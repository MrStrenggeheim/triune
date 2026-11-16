import { expect, it } from "vitest";
import { rankMentionEntries } from "./composerMentions";

it("ranks exact and prefix relevance across types before folder/name ties, then caps", () => {
  const rows = [
    { name: "my source", type: "chat" },
    { name: "source.txt", type: "file" },
    { name: "source", type: "chat" },
    { name: "source-dir", type: "directory" },
    { name: "unrelated", type: "file" },
  ];
  expect(rankMentionEntries(rows, "source", 3).map((row) => row.name)).toEqual([
    "source",
    "source-dir",
    "source.txt",
  ]);
});
