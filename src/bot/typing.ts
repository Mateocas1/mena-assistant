/**
 * Telegram shows "escribiendo…" for about five seconds per chat action, so the
 * action is renewed until the reply is ready. Failures are swallowed: the
 * indicator is cosmetic and must never block or break the reply.
 */
export function keepTyping(send: () => Promise<unknown>, intervalMs = 4_000): () => void {
  const fire = (): void => {
    send().catch(() => undefined);
  };
  fire();
  const timer = setInterval(fire, intervalMs);
  return () => clearInterval(timer);
}
