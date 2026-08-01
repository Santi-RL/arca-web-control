import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { startArcaPerformance } from "./performance.js";

test("una medición cerrada se informa una sola vez y sin datos fiscales", () => {
  const previous = process.env.ARCA_PERF_TRACE;
  const messages: string[] = [];
  const originalError = console.error;
  process.env.ARCA_PERF_TRACE = "1";
  console.error = (message?: unknown) => { messages.push(String(message)); };
  try {
    const finish = startArcaPerformance("emission_confirmation_to_pdf");
    const first = finish("ok");
    const second = finish("failed");
    assert.equal(second, first);
    assert.deepEqual(messages.length, 1);
    assert.match(messages[0] ?? "", /^ARCA_PERF stage=emission_confirmation_to_pdf duration_ms=\d+ outcome=ok$/u);
  } finally {
    console.error = originalError;
    if (previous === undefined) delete process.env.ARCA_PERF_TRACE;
    else process.env.ARCA_PERF_TRACE = previous;
  }
});

test("la medición confirmación a PDF se cierra al guardar la descarga y antes de validarla", async () => {
  const source = await fs.readFile(new URL("./liveSession.ts", import.meta.url), "utf8");
  const saved = source.indexOf("const stagingPdfPath = await this.savePrintPdf");
  const measured = source.indexOf("const confirmationToPdfMs = onPdfObtained?.()", saved);
  const inspected = source.indexOf("const pdfEvidence = await inspectArcaInvoicePdf", saved);
  assert.ok(saved >= 0 && measured > saved && inspected > measured);
});
