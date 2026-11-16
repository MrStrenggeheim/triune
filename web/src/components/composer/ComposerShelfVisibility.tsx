// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { EyeIcon, EyeOffIcon, ListTodoIcon, WorkflowIcon } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useWorkbenchActions } from "@/workbench/WorkbenchContext";

type Mode = "auto" | "shown" | "hidden";
interface Presence {
  visible: boolean;
  hasContent: boolean;
  hasPlan: boolean;
}
interface ShelfControl {
  mode: Mode;
  setMode: Dispatch<SetStateAction<Mode>>;
  presence: Presence;
  report: Dispatch<SetStateAction<Presence>>;
  planRequest: number;
  openPlan: () => void;
  onMenuCloseAutoFocus: (event: Event) => void;
}
const ShelfContext = createContext<ShelfControl | null>(null);

/** One provider per retained chat; presentation never modifies recorded activity. */
export function ComposerShelfVisibilityProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>("auto");
  const [presence, report] = useState<Presence>({
    visible: false,
    hasContent: false,
    hasPlan: false,
  });
  const [planRequest, setPlanRequest] = useState(0);
  const pendingPlan = useRef(false);
  const value = useMemo(
    () => ({
      mode,
      setMode,
      presence,
      report,
      planRequest,
      openPlan: () => {
        setMode("shown");
        pendingPlan.current = true;
      },
      onMenuCloseAutoFocus: (event: Event) => {
        if (!pendingPlan.current) return;
        pendingPlan.current = false;
        event.preventDefault();
        setPlanRequest((current) => current + 1);
      },
    }),
    [mode, presence, planRequest],
  );
  return <ShelfContext.Provider value={value}>{children}</ShelfContext.Provider>;
}

/** Transfer focus only after the source menu releases its focus scope. */
export function useComposerShelfMenuCloseAutoFocus() {
  return useContext(ShelfContext)?.onMenuCloseAutoFocus;
}

export function useComposerShelfVisibility({
  conversationId,
  active,
  hasContent,
  hasPlan,
  requiredIds,
}: {
  conversationId: string | null;
  active: boolean;
  hasContent: boolean;
  hasPlan: boolean;
  requiredIds: string[];
}) {
  const control = useContext(ShelfContext);
  const [localMode, setLocalMode] = useState<Mode>("auto");
  const mode = control?.mode ?? localMode;
  const setMode = control?.setMode ?? setLocalMode;
  const requiredKey = JSON.stringify([...requiredIds].sort());
  const previous = useRef({ conversationId, requiredIds });
  useLayoutEffect(() => {
    const next = JSON.parse(requiredKey) as string[];
    if (
      previous.current.conversationId !== conversationId ||
      next.some((id) => !previous.current.requiredIds.includes(id))
    )
      setMode("auto");
    previous.current = { conversationId, requiredIds: next };
  }, [conversationId, requiredKey, setMode]);
  const visible = hasContent && mode !== "hidden" && (mode === "shown" || active);
  const report = control?.report;
  useLayoutEffect(() => {
    report?.((current) =>
      current.visible === visible &&
      current.hasContent === hasContent &&
      current.hasPlan === hasPlan
        ? current
        : { visible, hasContent, hasPlan },
    );
  }, [visible, hasContent, hasPlan, report]);
  return { visible, planRequest: control?.planRequest ?? 0 };
}

/** Insert into the existing chat menu through its workspaceItems slot. */
export function ComposerShelfMenuItems({ conversationId }: { conversationId: string }) {
  const control = useContext(ShelfContext);
  const workbench = useWorkbenchActions();
  if (!control) return null;
  const { presence } = control;
  const Icon = presence.visible ? EyeOffIcon : EyeIcon;
  return (
    <>
      <DropdownMenuItem
        disabled={!presence.hasContent}
        onSelect={() => control.setMode(presence.visible ? "hidden" : "shown")}
      >
        <Icon />
        {presence.visible ? "Hide activity shelf" : "Show activity shelf"}
      </DropdownMenuItem>
      {presence.hasPlan && (
        <DropdownMenuItem onSelect={control.openPlan}>
          <ListTodoIcon />
          Open plan
        </DropdownMenuItem>
      )}
      {workbench && (
        <DropdownMenuItem
          onSelect={() =>
            workbench.openView(
              {
                kind: "activity",
                conversationId,
                source: { kind: "chat", conversationId },
                title: "Orchestration",
              },
              { beside: true },
            )
          }
        >
          <WorkflowIcon />
          Open activity resources
        </DropdownMenuItem>
      )}
    </>
  );
}
