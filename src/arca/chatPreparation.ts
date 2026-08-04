import type { CurrentSessionState } from "./sessionState.js";

export type ChatPreparationArgs = { revalidationCapability?: string; timeoutMs: number };

export type ChatVisibleSessionStartArgs = {
  scriptPath: string;
  issuerCuit: string;
  timeoutMs: number;
  revalidationCapability?: string;
};

export function parseChatPreparationArgs(values: string[]): ChatPreparationArgs {
  let revalidationCapability: string | undefined;
  let timeoutMs = 180_000;
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    const value = values[index + 1];
    if (flag === "--revalidate-irreversible") {
      if (revalidationCapability !== undefined || !value || value.startsWith("--") || !/^[a-z0-9-]+$/u.test(value)) {
        throw new Error("--revalidate-irreversible exige una única capacidad válida.");
      }
      revalidationCapability = value;
      index += 1;
      continue;
    }
    if (flag === "--timeout-ms") {
      if (!value || value.startsWith("--")) throw new Error("--timeout-ms exige un valor.");
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--timeout-ms inválido.");
      timeoutMs = parsed;
      index += 1;
      continue;
    }
    throw new Error(`Argumento no reconocido: ${flag ?? "(vacío)"}.`);
  }
  return { revalidationCapability, timeoutMs };
}

export function buildChatVisibleSessionStartArgs(input: ChatVisibleSessionStartArgs): string[] {
  const args = [
    "--import",
    "tsx",
    input.scriptPath,
    "--issuer",
    input.issuerCuit,
    "--timeout-ms",
    String(input.timeoutMs),
    "--force-new",
  ];
  if (input.revalidationCapability) args.push("--revalidate-irreversible", input.revalidationCapability);
  return args;
}

export function sessionMetadataMatches(
  current: CurrentSessionState,
  issuerKey: string,
  revalidationCapability?: string,
): boolean {
  return current.issuerKey === issuerKey
    && current.visibilityMode === "visible"
    && !current.learnedCapability
    && current.revalidationCapability === revalidationCapability
    && current.handoffComplete === true;
}

export function sessionStatusIsReusable(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const state = (payload as { state?: unknown }).state;
  if (!state || typeof state !== "object") return false;
  const candidate = state as { readyState?: unknown; captchaVisible?: unknown; revalidationConsumed?: unknown };
  if (candidate.captchaVisible === true || candidate.revalidationConsumed === true || typeof candidate.readyState !== "string") return false;
  return ["portal", "service", "selector_emisor", "rcel_menu"].includes(candidate.readyState);
}

export function sanitizePreparationOutput(payload: Record<string, unknown>): Record<string, unknown> {
  const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : undefined;
  const safeData = data ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== "screenshotPath")) : undefined;
  return {
    ok: payload.ok === true,
    status: payload.ok === true ? "prepared" : payload.status ?? "failed",
    ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    ...(safeData ? { data: safeData } : {}),
  };
}
