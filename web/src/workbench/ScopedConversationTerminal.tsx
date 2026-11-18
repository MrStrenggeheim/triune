import { useMemo, useState, type ReactNode } from "react";
import { useSession } from "@/hooks/useSession";
import { isNativeTerminalSession } from "@/lib/nativeCodingAgents";
import { TerminalFirstContextProvider, type TerminalFirstView } from "@/shell/TerminalFirstContext";
import { findAgentTerminal, useTerminals } from "@/hooks/useTerminals";

/** One session-specific switch drives both the view header and existing terminal surface. */
export function ScopedConversationTerminal({
  conversationId,
  children,
  chatOnly = false,
}: {
  conversationId: string;
  children: ReactNode;
  chatOnly?: boolean;
}) {
  const { session } = useSession(conversationId);
  const [view, setView] = useState<TerminalFirstView>("chat");
  const terminalFirst = !chatOnly && session?.labels?.["omnigent.ui"] === "terminal";
  const { terminals } = useTerminals(terminalFirst ? conversationId : null, { workspace: null });
  const terminal = findAgentTerminal(terminals);
  const value = useMemo(
    () => ({
      isClaudeNative: session?.labels?.["omnigent.wrapper"] === "claude-code-native-ui",
      isNativeWrapper: isNativeTerminalSession(session),
      isTerminalFirst: terminalFirst,
      isShellView: false,
      view,
      setView,
      terminalViewKey: null,
      terminalsAvailable: !!terminal,
      terminalStartingUp: terminalFirst && !terminal && session?.terminalPending === true,
    }),
    [session, terminalFirst, view, terminal],
  );
  return <TerminalFirstContextProvider value={value}>{children}</TerminalFirstContextProvider>;
}
