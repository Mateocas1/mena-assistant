export interface StreamedMessageOptions {
  readonly send: (text: string) => Promise<unknown>;
  readonly edit: (text: string) => Promise<unknown>;
  /** Telegram rate-limits edits; one per second per chat is safe. */
  readonly intervalMs?: number;
  /** Do not open a message for a couple of characters. */
  readonly minChars?: number;
}

export interface StreamedMessage {
  /** The reply so far (the whole text, not a delta). */
  update(text: string): void;
  /** Shows the final text: edits the streamed message, or sends it if none exists. */
  finish(text: string): Promise<void>;
}

/**
 * Shows a reply while the model is still writing it: the first chunk opens a
 * message and later chunks edit it, throttled. Failed sends and edits are
 * ignored; `finish` always leaves the final text on screen.
 */
export function createStreamedMessage(options: StreamedMessageOptions): StreamedMessage {
  const intervalMs = options.intervalMs ?? 1_000;
  const minChars = options.minChars ?? 20;
  let opened: Promise<boolean> | undefined;
  let shown = "";
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastEdit = 0;

  const flush = async (): Promise<void> => {
    timer = undefined;
    if (!(await opened) || pending === shown) return;
    const text = pending;
    lastEdit = Date.now();
    try {
      await options.edit(text);
      shown = text;
    } catch {
      // A failed intermediate edit is harmless: the next one or finish() fixes it.
    }
  };

  return {
    update(text) {
      pending = text;
      if (!opened) {
        if (text.trim().length < minChars) return;
        shown = text;
        lastEdit = Date.now();
        opened = options.send(text).then(
          () => true,
          () => false,
        );
        return;
      }
      if (timer) return;
      const wait = Math.max(0, intervalMs - (Date.now() - lastEdit));
      timer = setTimeout(() => void flush(), wait);
    },
    async finish(text) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (opened && (await opened)) {
        if (text === shown) return;
        try {
          await options.edit(text);
          return;
        } catch {
          // The streamed message could not be edited: send the final text instead.
        }
      }
      await options.send(text);
    },
  };
}
