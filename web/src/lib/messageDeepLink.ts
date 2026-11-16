// Modified for Triune.
/** Query param for deep-linking to a transcript message. */
export const MESSAGE_QUERY_PARAM = "message";

/**
 * Build a shareable URL for a message in the current session.
 *
 * Preserves the current path and other search params; sets/replaces
 * ``?message=<id>``. Auth is unchanged - the link only encodes location.
 *
 * @param messageId - Stable message id (user ``itemId`` or assistant ``responseId``).
 * @param href - Current location; defaults to ``window.location.href``.
 */
export function buildMessageDeepLink(messageId: string, href?: string): string {
  const url = new URL(href ?? window.location.href);
  url.searchParams.set(MESSAGE_QUERY_PARAM, messageId);
  return url.toString();
}

/**
 * Find the transcript DOM node stamped with ``data-message-id``.
 *
 * @param messageId - The id encoded in ``?message=``.
 */
export function findMessageElement(messageId: string, root: ParentNode = document): Element | null {
  const exact = root.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (exact) return exact;
  return (
    Array.from(root.querySelectorAll<HTMLElement>("[data-message-aliases]")).find((element) => {
      const aliases: unknown = JSON.parse(element.dataset.messageAliases ?? "[]");
      return Array.isArray(aliases) && aliases.includes(messageId);
    }) ?? null
  );
}
