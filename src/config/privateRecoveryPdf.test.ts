import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeCanonicalTemporaryDirectory } from "../testing/temporaryDirectory.js";
import {
  getPrivateRecoveryInbox,
  recoveryPdfMaximumBytes,
  stagePrivateRecoveryPdf,
} from "./privateRecoveryPdf.js";

const validPdfBytes = (marker = 0x41): Buffer => {
  const bytes = Buffer.alloc(1_024, marker);
  bytes.write("%PDF-1.7\n", 0, "ascii");
  return bytes;
};

test("ingresa el PDF desde recovery-inbox y dry-run puede liberar todo temporal", async () => {
  const root = await makeCanonicalTemporaryDirectory("arca-recovery-pdf-");
  const downloads = path.join(root, "downloads");
  const inbox = getPrivateRecoveryInbox(downloads);
  await fs.mkdir(inbox, { recursive: true });
  const source = path.join(inbox, "comprobante-oficial.pdf");
  const expected = validPdfBytes();
  await fs.writeFile(source, expected, { flag: "wx" });

  try {
    const staged = await stagePrivateRecoveryPdf(source, "operacion-ficticia", downloads, root);
    const temporaryPath = staged.path;
    assert.deepEqual(await fs.readFile(temporaryPath), expected);

    // Cambiar la entrada después de la ingestión no altera la copia que luego
    // será validada y hasheada.
    await fs.writeFile(source, validPdfBytes(0x42));
    assert.deepEqual(await fs.readFile(temporaryPath), expected);

    await staged.release();
    await assert.rejects(() => fs.access(temporaryPath), { code: "ENOENT" });
    const stagingFiles = await fs.readdir(path.join(downloads, ".staging"));
    assert.deepEqual(stagingFiles, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("write publica únicamente la copia privada estable", async () => {
  const root = await makeCanonicalTemporaryDirectory("arca-recovery-publish-");
  const downloads = path.join(root, "downloads");
  const inbox = getPrivateRecoveryInbox(downloads);
  await fs.mkdir(inbox, { recursive: true });
  const source = path.join(inbox, "comprobante-oficial.pdf");
  const expected = validPdfBytes();
  await fs.writeFile(source, expected, { flag: "wx" });

  try {
    const staged = await stagePrivateRecoveryPdf(source, "operacion-ficticia", downloads, root);
    await fs.writeFile(source, validPdfBytes(0x43));
    const published = await staged.publish();
    await staged.release();
    assert.deepEqual(await fs.readFile(published), expected);
    assert.equal((await fs.lstat(published)).nlink, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rechaza fuentes externas, rutas relativas y subcarpetas", async () => {
  const root = await makeCanonicalTemporaryDirectory("arca-recovery-boundary-");
  const downloads = path.join(root, "downloads");
  const inbox = getPrivateRecoveryInbox(downloads);
  const nested = path.join(inbox, "subcarpeta");
  await fs.mkdir(nested, { recursive: true });
  const outside = path.join(root, "fuera.pdf");
  const nestedSource = path.join(nested, "comprobante.pdf");
  await fs.writeFile(outside, validPdfBytes());
  await fs.writeFile(nestedSource, validPdfBytes());

  try {
    await assert.rejects(
      () => stagePrivateRecoveryPdf(outside, "operacion-externa", downloads, root),
      /recovery-inbox/i,
    );
    await assert.rejects(
      () => stagePrivateRecoveryPdf("comprobante.pdf", "operacion-relativa", downloads, root),
      /ruta absoluta/i,
    );
    await assert.rejects(
      () => stagePrivateRecoveryPdf(nestedSource, "operacion-anidada", downloads, root),
      /directamente.*recovery-inbox/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rechaza symlinks como fuentes de recuperación", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-recovery-links-");
  const downloads = path.join(root, "downloads");
  const inbox = getPrivateRecoveryInbox(downloads);
  await fs.mkdir(inbox, { recursive: true });
  const original = path.join(root, "original.pdf");
  const symbolic = path.join(inbox, "simbolico.pdf");
  await fs.writeFile(original, validPdfBytes());

  try {
    try {
      await fs.symlink(original, symbolic, "file");
    } catch (error) {
      context.skip(`El sistema no permite crear symlinks para esta prueba: ${error}`);
      return;
    }
    await assert.rejects(
      () => stagePrivateRecoveryPdf(symbolic, "operacion-simbolica", downloads, root),
      /symlinks|enlaces|identidad/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rechaza hard links como fuentes de recuperación", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-recovery-hardlinks-");
  const downloads = path.join(root, "downloads");
  const inbox = getPrivateRecoveryInbox(downloads);
  await fs.mkdir(inbox, { recursive: true });
  const original = path.join(root, "original.pdf");
  const hard = path.join(inbox, "duro.pdf");
  await fs.writeFile(original, validPdfBytes());

  try {
    try {
      await fs.link(original, hard);
    } catch (error) {
      context.skip(`El sistema no permite crear hard links para esta prueba: ${error}`);
      return;
    }
    await assert.rejects(
      () => stagePrivateRecoveryPdf(hard, "operacion-hardlink", downloads, root),
      /hard links|identidad/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rechaza tamaños fuera del rango cerrado", async () => {
  const root = await makeCanonicalTemporaryDirectory("arca-recovery-size-");
  const downloads = path.join(root, "downloads");
  const inbox = getPrivateRecoveryInbox(downloads);
  await fs.mkdir(inbox, { recursive: true });
  const small = path.join(inbox, "pequeno.pdf");
  const large = path.join(inbox, "grande.pdf");
  await fs.writeFile(small, Buffer.alloc(1_023));
  await fs.writeFile(large, "x");
  await fs.truncate(large, recoveryPdfMaximumBytes + 1);

  try {
    await assert.rejects(
      () => stagePrivateRecoveryPdf(small, "operacion-pequena", downloads, root),
      /tamaño.*fuera del rango/i,
    );
    await assert.rejects(
      () => stagePrivateRecoveryPdf(large, "operacion-grande", downloads, root),
      /tamaño.*fuera del rango/i,
    );
    assert.deepEqual(await fs.readdir(path.join(downloads, ".staging")), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("el recuperador valida, hashea y publica solo la copia privada estable", async () => {
  const script = await fs.readFile(path.resolve("scripts", "arca-invoice-recover-pdf.mts"), "utf8");
  assert.match(
    script,
    /const current = dryRun\s*\? await ledger\.peek\(job\.operationId\)\s*:\s*await ledger\.get\(job\.operationId\);/u,
  );
  const staged = script.indexOf("await stagePrivateRecoveryPdf(");
  const inspect = script.indexOf("inspectArcaInvoicePdf(stableSource.path", staged);
  const hash = script.indexOf("sha256File(stableSource.path)", inspect);
  const publish = script.indexOf("await stableSource.publish()", hash);
  const release = script.indexOf("await stableSource.release()", publish);
  assert.ok(staged >= 0 && inspect > staged && hash > inspect && publish > hash && release > publish);
  assert.doesNotMatch(script, /inspectArcaInvoicePdf\(sourcePath|sha256File\(sourcePath|copyFile\(sourcePath/u);
  assert.doesNotMatch(script, /process\.exit\(/u);
});
