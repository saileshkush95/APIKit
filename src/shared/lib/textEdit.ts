// Editing a text field the way the browser can undo.
//
// Computing the next value and handing it to React replaces the field's value
// behind the browser's back, which discards its undo history — so Tab, an
// auto-closed bracket or an accepted completion left Cmd+Z with nothing to do,
// even though plain typing undid fine. That is the worst kind of inconsistency:
// undo appears to work until the moment you need it.
//
// `execCommand` is deprecated and is still the only way to edit a field *as if
// typed*: the change lands on the native undo stack and fires `input`, so React
// picks it up through the usual onChange. Everything here reports whether it
// worked, because a caller that cannot edit through the field has to fall back
// to writing the value itself — losing the undo step but not the edit.

type TextField = HTMLInputElement | HTMLTextAreaElement;

/**
 * Replaces the text in `[from, to)` with `text`, as if the user had typed it.
 *
 * Returns false when the browser declines, which is the caller's signal to
 * write the value directly instead.
 */
export function typeInto(
  element: TextField | null | undefined,
  text: string,
  from: number,
  to: number,
): boolean {
  if (!element) return false;
  try {
    element.focus();
    element.setSelectionRange(from, to);
    if (text === "") {
      // Nothing to insert and nothing selected is not a deletion; asking for
      // one anyway would eat the character before the caret.
      if (from === to) return true;
      return document.execCommand("delete");
    }
    return document.execCommand("insertText", false, text);
  } catch {
    return false;
  }
}

/**
 * Replaces the whole value as one undoable step.
 *
 * For the actions that rewrite everything — formatting a body, converting
 * between body types. Selecting all and inserting keeps it to a single Cmd+Z
 * rather than leaving no way back at all.
 */
export function replaceAll(
  element: TextField | null | undefined,
  text: string,
): boolean {
  if (!element) return false;
  return typeInto(element, text, 0, element.value.length);
}
