// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import { describe, expect, it } from "vitest";
import {
  canonicalSessionImages,
  isAllowedRemoteImageSource,
  parseSessionFileSource,
} from "./remoteImagePolicy";

const path = "/v1/sessions/source/resources/files/file-one/content";
const config = { origin: "https://triune.test", basePath: "/omnigent" };
describe("canonical session file routes", () => {
  it.each([path, `/omnigent${path}`, `https://triune.test/omnigent${path}`])(
    "normalizes exact routes: %s",
    (source) => {
      expect(parseSessionFileSource(source, config)).toEqual({
        sessionId: "source",
        fileId: "file-one",
        path,
      });
    },
  );
  it.each([
    `https://elsewhere.test/omnigent${path}`,
    `https://triune.test.evil/omnigent${path}`,
    `https://user:secret@triune.test/omnigent${path}`,
    `https://triune.test${path}`,
    `//triune.test/omnigent${path}`,
    `/omnigent-lookalike${path}`,
    `/omnigent/omnigent${path}`,
    `${path}?download=true`,
    `${path}#hash`,
    `${path}?`,
    `${path}#`,
    `${path}/`,
    `${path}/../content`,
    `https://triune.test/omnigent/../omnigent${path}`,
    path.replace("source", "%73ource"),
    path.replace("source", "%2F"),
    path.replace("source", "%252f"),
    path.replace("source", "%ZZ"),
    path.replace("file-one", ".."),
    path.replace("file-one", "%00"),
    path.replace("file-one", "file\\one"),
    "/v1/sessions/source/screenshot.png",
    "/favicon.ico",
    "/private-image.png",
    "blob:untrusted",
    "data:image/png;base64,AA==",
  ])("rejects ambiguous or unauthorized routes: %s", (source) => {
    expect(parseSessionFileSource(source, config)).toBeNull();
  });
  it("accepts the exact current origin at a root deployment", () => {
    expect(
      parseSessionFileSource(`https://triune.test${path}`, { ...config, basePath: "" })?.path,
    ).toBe(path);
  });
  it("changes only current-session image identities before hardening", () => {
    const foreign = path.replace("source", "other-chat");
    const tree = {
      type: "root",
      children: [
        { type: "image", url: path },
        { type: "image", url: foreign },
        { type: "image", url: "/arbitrary.png" },
      ],
    };
    canonicalSessionImages({ sessionId: "source" })(tree);
    expect(tree.children.map((node) => node.url)).toEqual([path, foreign, "/arbitrary.png"]);
  });
  it("keeps the remote allowlist exact", () => {
    const allowed =
      "https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc";
    expect(isAllowedRemoteImageSource(allowed)).toBe(true);
    expect(isAllowedRemoteImageSource(`${allowed}?tracking=1`)).toBe(false);
    expect(isAllowedRemoteImageSource("https://triune.test/image.png")).toBe(false);
  });
});
