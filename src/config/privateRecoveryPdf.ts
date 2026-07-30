import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { publishReservedPdf, reservePrivatePdfDestination, type PdfDestinationReservation } from "./privateDownloads.js";

export const recoveryPdfMinimumBytes = 1_024;
export const recoveryPdfMaximumBytes = 50 * 1_024 * 1_024;

export type PrivateRecoveryPdfStage = {
  /** Copia privada estable. Es la única ruta apta para validar y hashear. */
  path: string;
  publish: () => Promise<string>;
  release: () => Promise<void>;
};

export function getPrivateRecoveryInbox(downloadsRoot: string): string {
  return path.join(path.resolve(downloadsRoot), "recovery-inbox");
}

/**
 * Ingresa un PDF desde la bandeja cerrada de recuperación mediante un descriptor
 * estable. El llamador nunca debe volver a leer `sourceValue`: a partir de este
 * punto, validación, hash y publicación operan exclusivamente sobre `path`.
 */
export async function stagePrivateRecoveryPdf(
  sourceValue: string,
  stagingKey: string,
  downloadsRoot: string,
  trustedRoot: string,
): Promise<PrivateRecoveryPdfStage> {
  let source: string;
  try {
    source = await resolvePrivateRecoverySource(sourceValue, downloadsRoot, trustedRoot);
  } catch (error) {
    throw sanitizeRecoveryError(error, "No se pudo validar la bandeja privada del PDF de recuperación.");
  }
  const digest = createHash("sha256").update(`recovery:${stagingKey}`, "utf8").digest("hex");
  const stagingTarget = path.join(path.resolve(downloadsRoot), ".staging", `${digest}.pdf`);
  const reservation = await reservePrivatePdfDestination(stagingTarget, downloadsRoot, trustedRoot);

  try {
    await copyStableSourceToReservation(source, reservation);
  } catch (error) {
    await reservation.release();
    throw sanitizeRecoveryError(error, "No se pudo obtener una copia estable del PDF de recuperación.");
  }

  let released = false;
  let publishedPath: string | undefined;
  return {
    path: reservation.temporaryPath,
    publish: async () => {
      if (released) throw new Error("La copia privada de recuperación ya fue liberada.");
      if (publishedPath) return publishedPath;
      publishedPath = await publishReservedPdf(reservation);
      return publishedPath;
    },
    release: async () => {
      if (released) return;
      released = true;
      await reservation.release();
    },
  };
}

async function resolvePrivateRecoverySource(sourceValue: string, downloadsRoot: string, trustedRoot: string): Promise<string> {
  if (!path.isAbsolute(sourceValue)) {
    throw new Error("El PDF de recuperación debe indicarse mediante una ruta absoluta dentro de downloads\\recovery-inbox.");
  }
  const downloads = path.resolve(downloadsRoot);
  const trusted = path.resolve(trustedRoot);
  const inbox = getPrivateRecoveryInbox(downloads);
  const source = path.resolve(sourceValue);
  if (!samePath(path.dirname(source), inbox) || path.extname(source).toLocaleLowerCase("en-US") !== ".pdf") {
    throw new Error("El PDF de recuperación debe ser un archivo .pdf ubicado directamente en downloads\\recovery-inbox.");
  }

  const repositoryReal = await fs.realpath(process.cwd());
  const trustedReal = await validateCanonicalDirectory(trusted, "la raíz privada del runtime");
  const downloadsReal = await validateCanonicalDirectory(downloads, "la raíz privada de downloads");
  if (!isWithin(trustedReal, downloadsReal) || isWithin(repositoryReal, downloadsReal)) {
    throw new Error("La bandeja de recuperación no pertenece al runtime privado aprobado.");
  }
  const inboxReal = await validateCanonicalDirectory(inbox, "la bandeja privada de recuperación");
  if (!isWithin(downloadsReal, inboxReal) || isWithin(repositoryReal, inboxReal)) {
    throw new Error("La bandeja de recuperación no pertenece a downloads o atraviesa una redirección.");
  }
  return source;
}

async function validateCanonicalDirectory(value: string, label: string): Promise<string> {
  const stat = await fs.lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${capitalize(label)} debe ser un directorio regular, no un enlace o junction.`);
  }
  const real = await fs.realpath(value);
  if (!samePath(real, value)) throw new Error(`${capitalize(label)} no puede atravesar enlaces o junctions.`);
  return real;
}

async function copyStableSourceToReservation(source: string, reservation: PdfDestinationReservation): Promise<void> {
  const beforeOpen = await fs.lstat(source, { bigint: true });
  assertRecoveryPdfStat(beforeOpen);
  const sourceReal = await fs.realpath(source);
  if (!samePath(sourceReal, source)) {
    throw new Error("El PDF de recuperación no puede atravesar enlaces o junctions.");
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const sourceHandle = await fs.open(source, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await sourceHandle.stat({ bigint: true });
    assertRecoveryPdfStat(opened);
    assertSameFileSnapshot(beforeOpen, opened);

    const targetHandle = await fs.open(
      reservation.temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    try {
      await copyExactBytes(sourceHandle, targetHandle, Number(opened.size));
      await targetHandle.sync();
    } finally {
      await targetHandle.close();
    }

    const afterDescriptor = await sourceHandle.stat({ bigint: true });
    const afterPath = await fs.lstat(source, { bigint: true });
    const afterReal = await fs.realpath(source);
    assertRecoveryPdfStat(afterDescriptor);
    assertRecoveryPdfStat(afterPath);
    assertSameFileSnapshot(opened, afterDescriptor);
    assertSameFileSnapshot(opened, afterPath);
    if (!samePath(afterReal, source)) {
      throw new Error("El PDF de recuperación cambió de identidad durante la copia.");
    }
  } catch (error) {
    await fs.rm(reservation.temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof Error && /^El PDF de recuperación/u.test(error.message)) throw error;
    throw new Error("No se pudo obtener una copia estable del PDF de recuperación.");
  } finally {
    await sourceHandle.close();
  }

  const staged = await fs.lstat(reservation.temporaryPath);
  if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 1 || staged.size < recoveryPdfMinimumBytes || staged.size > recoveryPdfMaximumBytes) {
    await fs.rm(reservation.temporaryPath, { force: true }).catch(() => undefined);
    throw new Error("La copia privada del PDF de recuperación no es un archivo regular verificable.");
  }
  const stagedReal = await fs.realpath(reservation.temporaryPath);
  if (!samePath(stagedReal, reservation.temporaryPath)) {
    await fs.rm(reservation.temporaryPath, { force: true }).catch(() => undefined);
    throw new Error("La copia privada del PDF de recuperación atraviesa una redirección no permitida.");
  }
}

async function copyExactBytes(
  source: fs.FileHandle,
  target: fs.FileHandle,
  expectedBytes: number,
): Promise<void> {
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  let position = 0;
  while (position < expectedBytes) {
    const length = Math.min(buffer.length, expectedBytes - position);
    const { bytesRead } = await source.read(buffer, 0, length, position);
    if (bytesRead === 0) throw new Error("El PDF de recuperación cambió de tamaño durante la copia.");
    let written = 0;
    while (written < bytesRead) {
      const result = await target.write(buffer, written, bytesRead - written, null);
      if (result.bytesWritten === 0) throw new Error("No se pudo escribir la copia privada del PDF de recuperación.");
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
  const trailing = Buffer.allocUnsafe(1);
  if ((await source.read(trailing, 0, 1, expectedBytes)).bytesRead !== 0) {
    throw new Error("El PDF de recuperación cambió de tamaño durante la copia.");
  }
}

function assertRecoveryPdfStat(stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error("El PDF de recuperación debe ser un archivo regular con una única identidad; no se admiten symlinks ni hard links.");
  }
  if (stat.size < BigInt(recoveryPdfMinimumBytes) || stat.size > BigInt(recoveryPdfMaximumBytes)) {
    throw new Error("El tamaño del PDF de recuperación está fuera del rango permitido.");
  }
}

function assertSameFileSnapshot(expected: BigIntStats, actual: BigIntStats): void {
  if (
    expected.dev !== actual.dev
    || expected.ino !== actual.ino
    || expected.nlink !== actual.nlink
    || expected.size !== actual.size
    || expected.mtimeNs !== actual.mtimeNs
    || expected.ctimeNs !== actual.ctimeNs
  ) {
    throw new Error("El PDF de recuperación cambió de identidad o contenido durante la copia.");
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

function capitalize(value: string): string {
  return `${value.slice(0, 1).toLocaleUpperCase("es-AR")}${value.slice(1)}`;
}

function sanitizeRecoveryError(error: unknown, fallback: string): Error {
  if (error instanceof Error && /^(?:El|La|No se pudo) (?:PDF|tamaño|bandeja|copia)/u.test(error.message)) return error;
  return new Error(fallback);
}
