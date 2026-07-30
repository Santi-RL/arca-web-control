import assert from "node:assert/strict";
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
