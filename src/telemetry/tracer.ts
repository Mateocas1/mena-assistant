import {
  SpanStatusCode,
  trace,
  type Attributes,
  type AttributeValue,
  type Span,
} from "@opentelemetry/api";
import { redactArgs } from "../audit/pii.js";

const TRACER_NAME = "mena-assistant";

export interface TelemetryOptions {
  /** OTLP HTTP endpoint. Unset → tracing stays a no-op (the default). */
  readonly endpoint?: string;
  readonly serviceName?: string;
}

/**
 * Registers an OTLP tracer provider only when an endpoint is configured.
 * Returns the shutdown function; with no endpoint it is a no-op and the process
 * keeps the API's no-op tracer.
 */
export function startTelemetry(options: TelemetryOptions = {}): () => Promise<void> {
  const endpoint = options.endpoint;
  if (!endpoint) return async () => {};

  // Loaded lazily so a process without tracing never pulls the SDK.
  let shutdown: Promise<void> | undefined;

  const ready = (async () => {
    const { BatchSpanProcessor, BasicTracerProvider } =
      await import("@opentelemetry/sdk-trace-base");
    const { resourceFromAttributes } = await import("@opentelemetry/resources");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const { ATTR_SERVICE_NAME } = await import("@opentelemetry/semantic-conventions");

    const provider = new BasicTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: options.serviceName ?? "mena-assistant",
      }),
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: `${endpoint.replace(/\/+$/, "")}/v1/traces` }),
        ),
      ],
    });
    trace.setGlobalTracerProvider(provider);
    return provider;
  })();

  return async () => {
    const provider = await ready;
    shutdown ??= provider.shutdown();
    await shutdown;
    trace.disable();
  };
}

function isAttributeValue(value: unknown): value is AttributeValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

/**
 * Span attributes must never carry client PII, so any structured value goes
 * through the audit redaction and unknown types are dropped.
 */
export function safeAttributes(input: Readonly<Record<string, unknown>>): Attributes {
  const redacted = redactArgs(input);
  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(redacted)) {
    if (value === undefined || value === null) continue;
    attributes[key] = isAttributeValue(value) ? value : JSON.stringify(value);
  }
  return attributes;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs `fn` inside a span; a no-op tracer is used when tracing is off. */
export async function withSpan<T>(
  name: string,
  attributes: Readonly<Record<string, unknown>>,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return await tracer.startActiveSpan(
    name,
    { attributes: safeAttributes(attributes) },
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        span.recordException(error instanceof Error ? error : messageOf(error));
        span.setStatus({ code: SpanStatusCode.ERROR, message: messageOf(error) });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
