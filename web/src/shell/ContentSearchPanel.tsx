import { useScrollRestore } from "./useScrollRestore";
import { panelFolderKey, useResourceViewId, useResourceViewState } from "@/lib/panelFolder";
import { TooltipButton } from "@/components/ui/tooltip";
import { isEditorLevel } from "@/lib/permissionsApi";
import { useWorkbenchWorkspace, queryIdentity, resourceBase } from "@/lib/workbenchWorkspace";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FilterIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { authenticatedFetch, getCurrentUserId } from "@/lib/identity";
import { useCanEdit } from "@/hooks/usePermissions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { OperationStatus } from "@/components/ui/loading";
import type { OpenFileOptions } from "./FileViewerContext";
import { cn } from "@/lib/utils";

interface ContentMatch {
  id?: string;
  path: string;
  relative_path?: string;
  line: number;
  column: number;
  text: string;
  match_start: number;
  match_end: number;
  start_byte?: number;
  end_byte?: number;
  sha256?: string | null;
}
interface SearchInput {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  useIgnore: boolean;
  include: string;
  exclude: string;
  folder: string;
  pinned: boolean;
  replacement: string;
  preserveCase: boolean;
}
interface ContentSearchResult {
  matches: ContentMatch[];
  truncated: boolean;
  warning: string | null;
  query: string;
  snapshot: SearchInput;
}
interface ReplacementResult {
  previews?: { id: string; path: string; line: number; before: string; after: string }[];
  errors?: { path: string; error: string }[];
  applied?: string[];
  restored?: string[];
  undo_id?: string | null;
  matches?: number;
}
const searchControllers = new Map<string, AbortController>();
const matchId = (match: ContentMatch) => match.id ?? `${match.path}:${match.line}:${match.column}`;
const searchSignature = (input: SearchInput) =>
  JSON.stringify([
    input.query,
    input.caseSensitive,
    input.regex,
    input.wholeWord,
    input.useIgnore,
    input.include,
    input.exclude,
    input.folder,
  ]);
const defaults = (scope: string): SearchInput => ({
  query: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  useIgnore: true,
  include: "",
  exclude: "",
  folder: scope,
  pinned: false,
  replacement: "",
  preserveCase: false,
});

async function readResponse(response: Response) {
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error || !body) {
    throw new Error(
      (typeof body?.error === "string" ? body.error : body?.error?.message) ||
        (typeof body?.detail === "string" ? body.detail : null) ||
        "Content search is unavailable. Check that the host is online and up to date.",
    );
  }
  return body;
}

function ContentSearchPanelContent({
  viewId: explicitViewId,
  locationControls,
  initialQuery,
  autoFocus,
  conversationId,
  onFileSelect,
  inputRef,
  scope = "",
  replaceOpen = false,
  replaceFocusNonce = 0,
}: {
  viewId?: string;
  locationControls?: ReactNode;
  initialQuery?: string;
  autoFocus?: boolean;
  conversationId: string;
  onFileSelect: (path: string, options?: OpenFileOptions) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  scope?: string;
  replaceOpen?: boolean;
  replaceFocusNonce?: number;
}) {
  const workspace = useWorkbenchWorkspace();
  const identity = queryIdentity(workspace, conversationId);
  const viewId = useResourceViewId(explicitViewId);
  const uiIdentity = panelFolderKey(identity, viewId);
  const queryClient = useQueryClient();
  const sessionCanEdit = useCanEdit(workspace ? "" : conversationId);
  const canEdit = workspace ? isEditorLevel(workspace.permission_level ?? null) : sessionCanEdit;
  const cachedInput = useQuery<SearchInput>({
    queryKey: ["content-search-input", uiIdentity],
    initialData: () => ({ ...defaults(scope), query: initialQuery ?? "" }),
    queryFn: () => ({ ...defaults(scope), query: initialQuery ?? "" }),
    enabled: false,
    gcTime: Infinity,
  });
  const [input, setInput] = useResourceViewState<SearchInput>(
    identity,
    viewId,
    "content-search-input",
    () => ({ ...defaults(scope), ...cachedInput.data }),
  );
  const effectiveFolder = input.pinned ? input.folder : scope;
  const [showFilters, setShowFilters] = useState(false);
  const [showReplace, setShowReplace] = useState(replaceOpen);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useResourceViewState<Set<string>>(
    identity,
    viewId,
    "collapsed-search-results",
    () => new Set(),
  );
  const [preview, setPreview] = useState<{
    result: ReplacementResult;
    matches: ContentMatch[];
    input: SearchInput;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [operationStatus, setOperationStatus] = useState("");
  const undoKey = ["content-search-undo", uiIdentity, getCurrentUserId() ?? "local"];
  const undoState = useQuery<{ id: string; path: string } | null>({
    queryKey: undoKey,
    initialData: null,
    queryFn: () => null,
    enabled: false,
    gcTime: Infinity,
  });
  const undo = undoState.data ?? null;
  const setUndo = (value: { id: string; path: string } | null) =>
    queryClient.setQueryData(undoKey, value);
  const [operationErrors, setOperationErrors] = useState<ReplacementResult["errors"]>([]);
  const replacementRef = useRef<HTMLInputElement>(null);
  const ownInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = inputRef ?? ownInputRef;
  const focusOnMount = useRef(autoFocus === true);
  useEffect(() => {
    if (focusOnMount.current) {
      focusOnMount.current = false;
      searchInputRef.current?.focus();
    }
  }, [searchInputRef]);
  const filtersId = useId();
  const revision = useRef(0);
  const currentInput = { ...input, folder: effectiveFolder };
  const lastSubmittedSignature = useRef("");
  const currentInputRef = useRef(currentInput);
  currentInputRef.current = currentInput;
  const signature = searchSignature(currentInput);
  const searchKey = useMemo(
    () => ["content-search-result", identity, effectiveFolder, ...(viewId ? [signature] : [])],
    [identity, effectiveFolder, signature, viewId],
  );
  const search = useQuery<ContentSearchResult>({
    queryKey: searchKey,
    placeholderData: viewId ? (previous) => previous : undefined,
    enabled: false,
    gcTime: Infinity,
    retry: false,
    queryFn: async () => {
      const snapshot = { ...currentInputRef.current };
      lastSubmittedSignature.current = searchSignature(snapshot);
      const params = new URLSearchParams({
        q: snapshot.query,
        case_sensitive: String(snapshot.caseSensitive),
        regex: String(snapshot.regex),
        whole_word: String(snapshot.wholeWord),
        use_ignore: String(snapshot.useIgnore),
        include: snapshot.include,
        exclude: snapshot.exclude,
        path: snapshot.folder,
      });
      const controllerKey = JSON.stringify(searchKey);
      searchControllers.get(controllerKey)?.abort();
      const controller = new AbortController();
      searchControllers.set(controllerKey, controller);
      const body = await readResponse(
        await authenticatedFetch(
          `${resourceBase(workspace, conversationId)}/environments/default/content-search?${params}`,
          { signal: controller.signal },
        ),
      );
      if (!Array.isArray(body.matches))
        throw new Error("Content search is unavailable. The host returned an invalid result.");
      if (searchControllers.get(controllerKey) === controller)
        searchControllers.delete(controllerKey);
      return { ...body, query: snapshot.query, snapshot };
    },
  });
  const cancelSearch = useCallback(() => {
    searchControllers.get(JSON.stringify(searchKey))?.abort();
    return queryClient.cancelQueries({ queryKey: searchKey, exact: true });
  }, [queryClient, searchKey]);
  async function submitSearch() {
    await cancelSearch();
    return search.refetch();
  }
  const refetchRef = useRef(submitSearch);
  refetchRef.current = submitSearch;
  useEffect(() => {
    queryClient.setQueryData(["content-search-input", uiIdentity], input);
  }, [uiIdentity, input, queryClient]);
  const resultsCurrent = Boolean(
    search.data && searchSignature(search.data.snapshot) === signature && !search.isFetching,
  );
  const previousSignature = useRef(signature);
  useEffect(() => {
    if (signature === previousSignature.current) return;
    previousSignature.current = signature;
    const timer = window.setTimeout(() => {
      if (currentInputRef.current.query.trim() && lastSubmittedSignature.current !== signature)
        void refetchRef.current();
    }, 400);
    return () => window.clearTimeout(timer);
  }, [signature]);
  useEffect(() => {
    setSelected(new Set((search.data?.matches ?? []).filter((match) => match.sha256).map(matchId)));
    setPreview(null);
    revision.current += 1;
  }, [search.data]);
  useEffect(() => {
    setPreview(null);
    revision.current += 1;
  }, [signature, input.replacement, input.preserveCase]);
  useEffect(() => {
    setShowReplace(replaceOpen);
    if (replaceOpen && autoFocus !== false) {
      const timer = window.setTimeout(() => replacementRef.current?.focus(), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [replaceOpen, replaceFocusNonce, autoFocus]);
  const files = new Map<string, ContentMatch[]>();
  for (const match of search.data?.matches ?? [])
    files.set(match.path, [...(files.get(match.path) ?? []), match]);

  const requestReplacement = useCallback(
    async (action: string, snapshot: SearchInput, matches: ContentMatch[], undoId?: string) => {
      return readResponse(
        await authenticatedFetch(
          `${resourceBase(workspace, conversationId)}/environments/default/content-replace`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action,
              path: snapshot.folder,
              query: snapshot.query,
              regex: snapshot.regex,
              case_sensitive: snapshot.caseSensitive,
              replacement: snapshot.replacement,
              preserve_case: snapshot.preserveCase,
              matches,
              undo_id: undoId,
            }),
          },
        ),
      ) as Promise<ReplacementResult>;
    },
    [conversationId, workspace],
  );
  async function prepare(matches: ContentMatch[]) {
    if (!search.data || busy || !matches.length || !resultsCurrent) return;
    const snapshot = {
      ...search.data.snapshot,
      replacement: input.replacement,
      preserveCase: input.preserveCase,
    };
    const version = ++revision.current;
    setBusy(true);
    setOperationError("");
    setOperationStatus("");
    setOperationErrors([]);
    setPreview(null);
    try {
      const result = await requestReplacement("preview", snapshot, matches);
      if (version === revision.current) setPreview({ result, matches, input: snapshot });
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview || busy) return;
    setBusy(true);
    setOperationError("");
    try {
      const result = await requestReplacement("apply", preview.input, preview.matches);
      setOperationErrors(result.errors ?? []);
      setOperationStatus(
        `Replaced ${result.matches ?? 0} matches in ${result.applied?.length ?? 0} files.`,
      );
      if (result.undo_id) setUndo({ id: result.undo_id, path: preview.input.folder });
      setPreview(null);
      await queryClient.invalidateQueries({ queryKey: ["file-content", identity] });
      await queryClient.invalidateQueries({
        queryKey: ["workspace-changed-files", identity],
      });
      await search.refetch();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function undoReplacement() {
    if (!undo || busy) return;
    setBusy(true);
    setOperationError("");
    try {
      const result = await requestReplacement(
        "undo",
        { ...currentInput, folder: undo.path },
        [],
        undo.id,
      );
      setOperationErrors(result.errors ?? []);
      setOperationStatus(`Restored ${result.restored?.length ?? 0} files.`);
      setUndo(result.undo_id ? { id: result.undo_id, path: undo.path } : null);
      await queryClient.invalidateQueries({ queryKey: ["file-content", identity] });
      await queryClient.invalidateQueries({
        queryKey: ["workspace-changed-files", identity],
      });
      await search.refetch();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollRestore(
    scrollRef,
    uiIdentity ? `content-search:${uiIdentity}` : null,
    search.data !== undefined,
  );
  const update = <K extends keyof SearchInput>(key: K, value: SearchInput[K]) =>
    setInput((previous) => ({ ...previous, [key]: value }));
  const replaceableMatches = (search.data?.matches ?? []).filter((match) => match.sha256);
  const selectedMatches = replaceableMatches.filter((match) => selected.has(matchId(match)));

  return (
    <section
      aria-label="Content search"
      data-context-search-region="explorer"
      className="flex min-h-0 flex-1 flex-col"
    >
      <form
        className="space-y-2 border-b border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (input.query.trim()) void submitSearch();
        }}
      >
        <div className="flex gap-2">
          <div className="flex min-w-0 flex-1">
            <Input
              ref={searchInputRef}
              aria-label="Search file contents"
              placeholder="Search file contents"
              type="search"
              maxLength={4096}
              value={input.query}
              onChange={(event) => update("query", event.target.value)}
              className="rounded-r-none"
            />
            <Button
              type="button"
              variant={input.include.trim() || input.exclude.trim() ? "secondary" : "outline"}
              size="icon"
              aria-label="Filter files"
              aria-expanded={showFilters}
              aria-controls={filtersId}
              title="Include / exclude files"
              onClick={() => setShowFilters((visible) => !visible)}
              className={cn("rounded-l-none border-l-0", showFilters && "bg-muted!")}
            >
              <FilterIcon className="size-4" />
            </Button>
          </div>
          {search.isFetching ? (
            <Button type="button" aria-label="Cancel search" onClick={() => void cancelSearch()}>
              <XIcon className="size-4" />
            </Button>
          ) : (
            <Button type="submit" aria-label="Search" disabled={!input.query.trim()}>
              <SearchIcon className="size-4" />
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-3 text-xs">
          <label className="flex items-center gap-1.5">
            <Checkbox
              checked={input.caseSensitive}
              onCheckedChange={(checked) => update("caseSensitive", checked === true)}
            />
            Match case
          </label>
          <label className="flex items-center gap-1.5">
            <Checkbox
              checked={input.wholeWord}
              onCheckedChange={(checked) => update("wholeWord", checked === true)}
            />
            Whole word
          </label>
          <label className="flex items-center gap-1.5">
            <Checkbox
              checked={input.regex}
              onCheckedChange={(checked) => update("regex", checked === true)}
            />
            Regular expression
          </label>
        </div>
        <div className="flex items-center justify-between gap-2 text-xs">
          {locationControls ?? (
            <span className="truncate" title={effectiveFolder || "Session workspace"}>
              Folder: {effectiveFolder || "Session workspace"}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={showReplace}
            onClick={() => setShowReplace((value) => !value)}
          >
            {showReplace ? "Hide replace" : "Replace"}
          </Button>
        </div>
        {showReplace && (
          <div className="space-y-2">
            <Input
              ref={replacementRef}
              aria-label="Replace with"
              placeholder="Replace with"
              value={input.replacement}
              maxLength={65536}
              onChange={(event) => update("replacement", event.target.value)}
              disabled={!canEdit || busy}
            />
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <label className="flex items-center gap-1.5">
                <Checkbox
                  checked={input.preserveCase}
                  onCheckedChange={(checked) => update("preserveCase", checked === true)}
                />
                Preserve case
              </label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canEdit || busy || !resultsCurrent || selectedMatches.length === 0}
                onClick={() => void prepare(selectedMatches)}
              >
                Preview replacements ({selectedMatches.length})
              </Button>
              {undo && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!canEdit || busy}
                  onClick={() => void undoReplacement()}
                >
                  Undo replacement
                </Button>
              )}
            </div>
            {!canEdit && (
              <p className="text-xs text-muted-foreground">
                Edit permission is required to replace files.
              </p>
            )}
            {input.regex && (
              <p className="text-xs text-muted-foreground">
                Capture groups: $1, $2, $&#123;name&#125;; $$ inserts a dollar sign. Preview before
                applying.
              </p>
            )}
          </div>
        )}
        <div id={filtersId} hidden={!showFilters} className="space-y-2 text-xs">
          <label className="block space-y-1">
            <span>Include</span>
            <Input
              placeholder="e.g. src/**, *.{ts,tsx}"
              maxLength={4096}
              value={input.include}
              onChange={(event) => update("include", event.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span>Exclude</span>
            <Input
              placeholder="e.g. **/tests/**, *.min.js"
              maxLength={4096}
              value={input.exclude}
              onChange={(event) => update("exclude", event.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span>Search folder</span>
            <Input
              placeholder="Session workspace"
              value={effectiveFolder}
              onChange={(event) =>
                setInput((previous) => ({ ...previous, folder: event.target.value, pinned: true }))
              }
            />
          </label>
          <label className="flex items-center gap-1.5">
            <Checkbox
              checked={input.pinned}
              onCheckedChange={(checked) =>
                setInput((previous) => ({
                  ...previous,
                  pinned: checked === true,
                  folder: effectiveFolder,
                }))
              }
            />
            Pin search folder
          </label>
          <label className="flex items-center gap-1.5">
            <Checkbox
              checked={input.useIgnore}
              onCheckedChange={(checked) => update("useIgnore", checked === true)}
            />
            Use ignore files
          </label>
          <p className="text-muted-foreground">Comma-separated globs. Exclude takes precedence.</p>
        </div>
      </form>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto p-2"
        aria-busy={search.isFetching || busy}
      >
        {search.isFetching && <OperationStatus className="flex p-2">Searching…</OperationStatus>}
        {busy && <OperationStatus className="flex p-2">Preparing changes…</OperationStatus>}
        {search.isError && !search.isFetching && (
          <p role="alert" className="p-2 text-sm text-destructive">
            {search.error.message}
          </p>
        )}
        {operationError && (
          <p role="alert" className="p-2 text-sm text-destructive">
            {operationError}
          </p>
        )}
        {operationStatus && (
          <p role="status" className="p-2 text-sm">
            {operationStatus}
          </p>
        )}
        {operationErrors?.map((error) => (
          <p key={error.path} role="alert" className="break-words p-2 text-xs text-destructive">
            {error.path}: {error.error}
          </p>
        ))}
        {preview && (
          <div
            className="mb-3 space-y-2 rounded border border-border p-2"
            aria-label="Replacement preview"
          >
            <p className="text-sm font-semibold">Review replacements</p>
            {preview.result.previews?.map((item, index) => (
              <div key={item.id ?? index} className="break-words font-mono text-xs">
                <span className="text-muted-foreground">
                  {item.path}:{item.line}{" "}
                </span>
                <del className="bg-destructive/10">{item.before}</del>
                {" → "}
                <ins className="bg-green-500/10">{item.after || "(empty)"}</ins>
              </div>
            ))}
            {preview.result.errors?.map((error) => (
              <p key={error.path} role="alert" className="break-words text-xs text-destructive">
                {error.path}: {error.error}
              </p>
            ))}
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy || !preview.result.previews?.length}
                onClick={() => void apply()}
              >
                Apply replacements
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setPreview(null)}>
                Cancel preview
              </Button>
            </div>
          </div>
        )}
        {!search.isFetched && !search.isFetching && (
          <p className="p-2 text-sm text-muted-foreground">
            Type to search file contents, or press Enter.
          </p>
        )}
        {search.isSuccess && (
          <>
            <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
              {showReplace && (
                <Checkbox
                  aria-label="Select all matches"
                  checked={
                    selectedMatches.length === 0
                      ? false
                      : selectedMatches.length === replaceableMatches.length
                        ? true
                        : "indeterminate"
                  }
                  disabled={busy || !replaceableMatches.length}
                  onCheckedChange={(checked) => {
                    setSelected(
                      checked === true ? new Set(replaceableMatches.map(matchId)) : new Set(),
                    );
                    setPreview(null);
                    revision.current += 1;
                  }}
                />
              )}
              <p role="status" className="break-words">
                {search.data.matches.length === 0
                  ? `No matches for “${search.data.query}”.`
                  : `${search.data.matches.length} matches in ${files.size} files for “${search.data.query}”.`}
              </p>
            </div>
            {(search.data.truncated || search.data.warning) && (
              <p role="status" className="p-2 text-xs text-muted-foreground">
                {search.data.warning ||
                  `Showing the first ${search.data.matches.length} matches. Narrow your query for more results.`}
              </p>
            )}
            {[...files].map(([path, matches]) => (
              <div key={path} className="mb-2">
                <div className="flex items-center gap-1 px-1.5">
                  <TooltipButton
                    type="button"
                    aria-label={`${collapsed.has(path) ? "Expand" : "Collapse"} ${path}`}
                    aria-expanded={!collapsed.has(path)}
                    onClick={() =>
                      setCollapsed((previous) => {
                        const next = new Set(previous);
                        if (next.has(path)) next.delete(path);
                        else next.add(path);
                        return next;
                      })
                    }
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left text-xs font-semibold"
                  >
                    {collapsed.has(path) ? (
                      <ChevronRightIcon className="size-3 shrink-0" />
                    ) : (
                      <ChevronDownIcon className="size-3 shrink-0" />
                    )}
                    <FileIcon className="size-4 shrink-0" />
                    <span className="truncate">{path}</span>
                    <span className="text-muted-foreground">({matches.length})</span>
                  </TooltipButton>
                  {showReplace && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Replace matches in ${path}`}
                      disabled={
                        busy ||
                        !canEdit ||
                        !resultsCurrent ||
                        !matches.some((match) => match.sha256)
                      }
                      onClick={() => void prepare(matches.filter((match) => match.sha256))}
                    >
                      Replace file
                    </Button>
                  )}
                </div>
                {!collapsed.has(path) &&
                  matches.map((match) => (
                    <div key={matchId(match)} className="flex items-center">
                      {showReplace && (
                        <Checkbox
                          aria-label={`Select ${path} line ${match.line} column ${match.column}`}
                          checked={selected.has(matchId(match))}
                          disabled={!match.sha256 || busy}
                          onCheckedChange={(checked) => {
                            setSelected((previous) => {
                              const next = new Set(previous);
                              if (checked === true) next.add(matchId(match));
                              else next.delete(matchId(match));
                              return next;
                            });
                            setPreview(null);
                            revision.current += 1;
                          }}
                        />
                      )}
                      <TooltipButton
                        type="button"
                        aria-label={`Open ${path} at line ${match.line}`}
                        onClick={() =>
                          onFileSelect(path, { line: match.line, column: match.column })
                        }
                        className="flex min-w-0 flex-1 cursor-pointer gap-2 rounded px-2 py-1 pl-6 text-left font-mono text-xs hover:bg-muted focus-visible:outline focus-visible:outline-ring"
                      >
                        <span className="shrink-0 text-muted-foreground">{match.line}</span>
                        <span className="min-w-0 truncate whitespace-pre">
                          {match.text.slice(0, match.match_start)}
                          <mark>{match.text.slice(match.match_start, match.match_end)}</mark>
                          {match.text.slice(match.match_end)}
                        </span>
                      </TooltipButton>
                      {showReplace && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Replace ${path} line ${match.line} column ${match.column}`}
                          disabled={busy || !canEdit || !resultsCurrent || !match.sha256}
                          onClick={() => void prepare([match])}
                        >
                          Replace
                        </Button>
                      )}
                    </div>
                  ))}
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

export function ContentSearchPanel(props: Parameters<typeof ContentSearchPanelContent>[0]) {
  const workspace = useWorkbenchWorkspace();
  const viewId = useResourceViewId(props.viewId);
  return (
    <ContentSearchPanelContent
      key={panelFolderKey(queryIdentity(workspace, props.conversationId), viewId)}
      {...props}
    />
  );
}
