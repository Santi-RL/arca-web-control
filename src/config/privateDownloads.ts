import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDirectory, getRuntimePaths } from "./runtimePaths.js";
import { acquireLocalOsMutex } from "../io/osMutex.js";

export type PdfDestinationReservation = {
  path: string;
  temporaryPath: string;
  release: () => Promise<void>;
  preserveTemporary: () => void;
};

export function resolveRuntimePdfPath(value: string, downloadsRoot = getRuntimePaths().downloads): string {
  if (path.isAbsolute(value)) throw new Error("La descarga manual debe indicar un nombre relativo dentro de downloads.");
  if (path.dirname(value) !== "." || value.includes("/") || value.includes("\\")) {
    throw new Error("La descarga manual debe usar solo un nombre de archivo, sin carpetas ni junctions.");
  }
  const resolved = path.resolve(downloadsRoot, value);
  return assertPrivatePdfPath(resolved);
}

export function assertPrivatePdfPath(value: string, repositoryRoot = process.cwd()): string {
  const resolved = path.resolve(value);
  if (path.extname(resolved).toLowerCase() !== ".pdf") throw new Error("El destino debe terminar en .pdf.");
  const relative = path.relative(repositoryRoot, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("Los PDFs fiscales no pueden guardarse dentro del repositorio.");
  }
  return resolved;
}

export async function reservePrivatePdfDestination(value: string, allowedRoot: string, trustedRoot: string): Promise<PdfDestinationReservation> {
  const lexicalPath = assertPrivatePdfPath(value);
  const parent = path.dirname(lexicalPath);
  const canonicalParent = await prepareAndValidateParent(parent, allowedRoot, trustedRoot);
  const resolved = path.join(canonicalParent, path.basename(lexicalPath));
  const ownerToken = randomUUID();
  const temporaryPath = path.join(canonicalParent, `.${path.basename(resolved, ".pdf")}.${ownerToken}.tmp.pdf`);
  const releaseMutex = await acquireLocalOsMutex(`pdf-destination\0${resolved}`, "el destino PDF");
  let released = false;
  let keepTemporary = false;
  const preserveTemporary = () => { keepTemporary = true; };
  const release = async () => {
    if (released) return;
    released = true;
    if (!keepTemporary) await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    await releaseMutex();
  };
  try {
    const orphanedTemporary = (await fs.readdir(canonicalParent)).some((name) =>
      name.startsWith(`.${path.basename(resolved, ".pdf")}.`) && name.endsWith(".tmp.pdf"),
    );
    if (orphanedTemporary) throw new Error("El destino PDF conserva un temporal huérfano que debe reconciliarse antes de continuar.");
    await fs.access(resolved);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { path: resolved, temporaryPath, release, preserveTemporary };
    await release();
    throw error;
  }
  await release();
  throw new Error("El destino PDF ya existe y no se sobrescribirá.");
}


export async function publishReservedPdf(reservation: PdfDestinationReservation): Promise<string> {
  try {
    await fs.link(reservation.temporaryPath, reservation.path);
    await fs.rm(reservation.temporaryPath, { force: true }).catch(() => undefined);
    return reservation.path;
  } catch (error) {
    reservation.preserveTemporary();
    const recoveryPath = path.join(
      path.dirname(reservation.path),
      `.${path.basename(reservation.path, ".pdf")}.recovery-${randomUUID()}.pdf`,
    );
    let preservedAt = reservation.temporaryPath;
    try {
      await fs.rename(reservation.temporaryPath, recoveryPath);
      preservedAt = recoveryPath;
    } catch {
      // Si no puede renombrarse, release conserva el temporal original.
    }
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`El destino PDF apareció durante la descarga y no se sobrescribirá. PDF recuperable: ${preservedAt}`);
    }
    throw new Error(`No se pudo publicar el PDF final. PDF recuperable: ${preservedAt}. Error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function prepareAndValidateParent(parent: string, allowedRoot: string, trustedRoot: string): Promise<string> {
  const repositoryReal = await fs.realpath(process.cwd());
  const trustedPath = path.resolve(trustedRoot);
  const trustedStat = await fs.lstat(trustedPath);
  if (!trustedStat.isDirectory() || trustedStat.isSymbolicLink()) {
    throw new Error("La raíz privada del runtime no puede ser un symlink o junction.");
  }
  const trustedReal = await fs.realpath(trustedPath);
  if (isWithin(repositoryReal, trustedReal)) throw new Error("La raíz privada del runtime no puede apuntar al repositorio.");

  const allowedPath = path.resolve(allowedRoot);
  const allowedRelative = path.relative(trustedPath, allowedPath);
  if (allowedRelative !== "" && (allowedRelative.startsWith("..") || path.isAbsolute(allowedRelative))) {
    throw new Error("La raíz de downloads no pertenece al runtime privado aprobado.");
  }
  const existingAllowedStat = await lstatIfExists(allowedPath);
  if (existingAllowedStat?.isSymbolicLink()) {
    throw new Error("La raíz de downloads no puede ser un symlink o junction.");
  }
  const allowedAncestorReal = await fs.realpath(await nearestExistingAncestor(allowedPath));
  if (!isWithin(trustedReal, allowedAncestorReal)) throw new Error("La raíz de downloads no pertenece al runtime privado aprobado.");
  if (isWithin(repositoryReal, allowedAncestorReal)) throw new Error("La raíz de downloads no puede apuntar al repositorio.");
  await ensurePrivateDirectory(allowedPath);
  const boundaryStat = await fs.lstat(allowedPath);
  if (!boundaryStat.isDirectory() || boundaryStat.isSymbolicLink()) {
    throw new Error("La raíz de downloads no puede ser un symlink o junction.");
  }
  const boundaryReal = await fs.realpath(allowedPath);
  if (isWithin(repositoryReal, boundaryReal)) throw new Error("La raíz de downloads no puede apuntar al repositorio.");
  if (!isWithin(trustedReal, boundaryReal)) throw new Error("La raíz de downloads no pertenece al runtime privado aprobado.");

  const ancestorReal = await fs.realpath(await nearestExistingAncestor(parent));
  if (!isWithin(boundaryReal, ancestorReal)) {
    throw new Error("El destino PDF escapa de la carpeta privada downloads mediante un symlink o junction.");
  }
  if (isWithin(repositoryReal, ancestorReal)) throw new Error("El destino PDF reingresa al repositorio mediante un symlink o junction.");
  let parentReal = await realpathIfExists(parent);
  if (!parentReal || !samePath(parentReal, boundaryReal)) {
    await ensurePrivateDirectory(parent);
    parentReal = await fs.realpath(parent);
  }
  if (!isWithin(boundaryReal, parentReal)) {
    throw new Error("El destino PDF escapa de la carpeta privada downloads mediante un symlink o junction.");
  }
  if (isWithin(repositoryReal, parentReal)) throw new Error("El destino PDF reingresa al repositorio mediante un symlink o junction.");
  return parentReal;
}
async function nearestExistingAncestor(value: string): Promise<string> {
  let current = path.resolve(value);
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function realpathIfExists(value: string): Promise<string | undefined> {
  try {
    return await fs.realpath(value);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function lstatIfExists(value: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(value);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  if (process.platform === "win32") return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
  return left === right;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
