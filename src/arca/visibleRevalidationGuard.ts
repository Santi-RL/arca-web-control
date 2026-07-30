import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CapabilityManifest } from "../capabilities/registry.js";
import { ensurePrivateFile, getRuntimePaths } from "../config/runtimePaths.js";

const recordSchema = z.object({
  schemaVersion: z.literal(1),
  capabilityId: z.string().regex(/^[a-z0-9-]+$/u),
  capabilityVersion: z.number().int().positive(),
  operationId: z.string().trim().min(8).max(128),
  preparedInvoiceId: z.string().uuid(),
  consumedAt: z.string().datetime({ offset: true }),
}).strict();

type RevalidationCapability = Pick<CapabilityManifest, "id" | "version">;

export async function assertVisibleRevalidationAvailable(
  capability: RevalidationCapability,
  ledgerDirectory = getRuntimePaths().ledger,
): Promise<void> {
  const recordPath = visibleRevalidationRecordPath(capability, ledgerDirectory);
  try {
    const stat = await fs.lstat(recordPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("invalid-record");
    recordSchema.parse(JSON.parse(await fs.readFile(recordPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (error instanceof z.ZodError || error instanceof SyntaxError || (error instanceof Error && error.message === "invalid-record")) {
      throw new Error("La atestación privada de revalidación es inválida; se bloquea toda nueva acción irreversible.");
    }
    throw new Error("No se pudo verificar la atestación privada de revalidación; se bloquea toda nueva acción irreversible.");
  }
  throw new Error(`La revalidación visible de ${capability.id} v${capability.version} ya fue consumida; no se admite un segundo intento irreversible.`);
}

export async function claimVisibleRevalidation(
  capability: RevalidationCapability,
  operationId: string,
  preparedInvoiceId: string,
  ledgerDirectory = getRuntimePaths().ledger,
): Promise<void> {
  await fs.mkdir(ledgerDirectory, { recursive: true });
  const recordPath = visibleRevalidationRecordPath(capability, ledgerDirectory);
  const record = recordSchema.parse({
    schemaVersion: 1,
    capabilityId: capability.id,
    capabilityVersion: capability.version,
    operationId,
    preparedInvoiceId,
    consumedAt: new Date().toISOString(),
  });
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(recordPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`La revalidación visible de ${capability.id} v${capability.version} ya fue consumida; no se admite un segundo intento irreversible.`);
    }
    throw new Error("No se pudo reservar de forma exclusiva la única revalidación irreversible.");
  }
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch {
    await handle.close().catch(() => undefined);
    await fs.rm(recordPath, { force: true }).catch(() => undefined);
    throw new Error("No se pudo persistir la reserva de la única revalidación irreversible.");
  }
  await handle.close();
  // Si la ACL no puede atestiguarse, el archivo se conserva: fallar cerrado
  // impide que un error de permisos habilite un segundo intento.
  await ensurePrivateFile(recordPath);
}

export async function releaseVisibleRevalidationBeforeFirstClick(
  capability: RevalidationCapability,
  operationId: string,
  preparedInvoiceId: string,
  ledgerDirectory = getRuntimePaths().ledger,
): Promise<void> {
  const recordPath = visibleRevalidationRecordPath(capability, ledgerDirectory);
  let record: z.infer<typeof recordSchema>;
  try {
    const stat = await fs.lstat(recordPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("invalid-record");
    record = recordSchema.parse(JSON.parse(await fs.readFile(recordPath, "utf8")));
  } catch {
    throw new Error("No se pudo verificar la reserva de revalidación previa al clic; se conserva el bloqueo irreversible.");
  }
  if (
    record.capabilityId !== capability.id
    || record.capabilityVersion !== capability.version
    || record.operationId !== operationId
    || record.preparedInvoiceId !== preparedInvoiceId
  ) {
    throw new Error("La reserva de revalidación pertenece a otra preparación; se conserva el bloqueo irreversible.");
  }
  try {
    await fs.unlink(recordPath);
  } catch {
    throw new Error("No se pudo revertir la reserva antes del primer clic; se conserva el bloqueo irreversible.");
  }
}

export function visibleRevalidationRecordPath(
  capability: RevalidationCapability,
  ledgerDirectory = getRuntimePaths().ledger,
): string {
  const digest = createHash("sha256").update(`${capability.id}\0${capability.version}`, "utf8").digest("hex");
  return path.join(ledgerDirectory, `visible-revalidation-${digest}.json`);
}
