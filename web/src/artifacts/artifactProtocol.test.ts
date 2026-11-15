// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { expect, it } from "vitest";
import {
  parseArtifactReference,
  serializeArtifactState,
  splitArtifactMarkdown,
} from "./artifactProtocol";

it("recognizes only complete canonical artifact fences and keeps neighboring prose", () => {
  const parts = splitArtifactMarkdown(
    'Before\n\n```triune-artifact\n{"file_id":"uploaded-id","title":"Chart"}\n```\nAfter',
  );
  expect(parts.map((part) => part.kind)).toEqual(["markdown", "artifact", "markdown"]);
  expect(parts[1]).toMatchObject({ reference: { file_id: "uploaded-id", title: "Chart" } });
  expect(parts[0]).toMatchObject({ text: "Before\n\n" });
  expect(parts[2]).toMatchObject({ text: "After" });
  expect(splitArtifactMarkdown('```triune-artifact\n{"file_id":"uploaded-id"}')).toHaveLength(1);
});

it("leaves ordinary HTML, examples in longer fences and invalid file/path references as code", () => {
  for (const text of [
    "```html\n<script>alert(1)</script>\n```",
    '````md\n```triune-artifact\n{"file_id":"uploaded-id"}\n```\n````',
    '```triune-artifact\n{"path":"/etc/passwd"}\n```',
    '```triune-artifact\n{"file_id":"../../etc/passwd"}\n```',
  ])
    expect(splitArtifactMarkdown(text)).toEqual([{ kind: "markdown", text, offset: 0 }]);
  expect(parseArtifactReference('{"file_id":"id","url":"https://example.test"}')).toBeNull();
});

it("bounds state messages before storing or reflecting untrusted values", () => {
  expect(serializeArtifactState({ count: 2 })).toBe('{"count":2}');
  expect(serializeArtifactState("x".repeat(16384))).toBeNull();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(serializeArtifactState(cycle)).toBeNull();
});
