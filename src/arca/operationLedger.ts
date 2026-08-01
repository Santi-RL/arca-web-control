import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { getRuntimePaths } from "../config/runtimePaths.js";
import { readJsonIfExists, writeJsonAtomic } from "../io/atomicJson.js";
import { isProcessAlive } from "../io/processLock.js";
import { acquireLocalOsMutex } from "../io/osMutex.js";

export type OperationStatus = "prepared" | "emitting" | "emitted" | "failed_before_emit" | "unknown";
const OPERATION_STATUSES = new Set<OperationStatus>(["prepared", "emitting", "emitted", "failed_before_emit", "unknown"]);

type LedgerOwner = {
  pid: number;
  token: string;
  claimedAt: string;
};

export type LedgerEntry = {
  operationId: string;
  status: OperationStatus;
  preparedInvoiceId?: string;
  jobHash: string;
  updatedAt: string;
  issuer?: { cuit: string; name: string };
  owner?: LedgerOwner;
  receipt?: { voucherNumber?: string; cae?: string; pdfPath?: string; metadataPath?: string; pdfSha256?: string };
  detail?: string;
};

type Receipt = NonNullable<LedgerEntry["receipt"]>;

export type OperationLedgerOptions = {
  pid?: number;
  ownerToken?: string;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => Date;
};

const preparedOwnerMaximumAgeMs = 60 * 60 * 1000;
const emittingOwnerMaximumAgeMs = 15 * 60 * 1000;

export class OperationLedger {
  private readonly pid: number;
  private readonly ownerToken: string;
  private readonly processIsAlive: (pid: number) => boolean;
  private readonly now: () => Date;

  constructor(private readonly directory = getRuntimePaths().ledger, options: OperationLedgerOptions = {}) {
    this.pid = options.pid ?? process.pid;
    this.ownerToken = options.ownerToken ?? randomUUID();
    this.processIsAlive = options.isProcessAlive ?? isProcessAlive;
    this.now = options.now ?? (() => new Date());
  }

  async peek(operationId: string): Promise<LedgerEntry | undefined> {
    return await this.withOperationLock(
      operationId,
      async () => await this.readValidated(operationId),
      { ensureDirectory: false },
    );
  }

  async get(operationId: string): Promise<LedgerEntry | undefined> {
    return await this.withOperationLock(operationId, async () => {
      const existing = await this.readValidated(operationId);
      if (!existing || existing.status !== "emitting" || this.emittingOwnerIsActive(existing.owner)) return existing;
      return await this.write({
        operationId,
        status: "unknown",
        preparedInvoiceId: existing.preparedInvoiceId,
        jobHash: existing.jobHash,
        issuer: existing.issuer,
        receipt: existing.receipt,
        detail: "Se detectó una emisión huérfana después de finalizar su proceso propietario. Debe consultarse ARCA y reconciliarse; nunca se reintentará automáticamente.",
      });
    });
  }

  async claimPreparation(operationId: string, jobHash: string, preparedInvoiceId?: string): Promise<LedgerEntry> {
    return await this.withOperationLock(operationId, async () => {
      const existing = await this.readValidated(operationId);
      if (existing) {
        const reclaimablePrepared = existing.status === "prepared" && !this.preparedOwnerIsActive(existing.owner);
        const revisableBeforeEmit = existing.status === "failed_before_emit" || reclaimablePrepared;
        if (existing.status === "unknown" || existing.status === "emitting") {
          throw new Error(`La operación ${operationId} está en estado ${existing.status}: está prohibido reintentar o crear otra intención para eludirla; consultá ARCA y reconciliá el resultado.`);
        }
        if (existing.status === "emitted") {
          throw new Error(`La operación ${operationId} ya fue emitida. Esta intención no se reutiliza; solo una solicitud comercial humana realmente nueva puede iniciar otra factura.`);
        }
        if (existing.jobHash !== jobHash && !revisableBeforeEmit) {
          throw new Error(`La operación ${operationId} conserva otra preparación activa; cerrala o reconstruí su misma revisión antes de cambiar el borrador.`);
        }
        if (existing.status !== "failed_before_emit" && !reclaimablePrepared) {
          throw new Error(`La operación ${operationId} ya está en estado ${existing.status}; solo failed_before_emit o una preparación huérfana permiten reconstruirla.`);
        }
      }
      return await this.write({ operationId, status: "prepared", preparedInvoiceId, jobHash, owner: this.currentOwner() });
    });
  }

  async claimEmission(operationId: string, preparedInvoiceId: string, jobHash: string): Promise<LedgerEntry> {
    return await this.withOperationLock(operationId, async () => {
      const existing = await this.readValidated(operationId);
      if (!this.matchesCurrentPreparation(existing, preparedInvoiceId, jobHash)) {
        throw new Error(`La operación ${operationId} no puede pasar de ${existing?.status ?? "inexistente"} a emitting; la preparación vigente o su proceso propietario no coinciden.`);
      }
      if (!existing) throw new Error("La preparación desapareció durante la reserva de emisión.");
      return await this.write({
        operationId,
        status: "emitting",
        preparedInvoiceId,
        jobHash,
        issuer: existing.issuer,
        owner: this.currentOwner(),
      });
    });
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
      if (!this.ownerIsCurrent(existing.owner)) {
        throw new Error(`La operación ${operationId} pertenece a otro proceso de preparación.`);
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

  async markFailedBeforeFirstClick(operationId: string, preparedInvoiceId: string, jobHash: string, detail: string): Promise<LedgerEntry> {
    return await this.transition(operationId, preparedInvoiceId, jobHash, "emitting", "failed_before_emit", { detail });
  }

  async markEmitted(operationId: string, preparedInvoiceId: string, jobHash: string, receipt: Receipt): Promise<LedgerEntry> {
    assertCompleteReceipt(receipt);
    return await this.transition(operationId, preparedInvoiceId, jobHash, "emitting", "emitted", { receipt });
  }

  async reconcileUnknownAsEmitted(operationId: string, jobHash: string, receipt: Receipt): Promise<LedgerEntry> {
    assertCompleteReceipt(receipt);
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
      const ownerMatches = (expected !== "prepared" && expected !== "emitting") || this.ownerIsCurrent(existing?.owner);
      if (!existing || existing.status !== expected || existing.jobHash !== jobHash || existing.preparedInvoiceId !== preparedInvoiceId || !ownerMatches) {
        throw new Error(`La operación ${operationId} no puede pasar de ${existing?.status ?? "inexistente"} a ${status}; la preparación vigente no coincide.`);
      }
      return await this.write({ operationId, status, preparedInvoiceId, jobHash, issuer: existing.issuer, ...extra });
    });
  }

  private async write(entry: Omit<LedgerEntry, "updatedAt">): Promise<LedgerEntry> {
    const complete: LedgerEntry = { ...entry, updatedAt: this.now().toISOString() };
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

  private currentOwner(): LedgerOwner {
    return { pid: this.pid, token: this.ownerToken, claimedAt: this.now().toISOString() };
  }

  private ownerIsCurrent(owner: LedgerOwner | undefined): boolean {
    return isValidOwner(owner) && owner.pid === this.pid && owner.token === this.ownerToken;
  }

  private ownerProcessIsActive(owner: LedgerOwner | undefined): boolean {
    return isValidOwner(owner) && (this.ownerIsCurrent(owner) || this.processIsAlive(owner.pid));
  }

  private preparedOwnerIsActive(owner: LedgerOwner | undefined): boolean {
    return this.ownerProcessIsActive(owner) && this.ownerAgeIsWithin(owner!, preparedOwnerMaximumAgeMs);
  }

  private emittingOwnerIsActive(owner: LedgerOwner | undefined): boolean {
    return this.ownerProcessIsActive(owner) && this.ownerAgeIsWithin(owner!, emittingOwnerMaximumAgeMs);
  }

  private ownerAgeIsWithin(owner: LedgerOwner, maximumAgeMs: number): boolean {
    const age = this.now().valueOf() - Date.parse(owner.claimedAt);
    return Number.isFinite(age) && age >= -60_000 && age < maximumAgeMs;
  }

  private matchesCurrentPreparation(existing: LedgerEntry | undefined, preparedInvoiceId: string, jobHash: string): boolean {
    return Boolean(existing
      && existing.status === "prepared"
      && existing.jobHash === jobHash
      && existing.preparedInvoiceId === preparedInvoiceId
      && this.ownerIsCurrent(existing.owner));
  }

  private async withOperationLock<T>(
    operationId: string,
    action: () => Promise<T>,
    options: { ensureDirectory?: boolean } = {},
  ): Promise<T> {
    if (options.ensureDirectory !== false) await fs.mkdir(this.directory, { recursive: true });
    const release = await acquireLocalOsMutex(
      `operation-ledger\0${path.resolve(this.directory)}\0${operationId}`,
      `la operación ${operationId}`,
    );
    try {
      return await action();
    } finally {
      await release();
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

function assertCompleteReceipt(receipt: Receipt): void {
  if (!/^\d{5}-\d{8}$/.test(receipt.voucherNumber ?? "")) throw new Error("El estado emitted exige un número de comprobante verificable.");
  if (!/^\d{14}$/.test(receipt.cae ?? "")) throw new Error("El estado emitted exige un CAE verificable.");
  if (!receipt.pdfPath || !path.isAbsolute(receipt.pdfPath)) throw new Error("El estado emitted exige una ruta PDF absoluta.");
  if (!receipt.metadataPath || !path.isAbsolute(receipt.metadataPath)) throw new Error("El estado emitted exige una ruta de metadatos absoluta.");
  if (!/^[a-f0-9]{64}$/i.test(receipt.pdfSha256 ?? "")) throw new Error("El estado emitted exige un hash SHA-256 verificable.");
}

function isValidOwner(owner: LedgerOwner | undefined): owner is LedgerOwner {
  return Boolean(owner
    && Number.isSafeInteger(owner.pid)
    && owner.pid > 0
    && /^[a-f0-9-]{16,128}$/iu.test(owner.token)
    && Number.isFinite(Date.parse(owner.claimedAt)));
}
