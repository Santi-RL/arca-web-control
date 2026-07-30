import { ArcaCredentials, RuntimeConfig } from "../types.js";
import { getRuntimePaths } from "./runtimePaths.js";
import { loadWindowsCredential, loadWindowsCredentialAsync, resolveWindowsCredential } from "./credentials.js";
import { isValidCuit } from "../jobs/schema.js";

const officialLoginUrl = "https://auth.afip.gob.ar/contribuyente_/login.xhtml";

export function loadRuntimeConfig(): RuntimeConfig {
  const runtime = getRuntimePaths();
  const headless = (process.env.ARCA_HEADLESS ?? "false").toLowerCase() === "true";
  if (headless) {
    throw new Error("ARCA_HEADLESS=true no está permitido. El modo oculto solo puede habilitarse mediante production-hidden y el manifiesto de capacidad.");
  }
  if (process.env.ARCA_LOGIN_URL) {
    throw new Error("ARCA_LOGIN_URL no está permitido: el login fiscal usa exclusivamente el origen oficial integrado.");
  }
  if (process.env.ARCA_PROFILE_ROOT) {
    throw new Error("ARCA_PROFILE_ROOT no está permitido: los perfiles deben permanecer en el runtime privado de ManejoARCA.");
  }
  return {
    headless: false,
    loginUrl: officialLoginUrl,
    profileRoot: runtime.profiles,
    runtimeRoot: runtime.root,
    browserChannel: parseBrowserChannel(process.env.ARCA_PLAYWRIGHT_CHANNEL),
  };
}

function parseBrowserChannel(value: string | undefined): RuntimeConfig["browserChannel"] {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "chrome" || normalized === "chromium" || normalized === "msedge") return normalized;
  throw new Error("ARCA_PLAYWRIGHT_CHANNEL debe ser chrome, chromium o msedge.");
}

export function loadCredentials(issuerKey: string): ArcaCredentials {
  assertWindowsCredentialProvider();
  return loadWindowsCredential(issuerKey);
}

export async function loadCredentialsAsync(issuerKey: string): Promise<ArcaCredentials> {
  assertWindowsCredentialProvider();
  return await loadWindowsCredentialAsync(issuerKey);
}

export function resolveCredentialIdentity(selector: string): { issuerKey: string; displayName: string; cuit: string } {
  assertWindowsCredentialProvider();
  return resolveWindowsCredential(selector);
}

export function resolveCredentialRoutingIdentity(selector: string): { issuerKey: string; cuit: string } {
  assertWindowsCredentialProvider();
  const cuit = canonicalCuitSelector(selector);
  if (cuit) return { issuerKey: cuit, cuit };
  const identity = resolveCredentialIdentity(selector);
  return { issuerKey: identity.issuerKey, cuit: identity.cuit };
}

export function assertWindowsCredentialProvider(): void {
  const provider = process.env.ARCA_CREDENTIAL_PROVIDER?.trim().toLowerCase();
  if (!provider || provider === "windows") return;
  throw new Error(
    "Los comandos operativos solo admiten credenciales del Administrador de credenciales de Windows. " +
    "Use arca:credentials:migrate-env exclusivamente para migrar y quite ARCA_CREDENTIAL_PROVIDER del entorno.",
  );
}

export function canonicalCuitSelector(selector: string): string | undefined {
  if (!/^\s*[\d.\-\s]+\s*$/.test(selector)) return undefined;
  const cuit = selector.replace(/\D/g, "");
  if (!isValidCuit(cuit)) throw new Error("El selector numérico no contiene un CUIT válido.");
  return cuit;
}
