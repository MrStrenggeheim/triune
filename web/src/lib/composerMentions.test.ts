import { expect, it } from "vitest";
import {
  rankMentionEntries,
  inlineMentionToken,
  inlineMentions,
  deliverInlineMentions,
} from "./composerMentions";

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

it("round trips repeated files and chat links in authored order through draft storage", () => {
  const file = { path: "data/日本 語.csv", isDir: false };
  const chat = {
    path: "First chat",
    isDir: false,
    reference: { version: 2 as const, source_id: "one", source_title: "First chat", url: "/c/one" },
  };
  const draft = `Read ${inlineMentionToken(file)}
${inlineMentionToken(chat)} and ${inlineMentionToken(file)}.`;
  const restored = JSON.parse(JSON.stringify(draft));
  expect(inlineMentions(restored).map(({ item }) => item)).toEqual([file, chat, file]);
  expect(deliverInlineMentions(restored, "codex-native")).toBe(
    "Read [Attached file: data/日本 語.csv]\n/c/one and [Attached file: data/日本 語.csv].",
  );
  expect(deliverInlineMentions("literal \uFFFCinvalid\uFFFC", null)).toBe(
    "literal \uFFFCinvalid\uFFFC",
  );
});
