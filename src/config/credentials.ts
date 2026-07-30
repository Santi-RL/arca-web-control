import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { ArcaCredentials } from "../types.js";
import { isValidCuit } from "../jobs/schema.js";

const execFileAsync = promisify(execFile);
const credentialProviderTimeoutMs = 15_000;

export type CredentialReference = {
  issuerKey: string;
  displayName: string;
  cuit: string;
  storageVersion: number;
};

type CredentialPayload = CredentialReference & { clave: string };

type CredentialCommandFailure = Error & {
  stderr?: string;
  code?: string | number | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
};

export function loadWindowsCredential(issuerKey: string): ArcaCredentials {
  if (process.platform !== "win32") throw new Error("El proveedor windows requiere Windows.");
  const script = path.resolve("scripts", "windows-credential.ps1");
  const result = spawnSync(windowsPowerShellExecutable(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "get", issuerKey], {
    encoding: "utf8",
    windowsHide: true,
    timeout: credentialProviderTimeoutMs,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw credentialCommandError(result.error);
  if (result.status !== 0) {
    throw new Error((result.stderr || `No existe una credencial para ${issuerKey}.`).trim());
  }
  return parseCredentialPayload(result.stdout);
}

export async function loadWindowsCredentialAsync(issuerKey: string): Promise<ArcaCredentials> {
  if (process.platform !== "win32") throw new Error("El proveedor windows requiere Windows.");
  const script = path.resolve("scripts", "windows-credential.ps1");
  let stdout: string;
  try {
    const result = await execFileAsync(windowsPowerShellExecutable(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "get", issuerKey], {
      encoding: "utf8",
      windowsHide: true,
      timeout: credentialProviderTimeoutMs,
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    throw mapWindowsCredentialReadError(error, issuerKey);
  }
  return parseCredentialPayload(stdout);
}

export function mapWindowsCredentialReadError(error: unknown, issuerKey: string): Error {
  const failure = asCredentialCommandFailure(error);
  if (isCredentialProviderTimeout(failure)) return credentialCommandError(failure);
  if (typeof failure.code !== "number" || failure.killed) return credentialCommandError(failure);
  return new Error((failure.stderr || `No existe una credencial para ${issuerKey}.`).trim());
}

export function resolveWindowsCredential(selector: string): CredentialReference {
  return parseCredentialReference(runWindowsCredentialJson<CredentialReference>("resolve", selector));
}

export function saveWindowsCredentialFromJson(payload: { issuerKey: string; displayName?: string; cuit: string; clave: string }): void {
  const normalized = normalizeCredentialWriteInput(payload);
  const script = path.resolve("scripts", "windows-credential.ps1");
  const result = spawnSync(windowsPowerShellExecutable(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "set-json"], {
    input: JSON.stringify(normalized),
    encoding: "utf8",
    windowsHide: true,
    timeout: credentialProviderTimeoutMs,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw credentialCommandError(result.error);
  if (result.status !== 0) throw new Error((result.stderr || "No se pudo guardar la credencial.").trim());
}

function runWindowsCredentialJson<T>(operation: string, selector: string): T {
  if (process.platform !== "win32") throw new Error("El proveedor windows requiere Windows.");
  const script = path.resolve("scripts", "windows-credential.ps1");
  const result = spawnSync(windowsPowerShellExecutable(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, operation, selector], {
    encoding: "utf8",
    windowsHide: true,
    timeout: credentialProviderTimeoutMs,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw credentialCommandError(result.error);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `No se pudo resolver la credencial ${selector}.`).trim());
  return JSON.parse(result.stdout.trim()) as T;
}

export function parseCredentialReference(value: unknown): CredentialReference {
  if (!value || typeof value !== "object") throw new Error("El almacén devolvió una referencia de credencial inválida.");
  const candidate = value as Partial<CredentialReference>;
  if (!candidate.cuit || !isValidCuit(candidate.cuit) || candidate.issuerKey !== candidate.cuit) {
    throw new Error("El almacén devolvió una identidad de contribuyente inválida.");
  }
  const displayName = assertSafeDisplayName(candidate.displayName);
  if (!Number.isInteger(candidate.storageVersion) || ![1, 2].includes(candidate.storageVersion as number)) {
    throw new Error("La credencial usa una versión de almacenamiento desconocida.");
  }
  return {
    issuerKey: candidate.cuit,
    cuit: candidate.cuit,
    displayName,
    storageVersion: candidate.storageVersion as number,
  };
}

function parseCredentialPayload(value: string): ArcaCredentials {
  const raw = JSON.parse(value.trim()) as CredentialPayload;
  const parsed = parseCredentialReference(raw);
  if (!raw.clave) throw new Error("El almacén devolvió una credencial sin clave fiscal.");
  return { issuerKey: parsed.cuit, displayName: parsed.displayName, cuit: parsed.cuit, clave: raw.clave };
}

export function normalizeCredentialWriteInput(payload: { issuerKey: string; displayName?: string; cuit: string; clave: string }): { issuerKey: string; displayName: string; cuit: string; clave: string } {
  const cuit = payload.cuit.replace(/\D/g, "");
  const displayName = assertSafeDisplayName(payload.displayName ?? payload.issuerKey);
  if (!isValidCuit(cuit)) throw new Error("No se puede guardar una credencial con CUIT inválido.");
  if (!displayName) throw new Error("El nombre descriptivo no puede estar vacío.");
  if (!payload.clave) throw new Error("La clave fiscal no puede estar vacía.");
  return { issuerKey: cuit, displayName, cuit, clave: payload.clave };
}

function windowsPowerShellExecutable(): string {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function credentialCommandError(error: CredentialCommandFailure): Error {
  if (isCredentialProviderTimeout(error)) {
    return new Error("El proveedor de credenciales de Windows no respondió dentro del plazo seguro.");
  }
  return new Error("No se pudo ejecutar el proveedor de credenciales de Windows.");
}

function isCredentialProviderTimeout(error: CredentialCommandFailure): boolean {
  if (error.code === "ETIMEDOUT") return true;
  return error.killed === true && error.code == null && typeof error.signal === "string";
}

function asCredentialCommandFailure(error: unknown): CredentialCommandFailure {
  if (error instanceof Error) return error as CredentialCommandFailure;
  return new Error("Fallo desconocido del proveedor de credenciales.") as CredentialCommandFailure;
}

function assertSafeDisplayName(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (!normalized || Array.from(normalized).length > 200 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(normalized)) {
    throw new Error("La credencial no tiene un nombre descriptivo seguro.");
  }
  return normalized;
}
