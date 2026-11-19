// Triune additions: PolyForm Noncommercial 1.0.0; see LICENSING.md.
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Schema, type Node as DocumentNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { history, redo, undo } from "@tiptap/pm/history";
import { keymap } from "@tiptap/pm/keymap";
import { baseKeymap } from "@tiptap/pm/commands";
import { inlineMentions, type MentionItem } from "@/lib/composerMentions";
import { ComposerMentionChip } from "./ComposerMentionChip";

const schema = new Schema({
  nodes: {
    doc: { content: "inline*", whitespace: "pre" },
    text: { group: "inline" },
    mention: {
      inline: true,
      group: "inline",
      atom: true,
      toDOM: (node) => ["span", "@" + node.attrs.item.path],
      attrs: { token: {}, item: {} },
    },
  },
});

function documentFor(text: string) {
  const nodes: DocumentNode[] = [];
  let end = 0;
  for (const { start, token, item } of inlineMentions(text)) {
    if (start > end) nodes.push(schema.text(text.slice(end, start)));
    nodes.push(schema.nodes.mention.create({ token, item }));
    end = start + token.length;
  }
  if (end < text.length) nodes.push(schema.text(text.slice(end)));
  return schema.topNodeType.create(null, nodes);
}

function draftText(doc: DocumentNode, position = doc.content.size): string {
  return doc.textBetween(0, position, "", (node) => node.attrs.token);
}

function editorPosition(doc: DocumentNode, offset: number) {
  let position = 0;
  let remaining = offset;
  doc.forEach((node) => {
    if (remaining <= 0) return;
    const length = node.isText ? node.nodeSize : node.attrs.token.length;
    position += node.isText ? Math.min(remaining, length) : 1;
    remaining -= length;
  });
  return position;
}

interface ChipView {
  element: HTMLElement;
  item: MentionItem;
  remove: () => void;
}

/** The native field remains the interface to dictation, completion, quote and draft owners.
 * ProseMirror handles browser editing, atomic selection, clipboard and undo while chips are present. */
export function InlineMentionEditor({
  value,
  label,
  disabled,
  testId,
}: {
  value: string;
  label: string;
  disabled?: boolean;
  testId?: string;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [chips, setChips] = useState<ChipView[]>([]);
  useLayoutEffect(() => {
    const host = mount.current!;
    const field = host.previousElementSibling as HTMLTextAreaElement;
    const views = new Set<ChipView>();
    const restoreCaret = (event?: Event) => {
      event?.preventDefault();
      const { doc } = view.state;
      const selection = TextSelection.create(
        doc,
        editorPosition(doc, field.selectionStart),
        editorPosition(doc, field.selectionEnd),
      );
      if (!selection.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(selection));
      view.focus();
    };
    const view = new EditorView(host, {
      state: EditorState.create({
        doc: documentFor(field.value),
        plugins: [
          history(),
          keymap({
            "Mod-z": undo,
            "Mod-Shift-z": redo,
            "Mod-y": redo,
            Enter: (state, dispatch) => {
              dispatch?.(state.tr.insertText("\n"));
              return true;
            },
          }),
          keymap(baseKeymap),
        ],
      }),
      editable: () => !field.disabled && !field.readOnly,
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "data-inline-mention-editor": "",
        class:
          "[&_img.ProseMirror-separator]:inline composer-input-text min-h-[1lh] max-h-[180px] overflow-y-auto whitespace-pre-wrap break-words text-ui text-foreground outline-none md:min-h-[42px]",
      },
      nodeViews: {
        mention(node, _view, getPos) {
          const element = document.createElement("span");
          element.contentEditable = "false";
          const chip = {
            element,
            item: node.attrs.item,
            remove: () => {
              const pos = getPos();
              if (pos === undefined || !view.editable) return;
              const tr = view.state.tr.delete(pos, pos + 1);
              view.dispatch(tr.setSelection(TextSelection.create(tr.doc, pos)));
              view.focus();
            },
          };
          views.add(chip);
          return {
            dom: element,
            stopEvent: () => true,
            ignoreMutation: () => true,
            destroy: () => {
              views.delete(chip);
            },
          };
        },
      },
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr));
        const { doc, selection } = view.state;
        const next = draftText(doc);
        const changed = field.value !== next;
        if (changed)
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
            field,
            next,
          );
        field.setSelectionRange(
          draftText(doc, selection.from).length,
          draftText(doc, selection.to).length,
        );
        if (changed) field.dispatchEvent(new Event("input", { bubbles: true }));
        if (tr.docChanged) setChips([...views]);
      },
      clipboardTextSerializer: (slice) =>
        slice.content.textBetween(0, slice.content.size, "", (node) => "@" + node.attrs.item.path),
      handlePaste(_view, event) {
        const forwarded = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(forwarded, "clipboardData", { value: event.clipboardData });
        if (!field.dispatchEvent(forwarded)) return true;
        view.dispatch(view.state.tr.insertText(event.clipboardData?.getData("text/plain") ?? ""));
        return true;
      },
      handleDOMEvents: {
        keydown(_, event) {
          if (event.isComposing || event.keyCode === 229) return false;
          const forwarded = new KeyboardEvent("keydown", event);
          if (field.dispatchEvent(forwarded)) return false;
          event.preventDefault();
          return true;
        },
        focus() {
          field.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
          return false;
        },
        blur(_, event) {
          field.dispatchEvent(
            new FocusEvent("focusout", { bubbles: true, relatedTarget: event.relatedTarget }),
          );
          return false;
        },
      },
    });
    viewRef.current = view;
    setChips([...views]);
    field.addEventListener("composer-caret", restoreCaret);
    field.addEventListener("focus", restoreCaret);
    if (field === document.activeElement) restoreCaret();
    return () => {
      const focused = view.hasFocus() || view.dom.contains(document.activeElement);
      const start = field.selectionStart;
      viewRef.current = null;
      field.removeEventListener("composer-caret", restoreCaret);
      field.removeEventListener("focus", restoreCaret);
      view.destroy();
      if (focused)
        queueMicrotask(() => {
          if (field.isConnected && !field.disabled && document.activeElement === document.body) {
            field.focus();
            field.setSelectionRange(start, start);
          }
        });
    };
  }, []);
  useLayoutEffect(() => {
    const view = viewRef.current!;
    if (draftText(view.state.doc) !== value) {
      const doc = documentFor(value);
      view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));
    }
    view.setProps({ editable: () => !disabled });
    view.dom.setAttribute("aria-label", label);
    view.dom.setAttribute("aria-disabled", String(Boolean(disabled)));
    if (testId) view.dom.dataset.testid = testId;
  }, [value, label, disabled, testId]);
  return (
    <div ref={mount}>
      {chips.map((chip, index) =>
        createPortal(
          <ComposerMentionChip item={chip.item} onRemove={chip.remove} />,
          chip.element,
          String(index),
        ),
      )}
    </div>
  );
}
