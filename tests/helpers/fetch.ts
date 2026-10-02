/** Shared scripted fetch for HTTP adapter tests: no network, full recording. */
export type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

export interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: unknown;
}

export class ScriptedFetch {
  readonly calls: RecordedCall[] = [];
  private readonly handlers: FetchHandler[];

  constructor(handlers: FetchHandler[]) {
    this.handlers = [...handlers];
  }

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const raw = init.body;
    this.calls.push({
      url,
      init,
      body: typeof raw === "string" && raw.length > 0 ? JSON.parse(raw) : undefined,
    });
    const handler = this.handlers.shift();
    if (!handler) throw new Error(`ScriptedFetch has no handler left for ${url}`);
    return await handler(url, init);
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** mena-nails answers failures with sanitized plain text. */
export function textResponse(text: string, status: number): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}
