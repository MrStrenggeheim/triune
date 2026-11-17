// Modified for Triune; inherited notices remain applicable.
// Pick a category icon for a tool-call trigger row. Returns a lucide
// component reference (the trigger row applies sizing classes).
//
// State icons (spinner / error / cancelled) take priority over the
// category icon and are handled in `ToolCard.tsx`; this module is
// only consulted for terminal "completed" tools and for native tools
// (which arrive completed).

import {
  Ban,
  Bot,
  Code2,
  FileSearchCorner,
  FileText,
  Globe,
  Inbox,
  Image,
  ListTodo,
  type LucideIcon,
  Monitor,
  Plug,
  Send,
  Terminal,
  Timer,
  Wrench,
} from "lucide-react";
import { isShellTool, stripOmnigentPrefix, TOOL_CATEGORIES } from "@/lib/toolTitle";

/**
 * @param name - the tool name as it arrives in the call (e.g.
 *   "sys_os_read", "web_search", "my_custom_tool").
 * @param nativeToolType - present only for native (provider-managed)
 *   tools (e.g. "web_search_call"). Takes priority over `name`.
 */
export function iconForTool(name: string, nativeToolType?: string): LucideIcon {
  if (nativeToolType !== undefined) {
    return NATIVE_ICONS[nativeToolType] ?? Wrench;
  }
  const toolName = stripOmnigentPrefix(name);
  const category = TOOL_CATEGORIES[toolName];
  if (category === "read" || category === "edit") return FileText;
  if (category === "list") return FileSearchCorner;
  if (category === "search") return /web/i.test(toolName) ? Globe : FileSearchCorner;
  if (category === "agent") return Bot;
  // Order matters: more specific names (`sys_terminal_close`,
  // `sys_session_close`) must match before the broader category prefix.
  if (isShellTool(toolName)) return Terminal;
  if (/^sys_os_(read|write|edit)$/.test(toolName)) return FileText;
  if (toolName === "sys_terminal_close") return Ban;
  if (toolName.startsWith("sys_terminal_")) return Terminal;
  if (toolName === "sys_session_close") return Ban;
  if (toolName.startsWith("sys_session_")) return Bot;
  if (toolName === "sys_call_async") return Send;
  if (toolName === "sys_read_inbox") return Inbox;
  if (toolName === "list_tasks") return ListTodo;
  if (toolName.startsWith("sys_cancel_")) return Ban;
  if (toolName === "sys_timer_set") return Timer;
  if (toolName === "sys_timer_cancel") return Ban;
  if (toolName === "view_image" || toolName === "generate_image") return Image;
  if (toolName.startsWith("mcp__")) return Plug;
  return Wrench;
}

const NATIVE_ICONS: Record<string, LucideIcon> = {
  web_search_call: Globe,
  file_search_call: FileSearchCorner,
  code_interpreter_call: Code2,
  computer_call: Monitor,
  mcp_call: Plug,
};
