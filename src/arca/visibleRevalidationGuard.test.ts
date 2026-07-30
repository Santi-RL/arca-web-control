import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeCanonicalTemporaryDirectory } from "../testing/temporaryDirectory.js";
import { assertVisibleRevalidationAvailable, claimVisibleRevalidation, releaseVisibleRevalidationBeforeFirstClick } from "./visibleRevalidationGuard.js";

const capability = { id: "invoice-services-single-item", version: 10 };

test("la revalidación visible se reclama una sola vez y el bloqueo persiste", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-visible-revalidation-");
  const ledger = path.join(root, "ledger");
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(ledger);

  await assertVisibleRevalidationAvailable(capability, ledger);
  await claimVisibleRevalidation(
    capability,
    "invoice-chat-aaaaaaaaaaaaaaaa",
    "00000000-0000-4000-8000-000000000001",
    ledger,
  );
  await assert.rejects(() => assertVisibleRevalidationAvailable(capability, ledger), /ya fue consumida/i);
  await assert.rejects(
    () => claimVisibleRevalidation(capability, "invoice-chat-bbbbbbbbbbbbbbbb", "00000000-0000-4000-8000-000000000002", ledger),
    /segundo intento|ya fue consumida/i,
  );
});

test("una versión nueva usa una atestación independiente", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-visible-revalidation-version-");
  const ledger = path.join(root, "ledger");
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(ledger);
  await claimVisibleRevalidation(capability, "invoice-chat-aaaaaaaaaaaaaaaa", "00000000-0000-4000-8000-000000000001", ledger);
  await assertVisibleRevalidationAvailable({ ...capability, version: 11 }, ledger);
});

test("una falla conocida antes del primer clic revierte solo su propia reserva", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-visible-revalidation-rollback-");
  const ledger = path.join(root, "ledger");
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(ledger);
  const operationId = "invoice-chat-aaaaaaaaaaaaaaaa";
  const preparedInvoiceId = "00000000-0000-4000-8000-000000000001";
  await claimVisibleRevalidation(capability, operationId, preparedInvoiceId, ledger);
  await assert.rejects(
    () => releaseVisibleRevalidationBeforeFirstClick(capability, operationId, "00000000-0000-4000-8000-000000000002", ledger),
    /otra preparación/,
  );
  await assert.rejects(() => assertVisibleRevalidationAvailable(capability, ledger), /consumida/);
  await releaseVisibleRevalidationBeforeFirstClick(capability, operationId, preparedInvoiceId, ledger);
  await assertVisibleRevalidationAvailable(capability, ledger);
});
