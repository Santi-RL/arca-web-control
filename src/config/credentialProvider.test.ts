import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeCanonicalTemporaryDirectory } from "../testing/temporaryDirectory.js";
import {
  describeCredentialProvider,
  credentialProviderFingerprint,
  loadConfiguredCredential,
  loadCredentialProviderSelection,
  resolveConfiguredCredential,
  saveCredentialProviderSelection,
} from "./credentialProvider.js";
import { getRuntimePathsForTesting } from "./runtimePaths.js";

const sentinel = ["secreto", "centinela", "no-real"].join("-");

test("json-file se configura fuera de Git y resuelve por CUIT o nombre unívoco", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-provider-");
  const runtime = getRuntimePathsForTesting(path.join(root, "runtime"));
  const credentialFile = path.join(root, "credenciales.json");
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(runtime.config, { recursive: true });
  await fs.writeFile(credentialFile, JSON.stringify({
    schemaVersion: 1,
    credentials: [{ cuit: "20-00000000-1", displayName: "Emisor Ficticio", clave: sentinel }],
  }), "utf8");

  await saveCredentialProviderSelection(runtime, { schemaVersion: 1, provider: "json-file", file: credentialFile });
  const selection = loadCredentialProviderSelection(runtime);
  assert.equal(selection.provider, "json-file");
  assert.deepEqual(describeCredentialProvider(selection), { provider: "json-file" });
  assert.equal(JSON.stringify(describeCredentialProvider(selection)).includes(credentialFile), false);
  assert.equal(selection.provider === "json-file" ? selection.identities?.[0]?.cuit : undefined, "20000000001");
  assert.equal(resolveConfiguredCredential(runtime, "Emisor Ficticio").cuit, "20000000001");
  assert.equal(resolveConfiguredCredential(runtime, "20-00000000-1").cuit, "20000000001");
  assert.equal(loadConfiguredCredential(runtime, "20000000001").clave, sentinel);
});

test("json-file detiene nombres ambiguos y nunca incluye claves en el error", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-provider-ambiguous-");
  const runtime = getRuntimePathsForTesting(path.join(root, "runtime"));
  const credentialFile = path.join(root, "credenciales.json");
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(runtime.config, { recursive: true });
  await fs.writeFile(credentialFile, JSON.stringify({
    schemaVersion: 1,
    credentials: [
      { cuit: "20000000001", displayName: "Nombre Repetido", clave: sentinel },
      { cuit: "27000000006", displayName: "Nombre Repetido", clave: [sentinel, "2"].join("-") },
    ],
  }), "utf8");
  await saveCredentialProviderSelection(runtime, { schemaVersion: 1, provider: "json-file", file: credentialFile });

  assert.throws(() => resolveConfiguredCredential(runtime, "Nombre Repetido"), (error: Error) => {
    assert.match(error.message, /ARCA_CREDENTIAL_AMBIGUOUS/);
    assert.doesNotMatch(error.message, new RegExp(sentinel));
    return true;
  });
});

test("json-file rechaza CUIT duplicado, enlaces y archivos dentro del repositorio", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-provider-invalid-");
  const runtime = getRuntimePathsForTesting(path.join(root, "runtime"));
  const duplicateFile = path.join(root, "duplicadas.json");
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(runtime.config, { recursive: true });
  await fs.writeFile(duplicateFile, JSON.stringify({
    schemaVersion: 1,
    credentials: [
      { cuit: "20000000001", displayName: "Primero", clave: sentinel },
      { cuit: "20-00000000-1", displayName: "Duplicado", clave: [sentinel, "2"].join("-") },
    ],
  }), "utf8");
  await assert.rejects(
    saveCredentialProviderSelection(runtime, { schemaVersion: 1, provider: "json-file", file: duplicateFile }),
    /CUIT inválido o duplicado/,
  );
  await assert.rejects(
    saveCredentialProviderSelection(runtime, { schemaVersion: 1, provider: "json-file", file: path.join(process.cwd(), "package.json") }),
    /repositorio/,
  );

  if (process.platform === "win32") {
    const external = path.join(root, "external");
    const junction = path.join(root, "credential-link");
    await fs.mkdir(external);
    await fs.copyFile(duplicateFile, path.join(external, "credenciales.json"));
    await fs.symlink(external, junction, "junction");
    await assert.rejects(
      saveCredentialProviderSelection(runtime, { schemaVersion: 1, provider: "json-file", file: path.join(junction, "credenciales.json") }),
      /enlace|junction/,
    );

    const hardLink = path.join(root, "credential-hard-link.json");
    await fs.link(path.join(process.cwd(), "package.json"), hardLink);
    await assert.rejects(
      saveCredentialProviderSelection(runtime, { schemaVersion: 1, provider: "json-file", file: hardLink }),
      /enlace|junction/,
    );
  }
});

test("json-file rechaza nombres con saltos de línea antes de iniciar una sesión", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-provider-control-name-");
  const runtime = getRuntimePathsForTesting(path.join(root, "runtime"));
  const credentialFile = path.join(root, "credenciales.json");
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(runtime.config, { recursive: true });
  await fs.writeFile(credentialFile, JSON.stringify({
    schemaVersion: 1,
    credentials: [{ cuit: "20000000001", displayName: "Emisor\nFicticio", clave: sentinel }],
  }), "utf8");
  await assert.rejects(
    saveCredentialProviderSelection(runtime, { schemaVersion: 1, provider: "json-file", file: credentialFile }),
    /validar el archivo de credenciales|caracteres de control/i,
  );
});

test("la selección temporal explícita prevalece y windows tolera una ruta residual", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-provider-env-");
  const runtime = getRuntimePathsForTesting(path.join(root, "runtime"));
  const credentialFile = path.join(root, "credenciales.json");
  const previousProvider = process.env.ARCA_CREDENTIAL_PROVIDER;
  const previousFile = process.env.ARCA_CREDENTIAL_FILE;
  context.after(async () => {
    if (previousProvider === undefined) delete process.env.ARCA_CREDENTIAL_PROVIDER;
    else process.env.ARCA_CREDENTIAL_PROVIDER = previousProvider;
    if (previousFile === undefined) delete process.env.ARCA_CREDENTIAL_FILE;
    else process.env.ARCA_CREDENTIAL_FILE = previousFile;
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(runtime.config, { recursive: true });
  await fs.writeFile(credentialFile, JSON.stringify({
    schemaVersion: 1,
    credentials: [{ cuit: "20000000001", displayName: "Emisor Temporal", clave: sentinel }],
  }), "utf8");
  await saveCredentialProviderSelection(runtime, { schemaVersion: 1, provider: "json-file", file: credentialFile });

  process.env.ARCA_CREDENTIAL_PROVIDER = "windows";
  process.env.ARCA_CREDENTIAL_FILE = "C:\\ruta\\residual.json";
  assert.deepEqual(loadCredentialProviderSelection(runtime), { schemaVersion: 1, provider: "windows" });

  process.env.ARCA_CREDENTIAL_PROVIDER = "json-file";
  process.env.ARCA_CREDENTIAL_FILE = credentialFile;
  assert.deepEqual(loadCredentialProviderSelection(runtime), {
    schemaVersion: 1,
    provider: "json-file",
    file: await fs.realpath(credentialFile),
  });
});

test("la huella y el índice bloquean cambios del archivo posteriores a su selección", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-provider-drift-");
  const runtime = getRuntimePathsForTesting(path.join(root, "runtime"));
  const credentialFile = path.join(root, "credenciales.json");
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(runtime.config, { recursive: true });
  await fs.writeFile(credentialFile, JSON.stringify({
    schemaVersion: 1,
    credentials: [{ cuit: "20000000001", displayName: "Emisor Estable", clave: sentinel }],
  }), "utf8");
  await saveCredentialProviderSelection(runtime, { schemaVersion: 1, provider: "json-file", file: credentialFile });
  const before = credentialProviderFingerprint(runtime);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.appendFile(credentialFile, " ", "utf8");
  assert.throws(() => credentialProviderFingerprint(runtime), /cambió desde que fue seleccionado/i);
  assert.throws(() => resolveConfiguredCredential(runtime, "Emisor Estable"), /cambió desde que fue seleccionado/i);
  assert.match(before, /^[a-f0-9]{64}$/u);
});
