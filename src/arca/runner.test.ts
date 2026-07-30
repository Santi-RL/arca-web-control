import assert from "node:assert/strict";
import test from "node:test";
import type { ArcaCredentials, ResolvedInvoiceJob, RuntimeConfig } from "../types.js";
import { runInvoiceFlow } from "./runner.js";

test("el runner legado rechaza emitir antes de abrir el navegador", async () => {
  const config: RuntimeConfig = {
    headless: false,
    loginUrl: "https://auth.afip.gob.ar/contribuyente_/login.xhtml",
    profileRoot: "C:\\runtime-ficticio\\profiles",
    runtimeRoot: "C:\\runtime-ficticio",
  };
  const credentials: ArcaCredentials = {
    issuerKey: "20000000001",
    displayName: "Contribuyente Ficticio",
    cuit: "20000000001",
    clave: ["valor", "ficticio", "no", "operativo"].join("-"),
  };
  const job: ResolvedInvoiceJob = {
    schemaVersion: 2,
    operationId: "runner-fail-closed-001",
    issuerKey: "20000000001",
    recipientCuit: "20000000001",
    recipientVatCondition: "Consumidor Final",
    voucherType: "Factura C",
    pointOfSale: "00001",
    date: "2030-06-15",
    concept: "Servicios",
    currency: "ARS",
    billingPeriodFrom: "2030-06-01",
    billingPeriodTo: "2030-06-30",
    dueDate: "2030-06-20",
    saleCondition: "Otra",
    description: "Servicio de prueba",
    amount: 1234.56,
    amountCents: 123456,
    amountDecimal: "1234.56",
    outputDir: "C:\\runtime-ficticio\\downloads",
  };

  await assert.rejects(
    runInvoiceFlow(config, credentials, job, { guided: false, dryRun: false }),
    /CLI legado no puede emitir/,
  );
});
