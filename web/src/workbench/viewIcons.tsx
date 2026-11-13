// Modified for Triune.
import {
  WorkflowIcon,
  CalendarClockIcon,
  FileIcon,
  FolderIcon,
  GitCompareIcon,
  GitPullRequestIcon,
  GlobeIcon,
  HatGlassesIcon,
  ListIcon,
  MessageSquareIcon,
  SearchIcon,
  TerminalIcon,
} from "lucide-react";

const viewIcons = {
  conversation: MessageSquareIcon,
  files: FolderIcon,
  preview: FileIcon,
  changes: GitCompareIcon,
  search: SearchIcon,
  terminal: TerminalIcon,
  "agent-terminal": HatGlassesIcon,
  activity: WorkflowIcon,
  shells: WorkflowIcon,
  automations: CalendarClockIcon,
  pr: GitPullRequestIcon,
  browser: GlobeIcon,
  logs: ListIcon,
};

export function WorkbenchViewIcon({ kind }: { kind: string }) {
  const Icon = viewIcons[kind as keyof typeof viewIcons] ?? FileIcon;
  return <Icon className="size-4 shrink-0" aria-hidden="true" />;
}
