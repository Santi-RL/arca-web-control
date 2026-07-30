import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function legacyJob(currency?: string): Record<string, unknown> {
  return {
    issuerKey: "20000000001",
    recipientCuit: "27000000006",
    recipientVatCondition: "Consumidor Final",
    voucherType: "Factura C",
    pointOfSale: "1",
    date: "2030-06-15",
    concept: "Servicios",
    currency,
    billingPeriodFrom: "2030-06-01",
    billingPeriodTo: "2030-06-30",
    saleCondition: "Transferencia Bancaria",
    description: "Servicio totalmente ficticio",
    amount: 100,
    outputDir: ".",
  };
}

test("el migrador no infiere silenciosamente la moneda de un job legado", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-job-migrate-"));
  const jobPath = path.join(directory, "legacy.json");
  await fs.writeFile(jobPath, JSON.stringify(legacyJob()));

  await assert.rejects(
    execFileAsync(process.execPath, ["--import", "tsx", "scripts/arca-job-migrate.mts", jobPath, "--dry-run"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }),
    (error: unknown) => error instanceof Error && /declarar currency: ARS.*no se inferirá/i.test(error.message),
  );
});

test("el migrador conserva una moneda ARS declarada explícitamente", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-job-migrate-"));
  const jobPath = path.join(directory, "legacy.json");
  await fs.writeFile(jobPath, JSON.stringify(legacyJob("ARS")));

  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "scripts/arca-job-migrate.mts", jobPath, "--dry-run"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const migrated = JSON.parse(stdout) as { schemaVersion: number; currency: string; issuerKey: string };
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.currency, "ARS");
  assert.equal(migrated.issuerKey, "20000000001");
});
