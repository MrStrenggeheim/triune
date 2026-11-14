// Triune changes follow LICENSING.md.
import { describe, expect, it } from "vitest";
import {
  messageInputKind,
  readMessageCommunication,
  type MessageCommunication,
} from "./messageCommunication";

describe("input provenance", () => {
  it.each([
    ["peer", "agent"],
    ["native_agent", "agent"],
    ["system", "system"],
    ["external", "external"],
  ] as const)(
    "accepts %s communication and gives it priority over human flags",
    (kind, expected) => {
      const communication: MessageCommunication = {
        kind,
        message_id: "registered-input",
        destination_conversation_id: "recipient",
        source_title: "Native control",
        delivery_state: "confirmed",
      };
      expect(readMessageCommunication(communication)).toBe(communication);
      expect(messageInputKind(communication, true, true)).toBe(expected);
    },
  );

  it("requires a positive human flag and treats deliberate meta input as System", () => {
    expect(messageInputKind()).toBe("external");
    expect(messageInputKind(undefined, false)).toBe("external");
    expect(messageInputKind(undefined, true)).toBe("human");
    expect(messageInputKind(undefined, false, true)).toBe("system");
    expect(messageInputKind(undefined, true, true)).toBe("system");
  });

  it.each([
    { kind: "user" },
    {
      kind: "system",
      message_id: "",
      destination_conversation_id: "recipient",
      delivery_state: "confirmed",
    },
    {
      kind: "external",
      message_id: "input",
      destination_conversation_id: "",
      delivery_state: "confirmed",
    },
    {
      kind: "system",
      message_id: "input",
      destination_conversation_id: "recipient",
      delivery_state: "confirmed",
      source_title: 42,
    },
  ])("rejects malformed attribution: %j", (value) => {
    expect(readMessageCommunication(value)).toBeUndefined();
  });
});
