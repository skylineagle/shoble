import { Elysia, StatusMap } from "elysia";

export type RequestLoggerOptions = {
  format?: "auto" | "json" | "pretty";
  skip?: (pathname: string) => boolean;
};

type TimingStore = {
  start: number;
  requestId: string;
};

const timingByRequest = new WeakMap<Request, TimingStore>();

const SENSITIVE_QUERY = /password|token|secret|apikey|api_key|auth|credential/i;

const redactSearch = (search: string): string => {
  if (!search || search === "?") return "";
  const params = new URLSearchParams(search.slice(1));
  for (const key of [...new Set([...params.keys()])]) {
    if (SENSITIVE_QUERY.test(key)) params.set(key, "[REDACTED]");
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
};

const resolvePathForLog = (request: Request, jsonMode: boolean): string => {
  const url = new URL(request.url);
  const pathname = url.pathname;
  if (jsonMode) return pathname;
  const qs = redactSearch(url.search);
  return qs ? `${pathname}${qs}` : pathname;
};

const resolveClientIp = (request: Request): string | undefined => {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return undefined;
};

const resolveHttpStatus = (
  setStatus: number | keyof typeof StatusMap | undefined,
  responseValue: unknown
): number => {
  if (responseValue instanceof Response) return responseValue.status;
  if (typeof setStatus === "number") return setStatus;
  if (setStatus !== undefined && setStatus in StatusMap) {
    return StatusMap[setStatus as keyof typeof StatusMap];
  }
  return 200;
};

const resolveJsonMode = (options: RequestLoggerOptions): boolean => {
  if (options.format === "json") return true;
  if (options.format === "pretty") return false;
  const override = process.env.LOG_FORMAT?.toLowerCase();
  if (override === "json") return true;
  if (override === "pretty") return false;
  return process.env.NODE_ENV === "production";
};

const ansi = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
} as const;

const methodColor = (method: string): string => {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return ansi.cyan;
  if (m === "POST") return ansi.green;
  if (m === "PUT" || m === "PATCH") return ansi.blue;
  if (m === "DELETE") return ansi.red;
  if (m === "OPTIONS") return ansi.magenta;
  return ansi.gray;
};

const statusStyle = (status: number): string => {
  if (status >= 500) return ansi.red + ansi.bold;
  if (status >= 400) return ansi.yellow + ansi.bold;
  if (status >= 300) return ansi.magenta;
  if (status >= 200) return ansi.green;
  return ansi.gray;
};

const formatLocalTime = (): string => {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

const truncateForLog = (s: string, max = 240): string =>
  s.length <= max ? s : `${s.slice(0, max)}…`;

const writePrettyLog = (fields: {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string;
  ip?: string;
  errorMessage?: string;
}) => {
  const { method, path, status, durationMs, requestId, ip, errorMessage } = fields;
  const time = `${ansi.dim}${formatLocalTime()}${ansi.reset}`;
  const m = `${methodColor(method)}${method.padEnd(7)}${ansi.reset}`;
  const s = `${statusStyle(status)}${status}${ansi.reset}`;
  const ms = `${ansi.dim}${durationMs.toFixed(2)}ms${ansi.reset}`;
  const id = `${ansi.dim}${requestId}${ansi.reset}`;
  const ipPart = ip ? ` ${ansi.dim}${ip}${ansi.reset}` : "";
  const errPart = errorMessage ? ` ${ansi.dim}${truncateForLog(errorMessage)}${ansi.reset}` : "";
  console.log(`${time} ${m} ${path} ${s} ${ms} ${id}${ipPart}${errPart}`);
};

const writeJsonLog = (fields: {
  method: string;
  pathname: string;
  queryRedacted?: string;
  status: number;
  durationMs: number;
  requestId: string;
  ip?: string;
  userAgent?: string;
  service?: string;
  errorMessage?: string;
}) => {
  const payload: Record<string, unknown> = {
    level: 30,
    "@timestamp": new Date().toISOString(),
    msg: "http_request",
    event: "http_request",
    method: fields.method,
    path: fields.pathname,
    status: fields.status,
    duration_ms: Number(fields.durationMs.toFixed(3)),
    request_id: fields.requestId,
  };
  if (fields.queryRedacted)
    payload.query = fields.queryRedacted.startsWith("?")
      ? fields.queryRedacted.slice(1)
      : fields.queryRedacted;
  if (fields.ip) payload.client_ip = fields.ip;
  if (fields.userAgent) payload.user_agent = fields.userAgent;
  if (fields.service) payload.service = fields.service;
  if (fields.errorMessage) payload.error_message = truncateForLog(fields.errorMessage, 2000);
  console.log(JSON.stringify(payload));
};

const resolveErrorLogStatus = (
  error: unknown,
  setStatus: number | keyof typeof StatusMap | undefined
): number => {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
  }
  if (typeof setStatus === "number" && setStatus >= 400) return setStatus;
  if (setStatus !== undefined && setStatus in StatusMap) {
    const n = StatusMap[setStatus as keyof typeof StatusMap];
    if (n >= 400) return n;
  }
  return 500;
};

export const requestLogger = (options: RequestLoggerOptions = {}) =>
  new Elysia({ name: "request-logger" })
    .onRequest(({ request }) => {
      const headerId = request.headers.get("x-request-id")?.trim();
      const requestId = headerId && headerId.length > 0 ? headerId : crypto.randomUUID();
      timingByRequest.set(request, {
        start: performance.now(),
        requestId,
      });
    })
    .onError({ as: "global" }, ({ request, error, set }) => {
      const timing = timingByRequest.get(request);
      if (!timing) return;
      const url = new URL(request.url);
      const pathname = url.pathname;
      if (options.skip?.(pathname)) return;
      set.headers["x-request-id"] = timing.requestId;
      const jsonMode = resolveJsonMode(options);
      const pathForLog = resolvePathForLog(request, jsonMode);
      const status = resolveErrorLogStatus(error, set.status);
      const durationMs = performance.now() - timing.start;
      const ip = resolveClientIp(request);
      const userAgent = request.headers.get("user-agent") ?? undefined;
      const service = process.env.SERVICE_NAME;
      const queryRedactedRaw = redactSearch(url.search);
      const queryRedacted =
        queryRedactedRaw && queryRedactedRaw !== "?" ? queryRedactedRaw : undefined;
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (jsonMode) {
        writeJsonLog({
          method: request.method,
          pathname,
          queryRedacted,
          status,
          durationMs,
          requestId: timing.requestId,
          ip,
          userAgent,
          service,
          errorMessage,
        });
      } else {
        writePrettyLog({
          method: request.method,
          path: pathForLog,
          status,
          durationMs,
          requestId: timing.requestId,
          ip,
          errorMessage,
        });
      }
    })
    .mapResponse({ as: "global" }, (ctx) => {
      const { request, set, responseValue } = ctx;
      const timing = timingByRequest.get(request);
      if (!timing) return;
      set.headers["x-request-id"] = timing.requestId;
      const url = new URL(request.url);
      const pathname = url.pathname;
      if (options.skip?.(pathname)) return;

      const jsonMode = resolveJsonMode(options);
      const pathForLog = resolvePathForLog(request, jsonMode);
      const status = resolveHttpStatus(set.status, responseValue);
      const durationMs = performance.now() - timing.start;
      const ip = resolveClientIp(request);
      const userAgent = request.headers.get("user-agent") ?? undefined;
      const service = process.env.SERVICE_NAME;
      const queryRedactedRaw = redactSearch(url.search);
      const queryRedacted =
        queryRedactedRaw && queryRedactedRaw !== "?" ? queryRedactedRaw : undefined;

      if (jsonMode) {
        writeJsonLog({
          method: request.method,
          pathname,
          queryRedacted,
          status,
          durationMs,
          requestId: timing.requestId,
          ip,
          userAgent,
          service,
        });
      } else {
        writePrettyLog({
          method: request.method,
          path: pathForLog,
          status,
          durationMs,
          requestId: timing.requestId,
          ip,
        });
      }
    });
