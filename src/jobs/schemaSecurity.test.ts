import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolvePrivateOutputDir } from "./schema.js";

test("outputDir acepta una subcarpeta relativa contenida en downloads", () => {
  const root = path.join(path.parse(process.cwd()).root, "runtime-ficticio", "downloads");
  assert.equal(resolvePrivateOutputDir("clientes/2030-06", root), path.join(root, "clientes", "2030-06"));
  assert.equal(resolvePrivateOutputDir(".", root), path.resolve(root));
});

test("outputDir rechaza rutas absolutas, UNC, drive-relative y traversal", () => {
  const root = path.join(path.parse(process.cwd()).root, "runtime-ficticio", "downloads");
  assert.throws(() => resolvePrivateOutputDir(path.resolve("fuera"), root), /absolutas/i);
  assert.throws(() => resolvePrivateOutputDir("\\\\servidor\\facturas", root), /UNC|absolutas/i);
  assert.throws(() => resolvePrivateOutputDir("C:facturas", root), /absolutas/i);
  assert.throws(() => resolvePrivateOutputDir("../fuera", root), /\.\./i);
  assert.throws(() => resolvePrivateOutputDir("cliente/../../fuera", root), /\.\./i);
  assert.throws(() => resolvePrivateOutputDir("%LOCALAPPDATA%\\ManejoARCA\\downloads", root), /caracteres/i);
});
