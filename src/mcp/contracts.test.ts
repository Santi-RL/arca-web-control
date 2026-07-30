import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { emitInput, mcpToolNames } from "./contracts.js";

test("MCP no expone herramientas genéricas ni credenciales", () => {
  assert.equal(mcpToolNames.some((name) => /click|fill|credential|secret/i.test(name)), false);
});

test("MCP exige EMITIR exacto", () => {
  const schema = z.object(emitInput);
  assert.equal(schema.safeParse({ preparedInvoiceId: "00000000-0000-4000-8000-000000000000", confirmation: "emitir" }).success, false);
  assert.equal(schema.safeParse({ preparedInvoiceId: "00000000-0000-4000-8000-000000000000", confirmation: "EMITIR" }).success, true);
});
