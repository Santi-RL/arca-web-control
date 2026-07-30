import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { getRuntimePaths } from "../config/runtimePaths.js";
import { readJsonIfExists, writeJsonAtomic } from "../io/atomicJson.js";
import { isProcessAlive } from "../io/processLock.js";

export type OperationStatus = "prepared" | "emitting" | "emitted" | "failed_before_emit" | "unknown";
const OPERATION_STATUSES = new Set<OperationStatus>(["prepared", "emitting", "emitted", "failed_before_emit", "unknown"]);

export type LedgerEntry = {
  operationId: string;
  status: OperationStatus;
  preparedInvoiceId?: string;
  jobHash: string;
  updatedAt: string;
  issuer?: { cuit: string; name: string };
  receipt?: { voucherNumber?: string; cae?: string; pdfPath?: string; metadataPath?: string; pdfSha256?: string };
  detail?: string;
};

type Receipt = NonNullable<LedgerEntry["receipt"]>;

export class OperationLedger {
  constructor(private readonly directory = getRuntimePaths().ledger) {}

  async get(operationId: string): Promise<LedgerEntry | undefined> {
    return await this.readValidated(operationId);
  }

  async claimPreparation(operationId: string, jobHash: string, preparedInvoiceId?: string): Promise<LedgerEntry> {
    return await this.withOperationLock(operationId, async () => {
      const existing = await this.readValidated(operationId);
      if (existing) {
        if (existing.jobHash !== jobHash) {
          throw new Error(`operationId=${operationId} ya está asociado a otro job; generá un operationId nuevo.`);
        }
        if (existing.status !== "failed_before_emit") {
          throw new Error(`La operación ${operationId} ya está en estado ${existing.status}; solo failed_before_emit permite un reintento controlado.`);
        }
      }
      return await this.write({ operationId, status: "prepared", preparedInvoiceId, jobHash });
    });
  }

  async claimEmission(operationId: string, preparedInvoiceId: string, jobHash: string): Promise<LedgerEntry> {
    return await this.transition(operationId, preparedInvoiceId, jobHash, "prepared", "emitting");
  }

  async attachPreparedIssuer(operationId: string, preparedInvoiceId: string, jobHash: string, issuer: NonNullable<LedgerEntry["issuer"]>): Promise<LedgerEntry> {
    if (!/^\d{11}$/u.test(issuer.cuit) || !issuer.name.trim()) {
      throw new Error("La identidad del emisor preparada no es válida para el ledger.");
    }
    return await this.withOperationLock(operationId, async () => {
      const existing = await this.readValidated(operationId);
      if (!existing || existing.status !== "prepared" || existing.jobHash !== jobHash || existing.preparedInvoiceId !== preparedInvoiceId) {
        throw new Error(`La operación ${operationId} no admite asociar la identidad del emisor; la preparación vigente no coincide.`);
      }
      return await this.write({ ...existing, issuer: { cuit: issuer.cuit, name: issuer.name.trim() } });
    });
  }

  async markFailedBeforeEmit(operationId: string, preparedInvoiceId: string, jobHash: string, detail: string): Promise<LedgerEntry> {
    return await this.transition(operationId, preparedInvoiceId, jobHash, "prepared", "failed_before_emit", { detail });
  }

  async markPreparedUnknown(operationId: string, preparedInvoiceId: string, jobHash: string, detail: string): Promise<LedgerEntry> {
    return await this.transition(operationId, preparedInvoiceId, jobHash, "prepared", "unknown", { detail });
  }

  async markUnknown(operationId: string, preparedInvoiceId: string, jobHash: string, detail: string, receipt?: Receipt): Promise<LedgerEntry> {
    return await this.transition(operationId, preparedInvoiceId, jobHash, "emitting", "unknown", { detail, receipt });
  }

  async markEmitted(operationId: string, preparedInvoiceId: string, jobHash: string, receipt: Receipt): Promise<LedgerEntry> {
    return await this.transition(operationId, preparedInvoiceId, jobHash, "emitting", "emitted", { receipt });
  }

  async reconcileUnknownAsEmitted(operationId: string, jobHash: string, receipt: Receipt): Promise<LedgerEntry> {
    assertReconciliationReceipt(receipt);
    return await this.withOperationLock(operationId, async () => {
      const existing = await this.readValidated(operationId);
      if (!existing || existing.status !== "unknown" || existing.jobHash !== jobHash) {
        throw new Error(`La operación ${operationId} no puede reconciliarse desde ${existing?.status ?? "inexistente"}; se exige estado unknown y el mismo job.`);
      }
      return await this.write({
        operationId,
        status: "emitted",
        preparedInvoiceId: existing.preparedInvoiceId,
        jobHash,
        issuer: existing.issuer,
        receipt,
      });
    });
  }

  async record(entry: Omit<LedgerEntry, "updatedAt">): Promise<LedgerEntry> {
    return await this.withOperationLock(entry.operationId, async () => await this.write(entry));
  }

  private async transition(
    operationId: string,
    preparedInvoiceId: string,
    jobHash: string,
    expected: OperationStatus,
    status: OperationStatus,
    extra: Pick<LedgerEntry, "detail" | "receipt"> = {},
  ): Promise<LedgerEntry> {
    return await this.withOperationLock(operationId, async () => {
      const existing = await this.readValidated(operationId);
      if (!existing || existing.status !== expected || existing.jobHash !== jobHash || existing.preparedInvoiceId !== preparedInvoiceId) {
        throw new Error(`La operación ${operationId} no puede pasar de ${existing?.status ?? "inexistente"} a ${status}; la preparación vigente no coincide.`);
      }
      return await this.write({ operationId, status, preparedInvoiceId, jobHash, issuer: existing.issuer, ...extra });
    });
  }

  private async write(entry: Omit<LedgerEntry, "updatedAt">): Promise<LedgerEntry> {
    const complete: LedgerEntry = { ...entry, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(this.pathFor(entry.operationId), complete);
    return complete;
  }

  private async readValidated(operationId: string): Promise<LedgerEntry | undefined> {
    const entry = await readJsonIfExists<LedgerEntry>(this.pathFor(operationId));
    if (entry) {
      if (entry.operationId !== operationId) throw new Error(`Integridad del ledger inválida para operationId=${operationId}.`);
      this.assertKnownStatus(entry, operationId);
      return entry;
    }
    const legacy = await readJsonIfExists<LedgerEntry>(this.legacyPathFor(operationId));
    if (legacy && legacy.operationId !== operationId) {
      throw new Error(`El ledger legado colisiona con otro operationId; se requiere revisión manual para ${operationId}.`);
    }
    if (legacy) this.assertKnownStatus(legacy, operationId);
    return legacy;
  }

  private assertKnownStatus(entry: LedgerEntry, operationId: string): void {
    if (!OPERATION_STATUSES.has(entry.status)) {
      throw new Error(`El ledger de ${operationId} tiene un estado inválido; se bloquea hasta revisión manual.`);
    }
  }

  private async withOperationLock<T>(operationId: string, action: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.directory, { recursive: true });
    const lockPath = `${this.pathFor(operationId)}.lock`;
    const ownerToken = randomUUID();
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(lockPath, "wx");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const lock = await readJsonIfExists<{ pid?: number }>(lockPath).catch(() => undefined);
      if (lock?.pid && isProcessAlive(lock.pid)) throw new Error(`La operación ${operationId} está siendo modificada por otro proceso.`);
      throw new Error(`La operación ${operationId} tiene un lock huérfano. No se elimina automáticamente; requiere revisión manual.`);
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, ownerToken, operationId }));
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
      throw error;
    }
    try {
      return await action();
    } finally {
      await handle.close().catch(() => undefined);
      const current = await readJsonIfExists<{ ownerToken?: string }>(lockPath).catch(() => undefined);
      if (current?.ownerToken === ownerToken) await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  private pathFor(operationId: string): string {
    const digest = createHash("sha256").update(operationId, "utf8").digest("hex");
    return path.join(this.directory, `${digest}.json`);
  }

  private legacyPathFor(operationId: string): string {
    const safe = operationId.replace(/[^a-zA-Z0-9._-]+/g, "_");
    return path.join(this.directory, `${safe}.json`);
  }
}

function assertReconciliationReceipt(receipt: Receipt): void {
  if (!/^\d{5}-\d{8}$/.test(receipt.voucherNumber ?? "")) throw new Error("La reconciliación exige un número de comprobante verificable.");
  if (!/^\d{14}$/.test(receipt.cae ?? "")) throw new Error("La reconciliación exige un CAE verificable.");
  if (!receipt.pdfPath || !path.isAbsolute(receipt.pdfPath)) throw new Error("La reconciliación exige una ruta PDF absoluta.");
  if (!receipt.metadataPath || !path.isAbsolute(receipt.metadataPath)) throw new Error("La reconciliación exige una ruta de metadatos absoluta.");
  if (!/^[a-f0-9]{64}$/i.test(receipt.pdfSha256 ?? "")) throw new Error("La reconciliación exige un hash SHA-256 verificable.");
}
