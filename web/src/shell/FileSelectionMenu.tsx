// Modified for Triune.
import { QuoteDestinationMenu } from "@/components/chat/QuoteDestinationMenu";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { MessageSquarePlusIcon, CornerDownLeftIcon } from "lucide-react";
import { TextSelectionMenu, type TextSelectionAction } from "@/components/chat/TextSelectionMenu";

export const FILE_ANNOTATION_EVENT = "omnigent:ask-file-selection";
export interface FileAnnotation {
  conversationId: string;
  path: string;
  workspaceRoot: string | null;
  workspaceId?: string;
  hostId?: string | null;
  text: string;
}
const ChooseAnnotationChatContext = createContext<(() => void) | undefined>(undefined);
export const FileSelectionContext = createContext<Omit<FileAnnotation, "text"> | null>(null);
export function FileSelectionMenu({
  x,
  y,
  onComment,
  getText,
  onClose,
}: {
  x: number;
  y: number;
  onComment: () => void;
  getText: () => string;
  onClose: () => void;
}) {
  const source = useContext(FileSelectionContext);
  const chooseChat = useContext(ChooseAnnotationChatContext);
  const [quoteText, setQuoteText] = useState<string | null>(null);
  if (source && quoteText)
    return (
      <QuoteDestinationMenu
        x={x}
        y={y}
        source={{
          conversationId: source.conversationId,
          boundaryId: "",
          text: quoteText,
          file: {
            path: source.path,
            workspaceRoot: source.workspaceRoot,
            workspaceId: source.workspaceId,
            hostId: source.hostId,
          },
        }}
        onClose={onClose}
      />
    );
  const actions: TextSelectionAction[] = [];
  if (!source || source.conversationId) {
    actions.push({ label: "Add comment", icon: <MessageSquarePlusIcon />, onSelect: onComment });
  } else if (chooseChat) {
    actions.push({
      label: "Choose chat",
      icon: <MessageSquarePlusIcon />,
      onSelect: () => {
        onComment();
        chooseChat();
      },
    });
  }
  if (source?.conversationId)
    actions.push({
      label: "Ask in chat",
      icon: <CornerDownLeftIcon />,
      onSelect: () => {
        const text = getText();
        if (text.trim())
          window.dispatchEvent(
            new CustomEvent<FileAnnotation>(FILE_ANNOTATION_EVENT, {
              detail: { ...source, text },
            }),
          );
        window.getSelection()?.removeAllRanges();
      },
    });
  if (source)
    actions.push({
      label: "Send to…",
      icon: <CornerDownLeftIcon />,
      closeOnSelect: false,
      onSelect: () => setQuoteText(getText()),
    });
  return (
    <TextSelectionMenu
      x={x}
      y={y}
      actions={actions}
      onClose={onClose}
      data-file-selection-menu
      data-add-comment-btn
    />
  );
}

export function FileSelectionScope({
  value,
  onChooseChat,
  children,
}: {
  value: Omit<FileAnnotation, "text">;
  onChooseChat?: () => void;
  children: ReactNode;
}) {
  const inherited = useContext(FileSelectionContext);
  const inheritedChoice = useContext(ChooseAnnotationChatContext);
  const source = useMemo(
    () =>
      inherited?.conversationId === value.conversationId &&
      inherited?.path === value.path &&
      inherited?.workspaceRoot === value.workspaceRoot &&
      (!value.workspaceId || value.workspaceId === inherited.workspaceId)
        ? { ...inherited, ...value }
        : value,
    [inherited, value],
  );
  return (
    <ChooseAnnotationChatContext.Provider value={onChooseChat ?? inheritedChoice}>
      <FileSelectionContext.Provider value={source}>{children}</FileSelectionContext.Provider>
    </ChooseAnnotationChatContext.Provider>
  );
}
