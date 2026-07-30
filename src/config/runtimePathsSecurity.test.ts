import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertOperationalRuntimeEnvironment, ensurePrivateDirectory, getRuntimePaths } from "./runtimePaths.js";

test("el runtime operativo rechaza ARCA_RUNTIME_ROOT aunque apunte fuera del repositorio", () => {
  const previousRoot = process.env.ARCA_RUNTIME_ROOT;
  try {
    process.env.ARCA_RUNTIME_ROOT = path.join(os.tmpdir(), "arca-private-runtime");
    assert.throws(() => getRuntimePaths(), /ARCA_RUNTIME_ROOT no está permitido/i);
  } finally {
    if (previousRoot === undefined) delete process.env.ARCA_RUNTIME_ROOT; else process.env.ARCA_RUNTIME_ROOT = previousRoot;
  }
});

test("NODE_ENV=test no puede desactivar las garantías de un comando operativo", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "test";
    assert.throws(() => assertOperationalRuntimeEnvironment(), /NODE_ENV=test no está permitido/i);
    assert.throws(() => getRuntimePaths(), /NODE_ENV=test no está permitido/i);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("el helper aplica una DACL privada sin requerir privilegios administrativos", { skip: process.platform !== "win32" }, async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-acl-test-"));
  context.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  await ensurePrivateDirectory(directory);
});

test("el helper rechaza un junction antes de aplicar la ACL", { skip: process.platform !== "win32" }, async (context) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "arca-acl-junction-"));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "arca-acl-external-"));
  const junction = path.join(parent, "redirected");
  await fs.symlink(external, junction, "junction");
  context.after(async () => {
    await fs.unlink(junction).catch(() => undefined);
    await fs.rm(parent, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  });
  await assert.rejects(() => ensurePrivateDirectory(junction), /enlace|junction/i);
});
