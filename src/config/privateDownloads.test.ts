import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalTemporaryRoot, makeCanonicalTemporaryDirectory } from "../testing/temporaryDirectory.js";
import { publishReservedPdf, reservePrivatePdfDestination, resolveRuntimePdfPath } from "./privateDownloads.js";

test("las descargas manuales quedan contenidas en downloads", () => {
  const root = path.join(os.tmpdir(), "arca-downloads-root");
  assert.equal(resolveRuntimePdfPath("factura.pdf", root), path.resolve(root, "factura.pdf"));
  assert.throws(() => resolveRuntimePdfPath("facturas/factura.pdf", root), /solo un nombre/);
  assert.throws(() => resolveRuntimePdfPath("../publico.pdf", root), /solo un nombre|dentro/);
  assert.throws(() => resolveRuntimePdfPath(path.join(root, "absoluto.pdf"), root), /relativ/);
  assert.throws(() => resolveRuntimePdfPath("factura.txt", root), /\.pdf/);
});

test("una reserva impide sobrescribir un PDF existente", async () => {
  const directory = await makeCanonicalTemporaryDirectory("arca-download-reserve-");
  try {
    const destination = path.join(directory, "factura.pdf");
    const reservation = await reservePrivatePdfDestination(destination, directory, directory);
    await assert.rejects(() => reservePrivatePdfDestination(destination, directory, directory), /en uso/);
    await reservation.release();
    await fs.writeFile(destination, "pdf");
    await assert.rejects(() => reservePrivatePdfDestination(destination, directory, directory), /no se sobrescribirá/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("un lock de archivo legado no bloquea la reserva del sistema operativo", async () => {
  const directory = await makeCanonicalTemporaryDirectory("arca-download-orphan-");
  try {
    const destination = path.join(directory, "factura.pdf");
    const ownerToken = "00000000-0000-4000-8000-000000000001";
    const temporaryPath = path.join(directory, `.factura.${ownerToken}.tmp.pdf`);
    await fs.writeFile(`${destination}.lock`, JSON.stringify({
      pid: 2_147_483_647,
      ownerToken,
      destination,
      temporaryPath,
      claimedAt: new Date().toISOString(),
    }));
    const reservation = await reservePrivatePdfDestination(destination, directory, directory);
    assert.notEqual(reservation.temporaryPath, temporaryPath);
    await reservation.release();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("un temporal huérfano bloquea otra reserva hasta reconciliarlo", async () => {
  const directory = await makeCanonicalTemporaryDirectory("arca-download-orphan-temp-");
  try {
    const destination = path.join(directory, "factura.pdf");
    await fs.writeFile(path.join(directory, ".factura.00000000-0000-4000-8000-000000000001.tmp.pdf"), "PDF parcial");
    await assert.rejects(
      () => reservePrivatePdfDestination(destination, directory, directory),
      /temporal huérfano.*reconciliar/i,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test("la publicación exclusiva no sobrescribe un archivo creado en paralelo", async () => {
  const directory = await makeCanonicalTemporaryDirectory("arca-download-publish-");
  try {
    const destination = path.join(directory, "factura.pdf");
    const reservation = await reservePrivatePdfDestination(destination, directory, directory);
    await fs.writeFile(reservation.temporaryPath, "nuevo-pdf", { flag: "wx" });
    await fs.writeFile(destination, "pdf-existente", { flag: "wx" });
    await assert.rejects(() => publishReservedPdf(reservation), /no se sobrescribirá/);
    assert.equal(await fs.readFile(destination, "utf8"), "pdf-existente");
    await reservation.release();
    const recoveryFiles = (await fs.readdir(directory)).filter((name) => name.includes(".recovery-") && name.endsWith(".pdf"));
    assert.equal(recoveryFiles.length, 1);
    assert.equal(await fs.readFile(path.join(directory, recoveryFiles[0] ?? ""), "utf8"), "nuevo-pdf");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test("una junction que escapa de downloads se rechaza por realpath", async (t) => {
  const root = await makeCanonicalTemporaryDirectory("arca-download-root-");
  const outside = await makeCanonicalTemporaryDirectory("arca-download-outside-");
  try {
    const linked = path.join(root, "linked");
    try {
      await fs.symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`El sistema no permite crear junctions/symlinks de prueba: ${error}`);
      return;
    }
    await assert.rejects(() => reservePrivatePdfDestination(path.join(linked, "factura.pdf"), root, root), /escapa/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});


test("una raíz downloads que es junction se rechaza", async (t) => {
  const actualRoot = await makeCanonicalTemporaryDirectory("arca-download-actual-");
  const linkParent = await makeCanonicalTemporaryDirectory("arca-download-link-parent-");
  try {
    const linkedRoot = path.join(linkParent, "downloads");
    try {
      await fs.symlink(actualRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`El sistema no permite crear junctions/symlinks de prueba: ${error}`);
      return;
    }
    await assert.rejects(() => reservePrivatePdfDestination(path.join(linkedRoot, "factura.pdf"), linkedRoot, linkParent), /raíz de downloads.*symlink|junction/);
  } finally {
    await fs.rm(linkParent, { recursive: true, force: true });
    await fs.rm(actualRoot, { recursive: true, force: true });
  }
});


test("un outputDir privado inexistente se crea antes de reservar", async () => {
  const base = await makeCanonicalTemporaryDirectory("arca-download-new-root-");
  try {
    const outputDir = path.join(base, "nuevo", "downloads");
    const reservation = await reservePrivatePdfDestination(path.join(outputDir, "factura.pdf"), outputDir, base);
    assert.equal((await fs.stat(outputDir)).isDirectory(), true);
    await reservation.release();
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("una reserva rechaza allowedRoot fuera del trustedRoot antes de crear carpetas", async () => {
  const trustedRoot = await makeCanonicalTemporaryDirectory("arca-download-trusted-");
  const outsideRoot = path.join(await canonicalTemporaryRoot(), `arca-download-forbidden-${process.pid}-${Date.now()}`);
  try {
    await assert.rejects(
      () => reservePrivatePdfDestination(path.join(outsideRoot, "factura.pdf"), outsideRoot, trustedRoot),
      /runtime privado aprobado/i,
    );
    await assert.rejects(() => fs.stat(outsideRoot), { code: "ENOENT" });
  } finally {
    await fs.rm(trustedRoot, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  }
});
