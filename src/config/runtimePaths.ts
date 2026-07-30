import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeJsonAtomic } from "../io/atomicJson.js";

const execFileAsync = promisify(execFile);

export type RuntimePaths = {
  root: string;
  config: string;
  profiles: string;
  issuers: string;
  sessions: string;
  learning: string;
  ledger: string;
  privateJobs: string;
  privateImport: string;
  guided: string;
  logs: string;
  downloads: string;
};

export function getRuntimePaths(): RuntimePaths {
  assertOperationalRuntimeEnvironment();
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return buildRuntimePaths(path.join(localAppData, "ManejoARCA"));
}

/** Inyección explícita para pruebas; ningún entrypoint operativo debe invocarla. */
export function getRuntimePathsForTesting(root: string): RuntimePaths {
  return buildRuntimePaths(root);
}

export function assertOperationalRuntimeEnvironment(): void {
  if (Object.prototype.hasOwnProperty.call(process.env, "ARCA_RUNTIME_ROOT")) {
    throw new Error("ARCA_RUNTIME_ROOT no está permitido: el runtime privado usa exclusivamente %LOCALAPPDATA%\\ManejoARCA.");
  }
  if (process.env.NODE_ENV?.trim().toLowerCase() === "test") {
    throw new Error("NODE_ENV=test no está permitido en comandos operativos: no se pueden omitir las ACL del runtime privado.");
  }
}

function buildRuntimePaths(rootValue: string): RuntimePaths {
  const root = path.resolve(rootValue);
  const relative = path.relative(process.cwd(), root);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("La raíz privada del runtime debe estar fuera del repositorio.");
  }
  return {
    root,
    config: path.join(root, "config"),
    profiles: path.join(root, "profiles"),
    issuers: path.join(root, "issuers"),
    sessions: path.join(root, "sessions"),
    learning: path.join(root, "learning"),
    ledger: path.join(root, "ledger"),
    privateJobs: path.join(root, "jobs", "private"),
    privateImport: path.join(root, "private-import"),
    guided: path.join(root, "guided"),
    logs: path.join(root, "logs"),
    downloads: path.join(root, "downloads"),
  };
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  if (process.platform !== "win32") return;

  await assertRegularPrivatePath(directory, "directory");
  await restrictWindowsAcl(directory, true);
}

export async function ensurePrivateFile(filePath: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error("El recurso privado debe ser un archivo regular con una única identidad; no se admiten enlaces ni hard links.");
  }
  if (process.platform !== "win32") return;

  await assertRegularPrivatePath(filePath, "file");
  await restrictWindowsAcl(filePath, false);
}

async function assertRegularPrivatePath(target: string, kind: "file" | "directory"): Promise<void> {
  try {
    const stat = await fs.lstat(target);
    const expectedType = kind === "directory" ? stat.isDirectory() : stat.isFile();
    if (!expectedType || stat.isSymbolicLink()) throw new Error("invalid-private-path");
    const lexical = path.resolve(target);
    const canonical = await fs.realpath(target);
    if (!samePath(lexical, canonical)) throw new Error("redirected-private-path");
    const repositoryReal = await fs.realpath(process.cwd());
    if (isWithin(repositoryReal, canonical)) throw new Error("private-path-inside-repository");
  } catch {
    throw new Error("El recurso privado no puede ser un enlace, junction ni una ruta dentro del repositorio.");
  }
}

async function restrictWindowsAcl(target: string, directory: boolean): Promise<void> {
  await runWindowsAclScript(target, directory ? "directory" : "file");
}

async function restrictWindowsRuntimeLayout(root: string): Promise<void> {
  await runWindowsAclScript(root, "layout");
}

async function repairWindowsRuntimeLayout(root: string): Promise<void> {
  await runWindowsAclScript(root, "repair");
}

async function runWindowsAclScript(target: string, kind: "file" | "directory" | "layout" | "repair"): Promise<void> {
  const script = path.resolve("scripts", "set-private-acl.ps1");
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const psModulePath = [
    path.join(programFiles, "WindowsPowerShell", "Modules"),
    path.join(systemRoot, "system32", "WindowsPowerShell", "v1.0", "Modules"),
  ].join(path.delimiter);
  try {
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await execFileAsync(powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      target,
      kind,
    ], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024, env: { ...process.env, PSModulePath: psModulePath } });
  } catch {
    throw new Error("No se pudo aplicar y verificar la ACL exclusiva del recurso privado.");
  }
}

export async function ensureRuntimeLayout(paths = getRuntimePaths()): Promise<RuntimePaths> {
  const existingManagedState = await hasExistingManagedRuntimeState(paths);
  const ready = await ensureRuntimeBoundaries(paths);
  if (existingManagedState) {
    await assertRuntimeLayoutMarker(paths);
  } else {
    await createRuntimeLayoutMarker(paths);
  }
  return ready;
}

async function ensureRuntimeBoundaries(paths: RuntimePaths): Promise<RuntimePaths> {
  await fs.mkdir(paths.root, { recursive: true });
  await assertRegularPrivatePath(paths.root, "directory");
  await createRuntimeDirectoriesWithoutFollowingRedirects(paths);
  await validateRuntimeDirectoryStructure(paths);
  if (process.platform === "win32") {
    await restrictWindowsRuntimeLayout(paths.root);
  }
  return paths;
}

/**
 * Mantenimiento explícito y potencialmente costoso. Nunca debe ejecutarse como
 * precondición de una operación fiscal: recorre solamente los subárboles que
 * pertenecen al runtime administrado y omite cualquier carpeta histórica o
 * desconocida situada junto a ellos.
 */
export async function repairManagedRuntimeAcl(paths = getRuntimePaths()): Promise<RuntimePaths> {
  const ready = await ensureRuntimeBoundaries(paths);
  if (process.platform === "win32") await repairWindowsRuntimeLayout(ready.root);
  await replaceRuntimeLayoutMarkerAfterRepair(paths);
  return ready;
}

function runtimeLayoutMarkerPath(paths: RuntimePaths): string {
  return path.join(paths.config, "runtime-layout-v3.json");
}

async function hasExistingManagedRuntimeState(paths: RuntimePaths): Promise<boolean> {
  for (const directory of managedRuntimeDirectories(paths)) {
    try {
      await fs.lstat(directory);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return false;
}

async function assertRuntimeLayoutMarker(paths: RuntimePaths): Promise<void> {
  const marker = runtimeLayoutMarkerPath(paths);
  try {
    const stat = await fs.lstat(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("invalid-marker");
    const parsed = JSON.parse(await fs.readFile(marker, "utf8")) as Record<string, unknown>;
    if (parsed.schemaVersion !== 1 || parsed.layoutVersion !== 3 || Object.keys(parsed).length !== 2) {
      throw new Error("invalid-marker");
    }
    // El marcador es la atestación que evita el recorrido profundo. Su propio
    // archivo se protege y verifica siempre en O(1), no solo el directorio que
    // lo contiene.
    await ensurePrivateFile(marker);
  } catch {
    throw new Error("El runtime existente requiere una única reparación administrada antes de operar: ejecutá arca:runtime:repair fuera de toda sesión fiscal.");
  }
}

async function createRuntimeLayoutMarker(paths: RuntimePaths): Promise<void> {
  const marker = runtimeLayoutMarkerPath(paths);
  try {
    await assertRuntimeLayoutMarker(paths);
    await ensurePrivateFile(marker);
    return;
  } catch (error) {
    try {
      await fs.lstat(marker);
      throw error;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await writeJsonAtomic(marker, { schemaVersion: 1, layoutVersion: 3 });
  await ensurePrivateFile(marker);
}

async function replaceRuntimeLayoutMarkerAfterRepair(paths: RuntimePaths): Promise<void> {
  const marker = runtimeLayoutMarkerPath(paths);
  try {
    const stat = await fs.lstat(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("El marcador de layout existente no es un archivo privado regular; se requiere revisión manual.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeJsonAtomic(marker, { schemaVersion: 1, layoutVersion: 3 });
  await ensurePrivateFile(marker);
}

async function createRuntimeDirectoriesWithoutFollowingRedirects(paths: RuntimePaths): Promise<void> {
  const root = path.resolve(paths.root);
  const pending = new Set<string>();
  for (const configured of managedRuntimeDirectories(paths)) {
    let current = path.resolve(configured);
    if (!isWithin(root, current) || samePath(root, current)) {
      throw new Error("La estructura privada solicitada escapa de la raíz del runtime.");
    }
    while (!samePath(current, root)) {
      pending.add(current);
      const parent = path.dirname(current);
      if (samePath(parent, current) || !isWithin(root, parent)) {
        throw new Error("La estructura privada solicitada escapa de la raíz del runtime.");
      }
      current = parent;
    }
  }

  const rootReal = await fs.realpath(root);
  const directories = [...pending].sort((left, right) => path.relative(root, left).split(path.sep).length - path.relative(root, right).split(path.sep).length);
  for (const directory of directories) {
    const parent = path.dirname(directory);
    const parentStat = await fs.lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new Error("La estructura privada contiene una redirección no permitida.");
    }
    const parentReal = await fs.realpath(parent);
    if (!isWithin(rootReal, parentReal)) throw new Error("La estructura privada contiene una redirección no permitida.");
    try {
      await fs.mkdir(directory);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("La estructura privada contiene una redirección no permitida.");
    }
    const canonical = await fs.realpath(directory);
    if (!isWithin(rootReal, canonical)) throw new Error("La estructura privada contiene una redirección no permitida.");
  }
}

/**
 * Reutiliza exclusivamente la verificación de ACL que acaba de completar el
 * launcher de sesión. La atestación debe llegar por el canal IPC heredado; una
 * variable de entorno nunca es suficiente para invocar este camino.
 */
export async function useLauncherVerifiedRuntimeLayout(verifiedRoot: string, paths = getRuntimePaths()): Promise<RuntimePaths> {
  if (!path.isAbsolute(verifiedRoot) || !samePath(verifiedRoot, paths.root)) {
    throw new Error("La atestación del runtime privado no coincide con la configuración local.");
  }
  await validateRuntimeDirectoryStructure(paths);
  await assertRuntimeLayoutMarker(paths);
  return paths;
}

/**
 * Reutiliza la estructura de una sesión local viva que ya fue atestiguada por
 * su launcher. El llamador debe comprobar primero identidad, modo, handoff y
 * endpoint autenticado de esa sesión; aquí solo se vuelve a validar que los
 * límites fijos no hayan sido redirigidos.
 */
export async function useActiveSessionRuntimeLayout(paths = getRuntimePaths()): Promise<RuntimePaths> {
  await validateRuntimeDirectoryStructure(paths);
  await assertRuntimeLayoutMarker(paths);
  return paths;
}

async function validateRuntimeDirectoryStructure(paths: RuntimePaths): Promise<void> {
  try {
    const rootStat = await fs.lstat(paths.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("invalid-root");
    const rootReal = await fs.realpath(paths.root);
    await Promise.all([paths.root, ...managedRuntimeDirectories(paths)].map(async (directory) => {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid-directory");
      const directoryReal = await fs.realpath(directory);
      if (!isWithin(rootReal, directoryReal)) throw new Error("escaped-directory");
    }));
  } catch {
    throw new Error("La estructura privada del runtime no está disponible o contiene redirecciones no permitidas.");
  }
}

function managedRuntimeDirectories(paths: RuntimePaths): string[] {
  return [
    paths.config,
    paths.profiles,
    paths.issuers,
    paths.sessions,
    paths.learning,
    paths.ledger,
    path.join(paths.root, "jobs"),
    paths.privateJobs,
    paths.privateImport,
    paths.guided,
    paths.logs,
    paths.downloads,
  ];
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
