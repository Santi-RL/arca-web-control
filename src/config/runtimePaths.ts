import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type RuntimePaths = {
  root: string;
  profiles: string;
  issuers: string;
  sessions: string;
  learning: string;
  ledger: string;
  privateJobs: string;
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
    profiles: path.join(root, "profiles"),
    issuers: path.join(root, "issuers"),
    sessions: path.join(root, "sessions"),
    learning: path.join(root, "learning"),
    ledger: path.join(root, "ledger"),
    privateJobs: path.join(root, "jobs", "private"),
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
  if (!stat.isFile()) throw new Error("La ruta de importación no corresponde a un archivo regular.");
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

async function runWindowsAclScript(target: string, kind: "file" | "directory" | "layout"): Promise<void> {
  const script = path.resolve("scripts", "set-private-acl.ps1");
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const psModulePath = [
    path.join(programFiles, "WindowsPowerShell", "Modules"),
    path.join(systemRoot, "system32", "WindowsPowerShell", "v1.0", "Modules"),
  ].join(path.delimiter);
  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      target,
      kind,
    ], { windowsHide: true, env: { ...process.env, PSModulePath: psModulePath } });
  } catch {
    throw new Error("No se pudo aplicar y verificar la ACL exclusiva del recurso privado.");
  }
}

export async function ensureRuntimeLayout(paths = getRuntimePaths()): Promise<RuntimePaths> {
  await ensurePrivateDirectory(paths.root);
  await createRuntimeDirectoriesWithoutFollowingRedirects(paths);
  await validateRuntimeDirectoryStructure(paths);
  if (process.platform === "win32") {
    await restrictWindowsRuntimeLayout(paths.root);
  }
  return paths;
}

async function createRuntimeDirectoriesWithoutFollowingRedirects(paths: RuntimePaths): Promise<void> {
  const root = path.resolve(paths.root);
  const pending = new Set<string>();
  for (const configured of Object.values(paths).slice(1)) {
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
  return paths;
}

async function validateRuntimeDirectoryStructure(paths: RuntimePaths): Promise<void> {
  try {
    const rootStat = await fs.lstat(paths.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("invalid-root");
    const rootReal = await fs.realpath(paths.root);
    await Promise.all(Object.values(paths).map(async (directory) => {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid-directory");
      const directoryReal = await fs.realpath(directory);
      if (!isWithin(rootReal, directoryReal)) throw new Error("escaped-directory");
    }));
  } catch {
    throw new Error("La estructura privada del runtime no está disponible o contiene redirecciones no permitidas.");
  }
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
