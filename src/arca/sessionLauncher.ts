import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

export type SessionWorkerLaunchOptions = {
  scriptPath: string;
  issuer: string;
  productionHidden?: boolean;
  capability?: string;
  revalidationCapability?: string;
};

export function buildSessionWorkerArgs(options: SessionWorkerLaunchOptions): string[] {
  const args = ["--import", "tsx", options.scriptPath, "--issuer", options.issuer];
  if (options.productionHidden) args.push("--production-hidden", "--capability", options.capability ?? "");
  if (options.revalidationCapability) args.push("--revalidate-irreversible", options.revalidationCapability);
  return args;
}
export const sessionLauncherHandoffEnv = "ARCA_SESSION_LAUNCHER_HANDOFF_REQUIRED";

export const sessionShutdownMessage = Object.freeze({ type: "shutdown" } as const);
export const sessionHandoffMessage = Object.freeze({ type: "handoff" } as const);
export const sessionHandoffAckMessage = Object.freeze({ type: "handoff-ack" } as const);

export type SessionPublishedMessage = Readonly<{ type: "session-published"; pid: number }>;

export function createSessionPublishedMessage(pid: number): SessionPublishedMessage {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("El PID de la sesión publicada es inválido.");
  return Object.freeze({ type: "session-published", pid });
}

export type SessionRuntimeAclVerificationMessage = Readonly<{
  type: "runtime-acl-verified";
  root: string;
  verificationId: string;
}>;

export type SessionRuntimeAclVerificationAckMessage = Readonly<{
  type: "runtime-acl-verified-ack";
  verificationId: string;
}>;

function hasMessageType(message: unknown, type: string): boolean {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === type;
}

export function isSessionShutdownMessage(message: unknown): boolean {
  return hasMessageType(message, sessionShutdownMessage.type);
}

export function isSessionHandoffMessage(message: unknown): boolean {
  return hasMessageType(message, sessionHandoffMessage.type);
}

export function isSessionHandoffAckMessage(message: unknown): boolean {
  return hasMessageType(message, sessionHandoffAckMessage.type);
}

export function isSessionPublishedMessage(message: unknown): message is SessionPublishedMessage {
  if (!hasExactKeys(message, ["type", "pid"])) return false;
  const candidate = message as Record<string, unknown>;
  return candidate.type === "session-published"
    && typeof candidate.pid === "number"
    && Number.isSafeInteger(candidate.pid)
    && candidate.pid > 0;
}

export async function waitForSessionPublished(child: ChildProcess, timeoutMs: number): Promise<number | undefined> {
  if (!child.connected) return undefined;
  return await new Promise<number | undefined>((resolve) => {
    let settled = false;
    const finish = (pid?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onTerminal);
      child.off("disconnect", onTerminal);
      child.off("error", onTerminal);
      resolve(pid);
    };
    const onMessage = (message: unknown) => {
      if (isSessionPublishedMessage(message)) finish(message.pid);
    };
    const onTerminal = () => finish();
    const timer = setTimeout(() => finish(), timeoutMs);
    child.on("message", onMessage);
    child.once("exit", onTerminal);
    child.once("disconnect", onTerminal);
    child.once("error", onTerminal);
  });
}

export async function notifySessionPublished(target: NodeJS.Process, pid: number, timeoutMs = 2_000): Promise<void> {
  if (!target.connected || !target.send) throw new Error("El canal IPC se cerró antes de publicar la sesión.");
  const message = createSessionPublishedMessage(pid);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Timeout publicando la sesión por IPC.")), timeoutMs);
    try {
      target.send?.(message, (error) => finish(error ?? undefined));
    } catch {
      finish(new Error("No se pudo publicar la sesión por IPC."));
    }
  });
}

export async function retrySessionStatus<T>(probe: () => Promise<T | undefined>, timeoutMs = 5_000, retryDelayMs = 100): Promise<T | undefined> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new Error("Los tiempos de sondeo de sesión son inválidos.");
  }
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await probe();
    if (result !== undefined) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(retryDelayMs, remaining)));
  } while (Date.now() < deadline);
  return undefined;
}

export function createSessionRuntimeAclVerificationMessage(root: string, verificationId = randomUUID()): SessionRuntimeAclVerificationMessage {
  if (!path.isAbsolute(root) || root.includes("\0")) throw new Error("La raíz atestiguada del runtime debe ser absoluta.");
  if (!isVerificationId(verificationId)) throw new Error("El identificador de atestación del runtime es inválido.");
  return Object.freeze({ type: "runtime-acl-verified", root, verificationId });
}

export function createSessionRuntimeAclVerificationAckMessage(verificationId: string): SessionRuntimeAclVerificationAckMessage {
  if (!isVerificationId(verificationId)) throw new Error("El identificador de atestación del runtime es inválido.");
  return Object.freeze({ type: "runtime-acl-verified-ack", verificationId });
}

export function isSessionRuntimeAclVerificationMessage(message: unknown): message is SessionRuntimeAclVerificationMessage {
  if (!hasExactKeys(message, ["type", "root", "verificationId"])) return false;
  const candidate = message as Record<string, unknown>;
  return candidate.type === "runtime-acl-verified"
    && typeof candidate.root === "string"
    && path.isAbsolute(candidate.root)
    && !candidate.root.includes("\0")
    && typeof candidate.verificationId === "string"
    && isVerificationId(candidate.verificationId);
}

export function isSessionRuntimeAclVerificationAckMessage(message: unknown, verificationId?: string): message is SessionRuntimeAclVerificationAckMessage {
  if (!hasExactKeys(message, ["type", "verificationId"])) return false;
  const candidate = message as Record<string, unknown>;
  return candidate.type === "runtime-acl-verified-ack"
    && typeof candidate.verificationId === "string"
    && isVerificationId(candidate.verificationId)
    && (verificationId === undefined || candidate.verificationId === verificationId);
}

export async function attestSessionRuntimeToWorker(child: ChildProcess, root: string, timeoutMs = 10_000): Promise<boolean> {
  if (!child.connected || !child.send) return false;
  const message = createSessionRuntimeAclVerificationMessage(root);
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (acknowledged: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onTerminal);
      child.off("disconnect", onTerminal);
      child.off("error", onTerminal);
      resolve(acknowledged);
    };
    const onMessage = (candidate: unknown) => {
      if (isSessionRuntimeAclVerificationAckMessage(candidate, message.verificationId)) finish(true);
    };
    const onTerminal = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.on("message", onMessage);
    child.once("exit", onTerminal);
    child.once("disconnect", onTerminal);
    child.once("error", onTerminal);
    try {
      child.send(message, (error) => { if (error) finish(false); });
    } catch {
      finish(false);
    }
  });
}

export async function waitForSessionRuntimeAclVerification(target: NodeJS.Process, signal: AbortSignal, timeoutMs = 10_000): Promise<SessionRuntimeAclVerificationMessage> {
  if (!target.connected) throw new Error("El worker administrado no recibió un canal IPC del launcher.");
  if (signal.aborted) throw new Error("La atestación del runtime fue cancelada.");
  return await new Promise<SessionRuntimeAclVerificationMessage>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, message?: SessionRuntimeAclVerificationMessage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      target.off("message", onMessage);
      target.off("disconnect", onDisconnect);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(message as SessionRuntimeAclVerificationMessage);
    };
    const onMessage = (message: unknown) => {
      if (!hasMessageType(message, "runtime-acl-verified")) return;
      if (!isSessionRuntimeAclVerificationMessage(message)) {
        finish(new Error("El launcher envió una atestación de runtime inválida."));
        return;
      }
      finish(undefined, message);
    };
    const onDisconnect = () => finish(new Error("El launcher se desconectó antes de atestiguar el runtime privado."));
    const onAbort = () => finish(new Error("La atestación del runtime fue cancelada."));
    const timer = setTimeout(() => finish(new Error("Timeout esperando la atestación del runtime privado.")), timeoutMs);
    target.on("message", onMessage);
    target.once("disconnect", onDisconnect);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function acknowledgeSessionRuntimeAclVerification(target: NodeJS.Process, verificationId: string, timeoutMs = 2_000): Promise<void> {
  if (!target.connected || !target.send) throw new Error("El canal IPC se cerró antes de confirmar la atestación del runtime.");
  const message = createSessionRuntimeAclVerificationAckMessage(verificationId);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Timeout confirmando la atestación del runtime.")), timeoutMs);
    try {
      target.send?.(message, (error) => finish(error ?? undefined));
    } catch {
      finish(new Error("No se pudo confirmar la atestación del runtime."));
    }
  });
}

function hasExactKeys(message: unknown, expected: string[]): message is Record<string, unknown> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return false;
  const keys = Object.keys(message).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function isVerificationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
