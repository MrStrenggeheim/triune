// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildInventory, packet } from "./review-inventory.mjs";

test("resolves real JSX owners and separates production, indexed story and unknown state", () => {
  const web = fileURLToPath(new URL("../", import.meta.url));
  const src = path.join(web, "src");
  const files = {
    "Subject.tsx": `
      import { memo as remember, forwardRef, type ComponentProps } from "react";
      type Base = ComponentProps<"button"> & {
        tone?: "neutral" | "warm" | "cool";
        orientation?: "vertical" | "horizontal";
        status?: "ready" | "busy";
        compact?: boolean;
      };
      type Props = Base & ({ shape: "round"; outline?: boolean } | { shape: "square" });
      export const Subject = remember(forwardRef<HTMLButtonElement, Props>(
        function Subject({ tone = "neutral", compact = false }, ref) {
          return <button ref={ref} data-tone={tone} data-compact={compact} />;
        }
      ));
      export function Sibling() { return <aside />; }
    `,
    "ReviewBarrel.ts": 'export { Subject as ReExport, Sibling } from "./Subject";',
    "UseSubject.tsx": `
      import { ReExport as Renamed } from "@/ReviewBarrel";
      import * as Widgets from "@/ReviewBarrel";
      import { lazy } from "react";
      const Deferred = lazy(() => import("@/Subject").then(m => ({ default: m.Subject })));
      function Local() { return <Widgets.Sibling />; }
      export function UseSubject({busy, extra}: {busy: boolean; extra: object}) {
        return <><Local /><Renamed shape="round" tone={busy ? "warm" : "cool"} compact disabled />
          <Widgets.ReExport shape="round" tone="warm" {...extra} />
          <Deferred shape="square" /></>;
      }
    `,
    "MoreLocal.tsx": "export function Local() { return <i />; }",
    "ReviewFixtures.ts": 'export const warm = "warm" as const;',
    "Gallery.stories.tsx": `
      import { ReExport as Example, Sibling } from "@/ReviewBarrel";
      import { warm } from "./ReviewFixtures";
      export default { title: "Review/Gallery" };
      function ExampleFixture() { return <Example shape="round" tone={warm} />; }
      export const Round = { render: () => <ExampleFixture /> };
      export const Other = { render: () => <Sibling /> };
      export const Draft = { render: () => <Example shape="square" tone="cool" /> };
    `,
    "Subject.test.tsx":
      'import { ReExport } from "./ReviewBarrel"; const fixture = <ReExport shape="square" />;',
  };
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(web, "tsconfig.app.json"),
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(d) {
        assert.fail(String(d.messageText));
      },
    },
  );
  const host = ts.createCompilerHost(config.options);
  const originalRead = host.readFile;
  const originalExists = host.fileExists;
  const virtual = new Map(
    Object.entries(files).map(([name, text]) => [path.join(src, name), text]),
  );
  host.readFile = (name) => virtual.get(name) ?? originalRead(name);
  host.fileExists = (name) => virtual.has(name) || originalExists(name);
  const program = ts.createProgram([...virtual.keys()], config.options, host);
  const index = new Map([
    ["web/src/Gallery.stories.tsx#Round", { id: "gallery--round", title: "Gallery" }],
  ]);
  const result = buildInventory(index, program);
  const subject = packet(result, "Subject").component;
  assert.deepEqual(subject.wrappers, ["memo", "forwardRef"]);
  assert.deepEqual(Object.keys(subject.variants).sort(), [
    "compact",
    "orientation",
    "outline",
    "shape",
    "status",
    "tone",
  ]);
  assert.equal(subject.variants.outline.optional, true);
  assert.deepEqual(subject.variants.compact.declared, [false, true]);
  assert.equal(subject.variants.tone.default, "neutral");
  assert.deepEqual(subject.variants.tone.used, ["cool", "neutral", "warm"]);
  assert.deepEqual(subject.variants.tone.represented, ["warm"]);
  assert.deepEqual(subject.variants.tone.unrepresented, ["cool", "neutral"]);
  assert.deepEqual(subject.variants.shape.used, ["round", "square"]);
  assert.deepEqual(
    subject.calls.map((c) => c.tag),
    ["Renamed", "Widgets.ReExport", "Deferred"],
  );
  assert.ok(
    subject.calls.every((c) => c.caller === "web/src/UseSubject.tsx#UseSubject" && c.line > 0),
  );
  assert.equal(subject.calls[0].props.find((p) => p.name === "disabled").value, true);
  assert.equal(subject.calls[0].props.find((p) => p.name === "tone").evidence, "conditional");
  assert.equal(subject.calls[1].props.at(-1).kind, "spread");
  assert.deepEqual(subject.tests, ["web/src/Subject.test.tsx"]);
  assert.deepEqual(subject.stories.map((s) => s.export).sort(), ["Draft", "Round"]);
  const round = subject.stories.find((s) => s.export === "Round");
  assert.equal(round.href, "./?path=/story/gallery--round");
  assert.deepEqual(round.fixtures, ["web/src/ReviewFixtures.ts"]);
  assert.equal(subject.stories.find((s) => s.export === "Draft").id, null);
  assert.equal(result.reviewQueue.length, result.components.length);
  assert.throws(() => packet(result, "Local"), /Ambiguous component/);
  assert.deepEqual(packet(result, "web/src/UseSubject.tsx#Local").component.exports, []);
  assert.ok(result.nativeTags.button > 0);
});
