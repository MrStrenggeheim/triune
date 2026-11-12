// Modified for Triune.
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDndContext,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { Pin, X, PlusIcon } from "lucide-react";
import { TooltipButton } from "@/components/ui/tooltip";
import { OpenViewMenu } from "./OpenViewMenu";
import type { WorkbenchOpenAction } from "./WorkbenchAppBar";
import { Button } from "@/components/ui/button";
import { FileDropSurface } from "@/components/FileDropOverlay";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  clampSplitRatio,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  terminalLayoutGeometry,
  type TerminalDivider,
  type TerminalRect,
} from "@/lib/terminalSplitLayout";
import {
  closeDockView,
  dockPaneForView,
  focusDockPane,
  moveDockView,
  resizeDockSplit,
  sameDockResource,
  selectDockView,
  type DockCloseGuard,
  type DockLayout,
  type DockLayoutUpdate,
  type DockPane,
  type DockPlacement,
  type DockView,
  type SplitEdge,
} from "./dockLayout";
import { WorkbenchViewIcon } from "./viewIcons";
import { projectedDockRect, tabDropTarget, type DockDropTarget } from "./dockDropPlacement";
import "./dockWorkspace.css";

export interface DockViewVisibility {
  visible: boolean;
  focused: boolean;
}

export interface DockWorkspaceProps {
  openActions?: WorkbenchOpenAction[];
  onOpenAction?: (paneId: string, action: WorkbenchOpenAction) => void;
  layout: DockLayout;
  onLayoutChange: (update: DockLayoutUpdate) => void;
  renderView: (view: DockView, state: DockViewVisibility) => ReactNode;
  /** Views in inactive saved layouts remain mounted but hidden. */
  retainedViews?: readonly DockView[];
  /** Changes remount resources at the account/server/client boundary. */
  scopeKey?: string;
  onBeforeClose?: DockCloseGuard;
  /** When supplied, owns the close guard and presentation removal. */
  onCloseView?: (id: string) => boolean | Promise<boolean>;
  pinnedViewIds?: readonly string[];
  onPinView?: (id: string, edge?: SplitEdge) => void;
  onUnpinView?: (id: string) => void;
  /** Explicit placement keeps the current layout owner and existing resources. */
  onOpenConversationAt?: (
    id: string,
    placement: DockPlacement,
  ) => void | boolean | Promise<void | boolean>;
  /** Override responsive measurement, e.g. for a native mobile wrapper. */
  compact?: boolean;
  className?: string;
}

export const CONVERSATION_DRAG_MIME = "application/x-omnigent-conversation";

const edges: SplitEdge[] = ["left", "right", "top", "bottom"];
const fullRect: TerminalRect = { left: 0, top: 0, width: 100, height: 100 };

function rectStyle(rect: TerminalRect, content = false): CSSProperties {
  return {
    left: `${rect.left}%`,
    top: content ? `calc(${rect.top}% + var(--dock-header-height))` : `${rect.top}%`,
    width: `${rect.width}%`,
    height: content
      ? `max(0px, calc(${rect.height}% - var(--dock-header-height)))`
      : `${rect.height}%`,
  };
}

export function DockWorkspace(props: DockWorkspaceProps) {
  return <DockSurface key={props.scopeKey ?? "dock"} {...props} />;
}

function DockSurface(props: DockWorkspaceProps) {
  const { layout, onLayoutChange, renderView, retainedViews = [], pinnedViewIds = [] } = props;
  const prefix = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [measuredCompact, setMeasuredCompact] = useState(false);
  const compact = props.compact ?? measuredCompact;
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const width = root.getBoundingClientRect().width;
      if (width > 0) setMeasuredCompact(width <= 640);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  const [dragging, setDragging] = useState(false);
  const [externalDragging, setExternalDragging] = useState(false);
  const externalDepth = useRef(0);
  const [externalOver, setExternalOver] = useState<DockDropTarget | null>(null);
  const [internalOver, setInternalOver] = useState<DockDropTarget | null>(null);
  const externalViewId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const start = (event: globalThis.DragEvent) => {
      externalViewId.current = undefined;
      if (!event.dataTransfer?.types.includes(CONVERSATION_DRAG_MIME)) return;
      try {
        const payload: unknown = JSON.parse(event.dataTransfer.getData(CONVERSATION_DRAG_MIME));
        if (
          payload &&
          typeof payload === "object" &&
          "id" in payload &&
          typeof payload.id === "string"
        )
          externalViewId.current = latest.current.layout.views.find(
            (view) => view.kind === "conversation" && view.resource.conversationId === payload.id,
          )?.id;
      } catch {
        // Only the validated drop payload can open a conversation.
      }
    };
    const end = () => {
      externalViewId.current = undefined;
      externalDepth.current = 0;
      setExternalDragging(false);
      setExternalOver(null);
    };
    document.addEventListener("dragstart", start);
    document.addEventListener("dragend", end);
    return () => {
      document.removeEventListener("dragstart", start);
      document.removeEventListener("dragend", end);
    };
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState<string[]>([]);
  const pending = useRef(new Set<string>());
  const [resize, setResize] = useState<{
    tree: DockLayout["tree"];
    path: number[];
    ratio: number;
  } | null>(null);
  const resizeRef = useRef(resize);
  const preview =
    resize?.tree === layout.tree ? resizeDockSplit(layout, resize.path, resize.ratio) : layout;
  const geometry =
    preview.tree === null ? { panes: [], dividers: [] } : terminalLayoutGeometry(preview.tree);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const close = async (id: string) => {
    if (pending.current.has(id)) return;
    const view = latest.current.layout.views.find((item) => item.id === id);
    if (!view) return;
    pending.current.add(id);
    setClosing([...pending.current]);
    setError(null);
    try {
      if (latest.current.onCloseView) await latest.current.onCloseView(id);
      else {
        const allowed = !latest.current.onBeforeClose || (await latest.current.onBeforeClose(view));
        if (!allowed || !alive.current) return;
        latest.current.onLayoutChange((current) => {
          const target = current.views.find((item) => item.id === id);
          return target && sameDockResource(view, target) ? closeDockView(current, id) : current;
        });
      }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current.delete(id);
      if (alive.current) setClosing([...pending.current]);
    }
  };

  const dragStartX = useRef<number | null>(null);
  const dragDestination = ({
    active,
    over,
    delta,
  }: DragMoveEvent | DragEndEvent): DockDropTarget | null => {
    const source = active.data.current;
    const destination = over?.data.current;
    if (source?.type !== "dock-tab" || !over || !destination) return null;
    if (destination.type === "dock-drop")
      return { paneId: destination.paneId, edge: destination.edge };
    if (destination.type !== "dock-tab" && destination.type !== "dock-tabbar") return null;
    // Pointer and keyboard drags share the same displayed insertion boundaries.
    const start = active.rect.current.translated;
    const pointer = dragStartX.current;
    const x = pointer !== null ? pointer + delta.x : start ? start.left + start.width / 2 : 0;
    const after = destination.type === "dock-tab" && x >= over.rect.left + over.rect.width / 2;
    return tabDropTarget(destination.paneId, destination.index + (after ? 1 : 0), {
      paneId: source.paneId,
      index: source.index,
    });
  };
  const onDragEnd = (event: DragEndEvent) => {
    setDragging(false);
    setInternalOver(null);
    const source = event.active.data.current;
    const destination = dragDestination(event);
    if (!destination || source?.type !== "dock-tab") return;
    onLayoutChange((current) =>
      moveDockView(current, source.viewId, {
        paneId: destination.paneId,
        index: destination.index,
        edge: destination.edge,
      }),
    );
  };

  const acceptsConversation = (event: DragEvent) =>
    !!latest.current.onOpenConversationAt &&
    Array.from(event.dataTransfer.types).includes(CONVERSATION_DRAG_MIME);
  const dropTarget = (event: DragEvent) =>
    event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-conversation-drop-pane]")
      : null;
  const conversationDestination = (event: DragEvent): DockDropTarget | null => {
    const target = dropTarget(event);
    const paneId = target?.dataset.conversationDropPane;
    if (!target || !paneId) return null;
    const edge = target.dataset.edge;
    if (edges.includes(edge as SplitEdge)) return { paneId, edge: edge as SplitEdge };
    const index = target.dataset.conversationDropIndex;
    if (index === undefined) return { paneId };
    const bounds = target.getBoundingClientRect();
    const after =
      target.classList.contains("dock-tab-group") &&
      bounds.width > 0 &&
      event.clientX >= bounds.left + bounds.width / 2;
    const source =
      externalViewId.current && dockPaneForView(latest.current.layout, externalViewId.current);
    return tabDropTarget(
      paneId,
      Number(index) + (after ? 1 : 0),
      source
        ? { paneId: source.id, index: source.viewIds.indexOf(externalViewId.current!) }
        : undefined,
    );
  };
  const openDroppedConversation = async (event: DragEvent) => {
    if (!acceptsConversation(event)) return;
    event.preventDefault();
    event.stopPropagation();
    externalDepth.current = 0;
    setExternalDragging(false);
    setExternalOver(null);
    const destination = conversationDestination(event);
    if (!destination || !latest.current.layout.panes.some((pane) => pane.id === destination.paneId))
      return;
    let payload: unknown;
    try {
      payload = JSON.parse(event.dataTransfer.getData(CONVERSATION_DRAG_MIME));
    } catch {
      return;
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      !("id" in payload) ||
      typeof payload.id !== "string" ||
      !payload.id.trim() ||
      !("title" in payload) ||
      typeof payload.title !== "string"
    )
      return;
    setError(null);
    try {
      await latest.current.onOpenConversationAt?.(payload.id, {
        paneId: destination.paneId,
        ...(destination.edge ? { edge: destination.edge } : {}),
        ...(destination.index !== undefined ? { index: destination.index } : {}),
      });
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const focus = (paneId: string) =>
    latest.current.onLayoutChange((current) => focusDockPane(current, paneId));
  const select = (id: string) => onLayoutChange((current) => selectDockView(current, id));
  const allViews = new Map(retainedViews.map((view) => [view.id, view]));
  for (const view of layout.views) allViews.set(view.id, view);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={(args) => {
        const hits = pointerWithin(args);
        if (args.pointerCoordinates) return hits;
        return closestCenter(args);
      }}
      onDragStart={({ activatorEvent }) => {
        dragStartX.current =
          "clientX" in activatorEvent
            ? Number(activatorEvent.clientX)
            : "touches" in activatorEvent
              ? ((activatorEvent as TouchEvent).touches[0]?.clientX ?? null)
              : null;
        setDragging(true);
      }}
      onDragMove={(event) => setInternalOver(dragDestination(event))}
      onDragOver={(event) => setInternalOver(dragDestination(event))}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setDragging(false);
        setInternalOver(null);
      }}
    >
      <div
        ref={rootRef}
        className={`dock-workspace ${props.className ?? ""}`}
        data-compact={compact}
        onDragEnterCapture={(event) => {
          if (acceptsConversation(event)) {
            externalDepth.current += 1;
            setExternalDragging(true);
          }
        }}
        onDragLeaveCapture={(event) => {
          if (!acceptsConversation(event)) return;
          externalDepth.current = Math.max(0, externalDepth.current - 1);
          if (externalDepth.current) return;
          setExternalDragging(false);
          setExternalOver(null);
        }}
        onDragOverCapture={(event) => {
          if (!acceptsConversation(event)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
          setExternalOver(conversationDestination(event));
        }}
        onDropCapture={(event) => void openDroppedConversation(event)}
        onDragEndCapture={() => {
          externalDepth.current = 0;
          setExternalDragging(false);
          setExternalOver(null);
        }}
      >
        {error && (
          <div role="alert" className="dock-error">
            {error}
            <TooltipButton type="button" onClick={() => setError(null)}>
              Dismiss
            </TooltipButton>
          </div>
        )}
        <div ref={canvasRef} className="dock-canvas">
          {geometry.panes.map((rect) => {
            const pane = layout.panes.find((item) => item.id === rect.key)!;
            const focused = pane.id === layout.focusedPaneId;
            if (compact && !focused) return null;
            return (
              <DockPaneChrome
                key={pane.id}
                prefix={prefix}
                pane={pane}
                layout={layout}
                style={rectStyle(compact ? fullRect : rect)}
                hidden={compact && !focused}
                compact={compact}
                focused={focused}
                dragging={dragging || externalDragging}
                dropTarget={externalOver ?? internalOver}
                pinnedViewIds={pinnedViewIds}
                closing={closing}
                onSelect={select}
                onFocus={() => focus(pane.id)}
                onClose={(id) => void close(id)}
                onLayoutChange={onLayoutChange}
                openActions={props.openActions}
                onOpenAction={props.onOpenAction}
                onPinView={props.onPinView}
                onUnpinView={props.onUnpinView}
              />
            );
          })}
          <div className="dock-surfaces">
            {[...allViews.values()].map((view) => {
              const pane = dockPaneForView(layout, view.id);
              const focused = pane?.id === layout.focusedPaneId;
              const visible = !!pane && pane.selectedViewId === view.id && (!compact || focused);
              const rect = geometry.panes.find((item) => item.key === pane?.id) ?? fullRect;
              return (
                <DockViewSlot
                  key={view.id}
                  id={`${prefix}-view-${view.id}`}
                  view={view}
                  visible={visible}
                  focused={visible && focused}
                  style={rectStyle(compact ? fullRect : rect, true)}
                  bottomEdge={compact || Math.abs(rect.top + rect.height - 100) < 0.001}
                  rightEdge={compact || Math.abs(rect.left + rect.width - 100) < 0.001}
                  onFocus={() => {
                    if (pane) focus(pane.id);
                  }}
                  renderView={renderView}
                />
              );
            })}
          </div>
          {!compact &&
            geometry.dividers.map((divider) => (
              <DockDivider
                key={divider.path.join("/")}
                divider={divider}
                containerRef={canvasRef}
                onResize={(ratio, final) => {
                  if (final)
                    onLayoutChange((current) => resizeDockSplit(current, divider.path, ratio));
                  else {
                    const draft = { tree: layout.tree, path: divider.path, ratio };
                    resizeRef.current = draft;
                    setResize(draft);
                  }
                }}
                onCommit={() => {
                  const draft = resizeRef.current;
                  resizeRef.current = null;
                  setResize(null);
                  if (draft)
                    onLayoutChange((current) =>
                      current.tree === draft.tree
                        ? resizeDockSplit(current, draft.path, draft.ratio)
                        : current,
                    );
                }}
              />
            ))}
          <DockPlacementPreview
            layout={layout}
            target={externalOver ?? internalOver}
            compact={compact}
            external={externalDragging}
            externalViewId={externalViewId.current}
          />
        </div>
      </div>
    </DndContext>
  );
}

/** Every resource has the same parent and key throughout moves, splits and tab changes. */
function DockViewSlot({
  id,
  view,
  visible,
  focused,
  style,
  onFocus,
  renderView,
  bottomEdge,
  rightEdge,
}: {
  id: string;
  view: DockView;
  visible: boolean;
  focused: boolean;
  bottomEdge: boolean;
  rightEdge: boolean;
  style: CSSProperties;
  onFocus: () => void;
  renderView: DockWorkspaceProps["renderView"];
}) {
  const setElement = useCallback(
    (element: HTMLDivElement | null) => {
      element?.toggleAttribute("inert", !visible);
    },
    [visible],
  );
  return (
    <div
      ref={setElement}
      id={id}
      role="tabpanel"
      aria-label={view.title}
      aria-hidden={!visible}
      hidden={!visible}
      className="dock-view-slot"
      data-dock-view={view.id}
      data-dock-bottom-edge={bottomEdge}
      data-dock-right-edge={rightEdge}
      data-focused={focused}
      style={style}
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
    >
      {renderView(view, { visible, focused })}
    </div>
  );
}

function DockPaneChrome({
  prefix,
  pane,
  layout,
  style,
  hidden,
  compact,
  focused,
  dragging,
  dropTarget,
  pinnedViewIds,
  closing,
  onSelect,
  onFocus,
  onClose,
  onLayoutChange,
  onPinView,
  onUnpinView,
  openActions,
  onOpenAction,
}: {
  openActions?: WorkbenchOpenAction[];
  onOpenAction?: (paneId: string, action: WorkbenchOpenAction) => void;
  prefix: string;
  pane: DockPane;
  layout: DockLayout;
  style: CSSProperties;
  hidden: boolean;
  compact: boolean;
  focused: boolean;
  dragging: boolean;
  dropTarget: DockDropTarget | null;
  pinnedViewIds: readonly string[];
  closing: string[];
  onSelect: (id: string) => void;
  onFocus: () => void;
  onClose: (id: string) => void;
  onLayoutChange: DockWorkspaceProps["onLayoutChange"];
  onPinView: DockWorkspaceProps["onPinView"];
  onUnpinView: DockWorkspaceProps["onUnpinView"];
}) {
  const tabs = (compact ? layout.panes : [pane]).flatMap((owner) =>
    owner.viewIds.map((id, index) => ({ id, index, owner })),
  );
  const stripRef = useRef<HTMLDivElement>(null);
  const [overflowRight, setOverflowRight] = useState(false);
  const measureOverflow = useCallback(() => {
    const strip = stripRef.current;
    if (strip) setOverflowRight(strip.scrollWidth - strip.clientWidth - strip.scrollLeft > 1);
  }, []);
  useEffect(() => {
    measureOverflow();
    const observer = new ResizeObserver(measureOverflow);
    const strip = stripRef.current;
    if (strip) {
      observer.observe(strip);
      for (const child of strip.children) observer.observe(child);
    }
    return () => observer.disconnect();
  }, [layout, compact, measureOverflow]);
  return (
    <section
      className="dock-pane"
      data-pane-id={pane.id}
      data-focused={focused}
      style={style}
      hidden={hidden}
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
    >
      <div className="dock-pane-header" data-overflow-right={overflowRight}>
        <div
          ref={stripRef}
          role="tablist"
          aria-label={`Views in ${pane.id}`}
          className="dock-tabs"
          data-conversation-drop-pane={pane.id}
          onScroll={measureOverflow}
        >
          <SortableContext
            items={tabs.map(({ id }) => `view:${id}`)}
            strategy={horizontalListSortingStrategy}
          >
            {tabs.map(({ id, index: tabIndex, owner }) => (
              <Fragment key={id}>
                <DockTab
                  view={layout.views.find((view) => view.id === id)!}
                  pane={owner}
                  selected={pane.selectedViewId === id}
                  index={tabIndex}
                  prefix={prefix}
                  pinned={pinnedViewIds.includes(id)}
                  onSelect={() => onSelect(id)}
                  onClose={() => onClose(id)}
                  onPin={
                    pinnedViewIds.includes(id)
                      ? onUnpinView && (() => onUnpinView(id))
                      : onPinView && (() => onPinView(id))
                  }
                  closing={closing.includes(id)}
                  insertion={dropTarget?.paneId === owner.id && dropTarget.tabIndex === tabIndex}
                  menu={
                    <DockViewMenuItems
                      pane={owner}
                      layout={layout}
                      viewId={id}
                      closing={closing.includes(id)}
                      onClose={() => onClose(id)}
                      onLayoutChange={onLayoutChange}
                      pinned={pinnedViewIds.includes(id)}
                      onPin={
                        pinnedViewIds.includes(id)
                          ? onUnpinView && (() => onUnpinView(id))
                          : onPinView && (() => onPinView(id))
                      }
                    />
                  }
                  onStep={(step, reorder) => {
                    if (reorder)
                      onLayoutChange((current) =>
                        moveDockView(current, id, { paneId: owner.id, index: tabIndex + step }),
                      );
                    else {
                      const target =
                        tabs[
                          (tabs.findIndex((tab) => tab.id === id) + step + tabs.length) %
                            tabs.length
                        ].id;
                      onSelect(target);
                      document.getElementById(`${prefix}-tab-${target}`)?.focus();
                    }
                  }}
                />
                {tabIndex === owner.viewIds.length - 1 && (
                  <DockTabEnd
                    pane={owner}
                    insertion={
                      dropTarget?.paneId === owner.id &&
                      dropTarget.tabIndex === owner.viewIds.length
                    }
                  />
                )}
              </Fragment>
            ))}
            {(compact ? layout.panes : [pane])
              .filter((owner) => owner.viewIds.length === 0)
              .map((owner) => (
                <DockTabEnd
                  key={owner.id}
                  pane={owner}
                  insertion={
                    dropTarget?.paneId === owner.id && dropTarget.tabIndex === owner.viewIds.length
                  }
                />
              ))}
          </SortableContext>
          {openActions && (
            <div className="dock-tab-add">
              <OpenViewMenu
                actions={openActions}
                onSelect={(action) => (onOpenAction ? onOpenAction(pane.id, action) : action.run())}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Add view to pane"
                  className="text-muted-foreground"
                >
                  <PlusIcon className="size-3.5" />
                </Button>
              </OpenViewMenu>
            </div>
          )}
        </div>
      </div>
      {dragging && (
        <div className="dock-drop-overlay">
          <DockDropZone paneId={pane.id} dropTarget={dropTarget} />
          {edges.map((edge) => (
            <DockDropZone key={edge} paneId={pane.id} edge={edge} dropTarget={dropTarget} />
          ))}
        </div>
      )}
    </section>
  );
}

function DockTab({
  view,
  pane,
  index,
  selected,
  prefix,
  pinned,
  onSelect,
  onStep,
  onClose,
  onPin,
  closing,
  insertion,
  menu,
}: {
  view: DockView;
  pane: DockPane;
  index: number;
  selected: boolean;
  prefix: string;
  pinned: boolean;
  onSelect: () => void;
  onStep: (step: number, reorder: boolean) => void;
  onClose: () => void;
  closing: boolean;
  onPin?: () => void;
  insertion: boolean;
  menu: ReactNode;
}) {
  const { active } = useDndContext();
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, isDragging } = useSortable({
    id: `view:${view.id}`,
    data: { type: "dock-tab", viewId: view.id, paneId: pane.id, index },
  });
  const groupRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selected) groupRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selected]);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={!!active}>
        <div
          ref={(node) => {
            groupRef.current = node;
            setNodeRef(node);
          }}
          className="dock-tab-group"
          data-insertion={insertion}
          data-conversation-drop-pane={pane.id}
          data-conversation-drop-index={index}
        >
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            role="tab"
            id={`${prefix}-tab-${view.id}`}
            aria-controls={`${prefix}-view-${view.id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className="dock-tab"
            data-dragging={isDragging}
            onClick={onSelect}
            onKeyDown={(event) => {
              if (!active && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
                event.preventDefault();
                onStep(event.key === "ArrowLeft" ? -1 : 1, event.altKey);
              } else if (
                !active &&
                (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
              ) {
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                event.currentTarget.dispatchEvent(
                  new MouseEvent("contextmenu", {
                    bubbles: true,
                    clientX: bounds.left,
                    clientY: bounds.bottom,
                  }),
                );
              } else listeners?.onKeyDown?.(event);
            }}
          >
            <WorkbenchViewIcon kind={view.kind} />
            <span className="dock-tab-label">{view.title}</span>
          </button>
          {(onPin || pinned) && (
            <TooltipButton
              type="button"
              className="dock-tab-pin"
              aria-label={`${pinned ? "Unpin" : "Pin"} ${view.title}`}
              aria-pressed={pinned}
              disabled={!onPin}
              tooltip={pinned ? "Return to this chat’s layout" : "Keep open across chats"}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onPin?.();
              }}
            >
              <Pin size={14} fill={pinned ? "currentColor" : "none"} />
            </TooltipButton>
          )}
          <button
            type="button"
            className="dock-tab-close"
            aria-label={`Close ${view.title}`}
            disabled={closing}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
          >
            <X size={14} />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>{menu}</ContextMenuContent>
    </ContextMenu>
  );
}

function DockViewMenuItems({
  pane,
  layout,
  viewId,
  closing,
  onClose,
  onLayoutChange,
  pinned,
  onPin,
}: {
  pane: DockPane;
  layout: DockLayout;
  viewId: string;
  closing: boolean;
  onClose: () => void;
  onLayoutChange: DockWorkspaceProps["onLayoutChange"];
  pinned: boolean;
  onPin?: () => void;
}) {
  const index = pane.viewIds.indexOf(viewId);
  const move = (paneId: string, edge?: SplitEdge, targetIndex?: number) =>
    onLayoutChange((current) =>
      moveDockView(current, viewId, { paneId, edge, index: targetIndex }),
    );
  return (
    <>
      <ContextMenuItem disabled={index <= 0} onSelect={() => move(pane.id, undefined, index - 1)}>
        Move tab left
      </ContextMenuItem>
      <ContextMenuItem
        disabled={index === pane.viewIds.length - 1}
        onSelect={() => move(pane.id, undefined, index + 1)}
      >
        Move tab right
      </ContextMenuItem>
      {edges.map((edge) => (
        <ContextMenuItem
          key={edge}
          disabled={pane.viewIds.length < 2}
          onSelect={() => move(pane.id, edge)}
        >
          Split {edge}
        </ContextMenuItem>
      ))}
      {layout.panes
        .filter((target) => target.id !== pane.id)
        .map((target) => (
          <ContextMenuItem key={target.id} onSelect={() => move(target.id)}>
            Move to{" "}
            {layout.views.find((view) => view.id === target.selectedViewId)?.title ?? target.id}
          </ContextMenuItem>
        ))}
      {onPin && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onPin}>
            {pinned ? "Unpin from shared area" : "Keep open across chats"}
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem disabled={closing} onSelect={onClose}>
        Close view
      </ContextMenuItem>
    </>
  );
}

function DockTabEnd({ pane, insertion }: { pane: DockPane; insertion: boolean }) {
  const { setNodeRef } = useDroppable({
    id: `tabbar:${pane.id}`,
    data: { type: "dock-tabbar", paneId: pane.id, index: pane.viewIds.length },
  });
  return (
    <div
      ref={setNodeRef}
      className="dock-tab-end"
      data-insertion={insertion}
      data-conversation-drop-pane={pane.id}
      data-conversation-drop-index={pane.viewIds.length}
    />
  );
}

function DockPlacementPreview({
  layout,
  target,
  compact,
  external,
  externalViewId,
}: {
  layout: DockLayout;
  target: DockDropTarget | null;
  compact: boolean;
  external: boolean;
  externalViewId?: string;
}) {
  const { active } = useDndContext();
  if (!target) return null;
  const rect = compact
    ? fullRect
    : projectedDockRect(layout, target, external ? externalViewId : active?.data.current?.viewId);
  return rect ? (
    <FileDropSurface
      appearance="placement"
      className="dock-placement-preview"
      data-pane-id={target.paneId}
      data-edge={target.edge ?? "center"}
      style={rectStyle(rect)}
      aria-hidden="true"
    />
  ) : null;
}

function DockDropZone({
  paneId,
  edge,
  dropTarget,
}: {
  paneId: string;
  edge?: SplitEdge;
  dropTarget: DockDropTarget | null;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `drop:${paneId}:${edge ?? "center"}`,
    data: { type: "dock-drop", paneId, edge },
  });
  const over =
    isOver ||
    (dropTarget?.paneId === paneId && dropTarget.edge === edge && dropTarget.index === undefined);
  return (
    <div
      ref={setNodeRef}
      className="dock-drop-zone"
      data-conversation-drop-pane={paneId}
      data-edge={edge ?? "center"}
      data-over={over}
    />
  );
}

function DockDivider({
  divider,
  containerRef,
  onResize,
  onCommit,
}: {
  divider: TerminalDivider;
  containerRef: RefObject<HTMLDivElement | null>;
  onResize: (ratio: number, final: boolean) => void;
  onCommit: () => void;
}) {
  const { axis, area, ratio } = divider;
  const [resizing, setResizing] = useState(false);
  const commit = () => {
    setResizing(false);
    onCommit();
  };
  const columns = axis === "columns";
  const offset = columns ? area.left + area.width * ratio : area.top + area.height * ratio;
  return (
    <div
      role="separator"
      aria-label="Resize panes"
      aria-orientation={columns ? "vertical" : "horizontal"}
      aria-valuemin={MIN_SPLIT_RATIO * 100}
      aria-valuemax={MAX_SPLIT_RATIO * 100}
      aria-valuenow={Math.round(ratio * 100)}
      tabIndex={0}
      className="dock-divider"
      data-resizing={resizing}
      style={
        columns
          ? {
              left: `calc(${offset}% - 3px)`,
              top: `${area.top}%`,
              height: `${area.height}%`,
              width: 7,
              cursor: "col-resize",
            }
          : {
              top: `calc(${offset}% - 3px)`,
              left: `${area.left}%`,
              width: `${area.width}%`,
              height: 7,
              cursor: "row-resize",
            }
      }
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setResizing(true);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId) || !containerRef.current)
          return;
        const bounds = containerRef.current.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        const position = columns
          ? ((event.clientX - bounds.left) / bounds.width) * 100
          : ((event.clientY - bounds.top) / bounds.height) * 100;
        onResize(
          clampSplitRatio(
            columns ? (position - area.left) / area.width : (position - area.top) / area.height,
          ),
          false,
        );
      }}
      onPointerUp={commit}
      onPointerCancel={commit}
      onLostPointerCapture={commit}
      onKeyDown={(event) => {
        const step = columns
          ? { ArrowLeft: -1, ArrowRight: 1 }[event.key]
          : { ArrowUp: -1, ArrowDown: 1 }[event.key];
        if (step !== undefined) {
          event.preventDefault();
          onResize(ratio + step * 0.05, true);
        }
      }}
    />
  );
}
