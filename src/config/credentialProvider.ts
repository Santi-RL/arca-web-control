import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ArcaCredentials } from "../types.js";
import { isValidCuit } from "../jobs/schema.js";
import { writeJsonAtomic } from "../io/atomicJson.js";
import {
  listWindowsCredentialReferences,
  loadWindowsCredential,
  loadWindowsCredentialAsync,
  type CredentialReference,
} from "./credentials.js";
import {
  formatCredentialCuit,
  lookupCredentialIdentity,
  type CredentialIdentityLookup,
} from "./credentialIdentity.js";
import { ensurePrivateFile, type RuntimePaths } from "./runtimePaths.js";

export type CredentialProviderSelection =
  | { schemaVersion: 1; provider: "windows" }
  | {
      schemaVersion: 1;
      provider: "json-file";
      file: string;
      /** Índice no secreto persistido al seleccionar el archivo. */
      identities?: Array<{ cuit: string; displayName: string }>;
      /** Identidad no secreta del archivo validado al generar el índice. */
      fileIdentity?: string;
    };

export type CredentialProviderErrorCode =
  | "ARCA_CREDENTIAL_NOT_FOUND"
  | "ARCA_CREDENTIAL_AMBIGUOUS"
  | "ARCA_CREDENTIAL_CONFIRMATION_REQUIRED"
  | "ARCA_CREDENTIAL_PROVIDER_UNAVAILABLE";

export class CredentialProviderError extends Error {
  constructor(readonly code: CredentialProviderErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CredentialProviderError";
  }
}

const providerConfigSchema = z.discriminatedUnion("provider", [
  z.object({ schemaVersion: z.literal(1), provider: z.literal("windows") }).strict(),
  z.object({
    schemaVersion: z.literal(1),
    provider: z.literal("json-file"),
    file: z.string().trim().min(1).max(4096),
    identities: z.array(z.object({
      cuit: z.string().regex(/^\d{11}$/u),
      displayName: safeDisplayNameSchema(),
    }).strict()).min(1).max(10_000).optional(),
    fileIdentity: z.string().trim().min(1).max(512).optional(),
  }).strict(),
]);

const jsonCredentialFileSchema = z.object({
  schemaVersion: z.literal(1),
  credentials: z.array(z.object({
    cuit: z.string().trim().min(1).max(32),
    displayName: safeDisplayNameSchema(),
    clave: z.string().min(1).max(1024),
  }).strict()).min(1).max(10_000),
}).strict();

const maximumCredentialFileBytes = 1024 * 1024;
export const sessionCredentialProviderFingerprintEnv = "ARCA_SESSION_EXPECTED_CREDENTIAL_PROVIDER";

function safeDisplayNameSchema(): z.ZodType<string> {
  return z.string().trim().min(1).max(200).refine(
    (value) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value),
    "El nombre descriptivo no puede contener caracteres de control.",
  );
}

export function credentialProviderConfigPath(runtime: RuntimePaths): string {
  return path.join(runtime.config, "credential-provider.json");
}

export function loadCredentialProviderSelection(runtime: RuntimePaths): CredentialProviderSelection {
  const environmentProvider = process.env.ARCA_CREDENTIAL_PROVIDER?.trim().toLowerCase();
  const environmentFile = process.env.ARCA_CREDENTIAL_FILE?.trim();
  if (environmentProvider || environmentFile) {
    // El selector explícito manda. En particular, `windows` no debe quedar
    // inutilizable por una ruta residual de una selección temporal anterior.
    if (environmentProvider === "windows") return { schemaVersion: 1, provider: "windows" };
    if (environmentProvider === "json-file" && environmentFile) {
      return validateProviderSelection({ schemaVersion: 1, provider: "json-file", file: environmentFile });
    }
    throw providerUnavailable("La selección temporal del proveedor de credenciales está incompleta o no es válida.");
  }

  let raw: unknown;
  try {
    const configPath = credentialProviderConfigPath(runtime);
    const stat = fs.lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !samePath(fs.realpathSync(configPath), configPath)) {
      throw new Error("invalid-provider-config");
    }
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, provider: "windows" };
    throw providerUnavailable("No se pudo leer la configuración local del proveedor de credenciales.");
  }
  const selection = validateProviderSelection(raw);
  if (selection.provider === "json-file" && (!selection.identities || !selection.fileIdentity)) {
    throw providerUnavailable("La configuración json-file no contiene su atestación no secreta; volvé a seleccionar el archivo.");
  }
  return selection;
}

export async function saveCredentialProviderSelection(runtime: RuntimePaths, raw: unknown): Promise<CredentialProviderSelection> {
  const requested = validateProviderSelection(raw);
  let selection: CredentialProviderSelection;
  if (requested.provider === "json-file") {
    const identityBefore = externalFileIdentity(requested.file);
    const records = readJsonCredentials(requested.file, identityBefore);
    const identityAfter = externalFileIdentity(requested.file);
    if (identityBefore !== identityAfter) {
      throw providerUnavailable("El archivo de credenciales cambió mientras se generaba su índice local.");
    }
    selection = {
      schemaVersion: 1,
      provider: "json-file",
      file: requested.file,
      identities: records.map(({ cuit, displayName }) => ({ cuit, displayName })),
      fileIdentity: identityAfter,
    };
  } else {
    selection = requested;
  }
  const destination = credentialProviderConfigPath(runtime);
  await writeJsonAtomic(destination, selection);
  await ensurePrivateFile(destination);
  return selection;
}

export function resolveConfiguredCredential(runtime: RuntimePaths, selector: string): CredentialReference {
  const lookup = lookupConfiguredCredentialIdentity(runtime, selector);
  if (lookup.status === "resolved") return lookup.identity;
  if (lookup.status === "invalid_cuit") {
    throw new CredentialProviderError("ARCA_CREDENTIAL_NOT_FOUND", "El selector numérico no contiene un CUIT válido.");
  }
  if (lookup.status === "ambiguous") {
    throw new CredentialProviderError(
      "ARCA_CREDENTIAL_AMBIGUOUS",
      `El nombre coincide con más de un contribuyente. Opciones: ${describeCredentialCandidates(lookup.candidates)}. Indicá el CUIT.`,
    );
  }
  if (lookup.status === "needs_confirmation") {
    throw new CredentialProviderError(
      "ARCA_CREDENTIAL_CONFIRMATION_REQUIRED",
      `No hubo una coincidencia exacta. Posibles emisores: ${describeCredentialCandidates(lookup.candidates)}. Confirmá el correcto o indicá el CUIT.`,
    );
  }
  throw new CredentialProviderError("ARCA_CREDENTIAL_NOT_FOUND", "No existe una credencial para el emisor indicado.");
}

export function lookupConfiguredCredentialIdentity(runtime: RuntimePaths, selector: string): CredentialIdentityLookup {
  return lookupCredentialIdentity(listConfiguredCredentialIdentities(runtime), selector);
}

export function listConfiguredCredentialIdentities(runtime: RuntimePaths): CredentialReference[] {
  const selection = loadCredentialProviderSelection(runtime);
  if (selection.provider === "windows") {
    try {
      return listWindowsCredentialReferences();
    } catch (error) {
      throw classifyWindowsProviderFailure(error, "resolve");
    }
  }
  if (!selection.identities) {
    throw providerUnavailable("La selección temporal json-file no expone un índice no secreto; indicá el emisor por CUIT o guardá primero el proveedor.");
  }
  return selection.identities.map((identity) => ({
    issuerKey: identity.cuit,
    cuit: identity.cuit,
    displayName: identity.displayName,
    storageVersion: 1,
  }));
}

export function loadConfiguredCredential(runtime: RuntimePaths, selector: string, expectedFingerprint?: string): ArcaCredentials {
  const selection = loadCredentialProviderSelection(runtime);
  if (selection.provider === "windows") {
    assertLoadedProviderFingerprint(selection, expectedFingerprint);
    let credential: ArcaCredentials;
    try {
      credential = loadWindowsCredential(selector);
    } catch (error) {
      throw classifyWindowsProviderFailure(error, "load");
    }
    assertProviderStillMatches(runtime, expectedFingerprint);
    return credential;
  }
  const expectedIdentity = selection.fileIdentity ?? externalFileIdentity(selection.file);
  assertLoadedProviderFingerprint(selection, expectedFingerprint, expectedIdentity);
  const credential = loadJsonCredential(selection.file, selector, expectedIdentity);
  assertProviderStillMatches(runtime, expectedFingerprint);
  return credential;
}

export async function loadConfiguredCredentialAsync(runtime: RuntimePaths, selector: string, expectedFingerprint?: string): Promise<ArcaCredentials> {
  const selection = loadCredentialProviderSelection(runtime);
  if (selection.provider === "windows") {
    assertLoadedProviderFingerprint(selection, expectedFingerprint);
    let credential: ArcaCredentials;
    try {
      credential = await loadWindowsCredentialAsync(selector);
    } catch (error) {
      throw classifyWindowsProviderFailure(error, "load");
    }
    assertProviderStillMatches(runtime, expectedFingerprint);
    return credential;
  }
  const expectedIdentity = selection.fileIdentity ?? externalFileIdentity(selection.file);
  assertLoadedProviderFingerprint(selection, expectedFingerprint, expectedIdentity);
  const credential = loadJsonCredential(selection.file, selector, expectedIdentity);
  assertProviderStillMatches(runtime, expectedFingerprint);
  return credential;
}

export function describeCredentialProvider(selection: CredentialProviderSelection): { provider: "windows" | "json-file" } {
  // El estado público solo necesita indicar el tipo. La ruta elegida por el
  // usuario permanece en la configuración privada y no se imprime en logs.
  return { provider: selection.provider };
}

export function credentialProviderFingerprint(runtime: RuntimePaths): string {
  const selection = loadCredentialProviderSelection(runtime);
  return fingerprintSelection(selection, selection.provider === "json-file"
    ? selection.fileIdentity ?? externalFileIdentity(selection.file)
    : undefined);
}

export function assertCredentialProviderFingerprint(runtime: RuntimePaths, expected: string | undefined): void {
  if (!expected || !/^[a-f0-9]{64}$/u.test(expected) || credentialProviderFingerprint(runtime) !== expected) {
    throw providerUnavailable("El proveedor de credenciales cambió durante el inicio; la sesión fue cancelada.");
  }
}

function validateProviderSelection(raw: unknown): CredentialProviderSelection {
  let parsed: CredentialProviderSelection;
  try {
    parsed = providerConfigSchema.parse(raw) as CredentialProviderSelection;
  } catch {
    throw providerUnavailable("La configuración local del proveedor de credenciales no cumple el contrato vigente.");
  }
  if (parsed.provider === "windows") return parsed;
  const identities = parsed.identities?.map((identity) => ({
    cuit: identity.cuit,
    displayName: identity.displayName.trim(),
  }));
  if (identities) {
    const cuits = new Set<string>();
    for (const identity of identities) {
      if (!isValidCuit(identity.cuit) || cuits.has(identity.cuit)) {
        throw providerUnavailable("El índice local de credenciales contiene un CUIT inválido o duplicado.");
      }
      cuits.add(identity.cuit);
    }
  }
  const file = validateExternalCredentialFilePath(parsed.file);
  if (parsed.fileIdentity && parsed.fileIdentity !== externalFileIdentity(file)) {
    throw providerUnavailable("El archivo de credenciales cambió desde que fue seleccionado; volvé a seleccionarlo antes de iniciar sesión.");
  }
  return {
    schemaVersion: 1,
    provider: "json-file",
    file,
    ...(identities ? { identities } : {}),
    ...(parsed.fileIdentity ? { fileIdentity: parsed.fileIdentity } : {}),
  };
}

function externalFileIdentity(filePath: string): string {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw new Error("invalid-file");
    return fileIdentityFromStat(stat);
  } catch {
    throw providerUnavailable("No se pudo atestiguar la identidad del archivo de credenciales.");
  }
}

function validateExternalCredentialFilePath(value: string): string {
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw providerUnavailable("El archivo de credenciales debe usar una ruta absoluta.");
  }
  try {
    const lexical = path.resolve(value);
    const stat = fs.lstatSync(lexical);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("invalid-file");
    const canonical = fs.realpathSync(lexical);
    if (!samePath(lexical, canonical)) throw new Error("redirected-file");
    const repository = fs.realpathSync(process.cwd());
    if (isWithin(repository, canonical)) {
      throw providerUnavailable("El archivo de credenciales no puede estar dentro del repositorio.");
    }
    return canonical;
  } catch (error) {
    if (error instanceof CredentialProviderError) throw error;
    throw providerUnavailable("El archivo de credenciales debe ser regular, accesible y no puede ser un enlace o junction.");
  }
}

function readJsonCredentials(filePath: string, expectedIdentity: string): Array<CredentialReference & { clave: string }> {
  const canonical = validateExternalCredentialFilePath(filePath);
  let descriptor: number | undefined;
  try {
    const beforeOpen = fs.statSync(canonical, { bigint: true });
    descriptor = fs.openSync(canonical, "r");
    const stat = fs.fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || beforeOpen.nlink !== 1n || stat.dev !== beforeOpen.dev || stat.ino !== beforeOpen.ino) {
      throw providerUnavailable("El archivo de credenciales cambió mientras se abría.");
    }
    if (fileIdentityFromStat(stat) !== expectedIdentity) {
      throw providerUnavailable("El descriptor abierto no coincide con el archivo de credenciales atestiguado.");
    }
    if (stat.size <= 0n || stat.size > BigInt(maximumCredentialFileBytes)) {
      throw providerUnavailable("El archivo de credenciales está vacío o supera el límite de 1 MiB.");
    }
    const content = fs.readFileSync(descriptor, "utf8");
    const afterRead = fs.fstatSync(descriptor, { bigint: true });
    if (fileIdentityFromStat(afterRead) !== expectedIdentity || !samePath(fs.realpathSync(filePath), canonical)) {
      throw providerUnavailable("El archivo de credenciales cambió durante la lectura.");
    }
    const raw = JSON.parse(content);
    const parsed = jsonCredentialFileSchema.parse(raw);
    const seenCuits = new Set<string>();
    return parsed.credentials.map((record) => {
      const cuit = record.cuit.replace(/\D/g, "");
      if (!isValidCuit(cuit) || seenCuits.has(cuit)) {
        throw providerUnavailable("El archivo de credenciales contiene un CUIT inválido o duplicado.");
      }
      if (record.clave.includes("\0") || /[\r\n]/u.test(record.clave)) {
        throw providerUnavailable("El archivo de credenciales contiene una clave con caracteres no admitidos.");
      }
      seenCuits.add(cuit);
      return {
        issuerKey: cuit,
        cuit,
        displayName: record.displayName.trim(),
        storageVersion: 1,
        clave: record.clave,
      };
    });
  } catch (error) {
    if (error instanceof CredentialProviderError) throw error;
    throw providerUnavailable("No se pudo validar el archivo de credenciales elegido.");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function selectJsonIdentity<T extends { cuit: string; displayName: string }>(records: T[], selector: string): T {
  const numeric = /^\s*[\d.\-\s]+\s*$/u.test(selector) ? selector.replace(/\D/g, "") : undefined;
  if (numeric && !isValidCuit(numeric)) {
    throw new CredentialProviderError("ARCA_CREDENTIAL_NOT_FOUND", "El selector numérico no contiene un CUIT válido.");
  }
  const normalizedName = normalizeName(selector);
  const matches = records.filter((record) => numeric ? record.cuit === numeric : normalizeName(record.displayName) === normalizedName);
  const uniqueCuits = new Set(matches.map((record) => record.cuit));
  if (uniqueCuits.size === 0) throw new CredentialProviderError("ARCA_CREDENTIAL_NOT_FOUND", "No existe una credencial para el emisor indicado.");
  if (uniqueCuits.size !== 1) throw new CredentialProviderError("ARCA_CREDENTIAL_AMBIGUOUS", "El nombre coincide con más de un contribuyente; indicá el CUIT.");
  return matches[0] as T;
}

function loadJsonCredential(filePath: string, selector: string, expectedIdentity: string): ArcaCredentials {
  const record = selectJsonIdentity(readJsonCredentials(filePath, expectedIdentity), selector);
  return { issuerKey: record.cuit, cuit: record.cuit, displayName: record.displayName, clave: record.clave };
}

function fileIdentityFromStat(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function classifyWindowsProviderFailure(error: unknown, operation: "resolve" | "load"): CredentialProviderError {
  const message = error instanceof Error ? error.message : "";
  if (/m[aá]s de una|coincide con m[aá]s|ambigu/iu.test(message)) {
    return new CredentialProviderError("ARCA_CREDENTIAL_AMBIGUOUS", "El nombre coincide con más de un contribuyente; indicá el CUIT.");
  }
  if (/no existe|no se encontr/iu.test(message)) {
    return new CredentialProviderError("ARCA_CREDENTIAL_NOT_FOUND", "No existe una credencial para el emisor indicado.");
  }
  return providerUnavailable(operation === "resolve"
    ? "No se pudo consultar el proveedor de credenciales configurado."
    : "No se pudo obtener la credencial del emisor configurado.");
}

function providerUnavailable(message: string): CredentialProviderError {
  return new CredentialProviderError("ARCA_CREDENTIAL_PROVIDER_UNAVAILABLE", message);
}

function describeCredentialCandidates(candidates: Array<Pick<CredentialReference, "displayName" | "cuit">>): string {
  return candidates
    .slice(0, 20)
    .map((candidate) => `${candidate.displayName} [${formatCredentialCuit(candidate.cuit)}]`)
    .join(", ");
}

function assertLoadedProviderFingerprint(
  selection: CredentialProviderSelection,
  expectedFingerprint: string | undefined,
  openedFileIdentity?: string,
): void {
  if (!expectedFingerprint) return;
  if (!/^[a-f0-9]{64}$/u.test(expectedFingerprint) || fingerprintSelection(selection, openedFileIdentity) !== expectedFingerprint) {
    throw providerUnavailable("El proveedor o el descriptor de credenciales no coincide con la atestación del inicio de sesión.");
  }
}

function assertProviderStillMatches(runtime: RuntimePaths, expectedFingerprint: string | undefined): void {
  if (expectedFingerprint) assertCredentialProviderFingerprint(runtime, expectedFingerprint);
}

function fingerprintSelection(selection: CredentialProviderSelection, openedFileIdentity?: string): string {
  const material = selection.provider === "windows"
    ? "windows"
    : `json-file\0${selection.file}\0${JSON.stringify(selection.identities ?? [])}\0${openedFileIdentity ?? selection.fileIdentity ?? externalFileIdentity(selection.file)}`;
  return createHash("sha256").update(material, "utf8").digest("hex");
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("es-AR");
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => process.platform === "win32" ? path.resolve(value).toLocaleLowerCase("en-US") : path.resolve(value);
  return normalize(left) === normalize(right);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
