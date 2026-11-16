// Modified for Triune.
import { useEffect, useRef, useState, type RefObject } from "react";

/** Roll back rejected URLs so the same destination can be requested again. */
export function useAcceptedConversationRoute({
  active,
  conversationId,
  href,
  scopeKey,
  skip,
  accept,
  onAccepted,
  navigate,
  onError,
  onRejected,
}: {
  active: boolean;
  conversationId?: string;
  href: string;
  scopeKey: string;
  skip: RefObject<string | null>;
  accept: (id: string) => Promise<boolean>;
  onAccepted: (id: string) => void;
  navigate: (url: string, options: { replace: boolean }) => void;
  onError: (error: unknown) => void;
  onRejected?: () => void;
}) {
  const lastAccepted = useRef(href);
  const acceptedScope = useRef<string | null>(null);
  const [acceptedHref, setAcceptedHref] = useState<string | null>(null);
  useEffect(() => {
    if (!active || (acceptedScope.current === scopeKey && lastAccepted.current === href)) return;
    let cancelled = false;
    const accepted = () => {
      lastAccepted.current = href;
      acceptedScope.current = scopeKey;
      setAcceptedHref(href);
      if (conversationId) onAccepted(conversationId);
    };
    if (!conversationId || skip.current === conversationId) {
      skip.current = null;
      accepted();
      return;
    }
    skip.current = null;
    void accept(conversationId)
      .then((allowed) => {
        if (cancelled) return;
        if (allowed) accepted();
        else {
          onRejected?.();
          navigate(lastAccepted.current, { replace: true });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        onRejected?.();
        navigate(lastAccepted.current, { replace: true });
        onError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [
    active,
    conversationId,
    href,
    scopeKey,
    skip,
    accept,
    onAccepted,
    navigate,
    onError,
    onRejected,
  ]);
  return acceptedHref;
}

/** Keep search completion attached to its accepted owner and immutable destination. */
export function useConversationOwnerNavigation(options: {
  active: boolean;
  scopeKey: string;
  ownerId: string | null;
  href: string;
  acceptedHref: string | null;
  selectOwner: (id: string) => Promise<boolean>;
  navigate: (path: string) => void;
  onSelected: (id: string) => void;
  onError: (error: unknown) => void;
}) {
  const live = useRef(options);
  live.current = options;
  const generation = useRef(0);
  const [pending, setPending] = useState<{
    id: string;
    path: string;
    source: string;
    scope: string;
    generation: number;
    complete: () => void;
    relevant: () => boolean;
    cancel: () => void;
  } | null>(null);
  useEffect(() => {
    if (!pending) return;
    const current = live.current;
    if (
      !current.active ||
      current.scopeKey !== pending.scope ||
      generation.current !== pending.generation ||
      (current.href !== pending.source && current.href !== pending.path)
    ) {
      setPending(null);
      pending.cancel();
      return;
    }
    if (
      current.ownerId !== pending.id ||
      current.href !== pending.path ||
      current.acceptedHref !== pending.path
    )
      return;
    setPending(null);
    if (!pending.relevant()) {
      pending.cancel();
      return;
    }
    current.onSelected(pending.id);
    pending.complete();
  }, [
    options.active,
    options.scopeKey,
    options.ownerId,
    options.href,
    options.acceptedHref,
    pending,
  ]);
  const select = useRef(
    (
      path: string,
      complete: () => void = () => {},
      relevant: () => boolean = () => true,
      cancel: () => void = () => {},
    ) => {
      const current = live.current;
      const match = path.match(/^\/c\/([^/?#]+)/);
      if (!current.active || !relevant()) return;
      if (!match) {
        current.navigate(path);
        complete();
        return;
      }
      const id = decodeURIComponent(match[1]);
      const request = ++generation.current;
      void current
        .selectOwner(id)
        .then((allowed) => {
          const latest = live.current;
          if (
            !allowed ||
            !latest.active ||
            latest.scopeKey !== current.scopeKey ||
            latest.href !== current.href ||
            generation.current !== request ||
            !relevant()
          ) {
            cancel();
            return;
          }
          setPending({
            id,
            path,
            source: current.href,
            scope: current.scopeKey,
            generation: request,
            complete,
            relevant,
            cancel,
          });
          latest.navigate(path);
        })
        .catch((error) => {
          if (generation.current === request && live.current.scopeKey === current.scopeKey) {
            cancel();
            live.current.onError(error);
          }
        });
    },
  );
  return select.current;
}
