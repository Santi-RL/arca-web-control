import { sanitizeErrorMessage } from "../arca/publicErrors.js";

export const loopbackTimeoutMs = Object.freeze({
  diagnostic: 10_000,
  stop: 10_000,
  mutation: 60_000,
  prepare: 180_000,
  emission: 180_000,
  finish: 120_000,
});

export type LoopbackRequestOptions = {
  label: string;
  timeoutMs: number;
  mutation: boolean;
  init?: Omit<RequestInit, "signal">;
};

export type LoopbackJsonResponse = {
  ok: boolean;
  status: number;
  payload: unknown;
};

export function sessionCommandTimeoutMs(command: unknown): number {
  const type = commandType(command);
  if (["status", "snapshot", "screenshot", "pages", "select-options", "inputs"].includes(type)) {
    return loopbackTimeoutMs.diagnostic;
  }
  if (type === "prepare-invoice") return loopbackTimeoutMs.prepare;
  if (type === "emit-prepared-invoice" || type === "revalidate-prepared-invoice") return loopbackTimeoutMs.emission;
  return loopbackTimeoutMs.mutation;
}

export function learningCommandTimeoutMs(command: unknown): number {
  const type = commandType(command);
  if (type === "status" || type === "inspect") return loopbackTimeoutMs.diagnostic;
  if (type === "finish") return loopbackTimeoutMs.finish;
  if (type === "abort") return loopbackTimeoutMs.stop;
  return loopbackTimeoutMs.mutation;
}

/**
 * Ejecuta exactamente una solicitud al control local y aplica un único plazo
 * a la conexión y al consumo completo del JSON. Nunca reintenta mutaciones.
 */
export async function requestLoopbackJson(
  url: string,
  options: LoopbackRequestOptions,
  fetchImplementation: typeof fetch = fetch,
): Promise<LoopbackJsonResponse> {
  assertLoopbackUrl(url);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("El plazo del control local no es válido.");
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(timeoutError(options));
    }, options.timeoutMs);
  });

  try {
    const request = fetchImplementation(url, { ...options.init, signal: controller.signal });
    const response = await Promise.race([request, deadline]);
    const body = await Promise.race([response.text(), deadline]);
    let payload: unknown = {};
    if (body.trim()) {
      try {
        payload = JSON.parse(body);
      } catch {
        throw new Error(`El control local devolvió una respuesta inválida para ${options.label}.`);
      }
    }
    return {
      ok: response.ok,
      status: response.status,
      payload: response.ok ? payload : sanitizeLoopbackErrorPayload(payload),
    };
  } catch (error) {
    if (timedOut) throw timeoutError(options);
    const detail = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
    const suffix = options.mutation
      ? " La solicitud se intentó una sola vez; el resultado puede ser incierto y no debe reintentarse automáticamente."
      : "";
    throw new Error(`No se pudo completar ${options.label}: ${detail}.${suffix}`.replace(/\.\s*\./g, "."));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function loopbackHttpError(label: string, response: LoopbackJsonResponse): Error {
  const message = extractPublicMessage(response.payload);
  return new Error(message
    ? `El control local rechazó ${label} (HTTP ${response.status}): ${message}`
    : `El control local rechazó ${label} (HTTP ${response.status}).`);
}

function timeoutError(options: LoopbackRequestOptions): Error {
  const suffix = options.mutation
    ? " La solicitud se intentó una sola vez; el resultado puede ser incierto y no debe reintentarse automáticamente."
    : "";
  return new Error(`El control local excedió el plazo para ${options.label}.${suffix}`);
}

function commandType(command: unknown): string {
  if (!command || typeof command !== "object") return "";
  const type = (command as { type?: unknown }).type;
  return typeof type === "string" ? type : "";
}

function assertLoopbackUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("La URL del control local no es válida.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) {
    throw new Error("El control local solo admite HTTP sobre 127.0.0.1 con puerto explícito.");
  }
}

function sanitizeLoopbackErrorPayload(value: unknown): unknown {
  if (typeof value === "string") return sanitizeErrorMessage(value);
  if (Array.isArray(value)) return value.map(sanitizeLoopbackErrorPayload);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    /(?:authorization|cookie|password|clave|secret|token|storage)/i.test(key)
      ? "[redacted]"
      : sanitizeLoopbackErrorPayload(entry),
  ]));
}

function extractPublicMessage(payload: unknown): string | undefined {
  if (typeof payload === "string") return sanitizeErrorMessage(payload);
  if (!payload || typeof payload !== "object") return undefined;
  const message = (payload as { message?: unknown }).message;
  return typeof message === "string" ? sanitizeErrorMessage(message) : undefined;
}
