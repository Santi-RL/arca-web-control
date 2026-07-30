import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadEnvCredentialForMigration, normalizeIssuerKey, readEnvCredentialForMigration } from "./credentialMigration.js";

test("normalizeIssuerKey acepta nombres humanos para la migración legacy", () => {
  assert.equal(normalizeIssuerKey("emisor de prueba"), "EMISOR_DE_PRUEBA");
  assert.equal(normalizeIssuerKey(" emisor_de_prueba "), "EMISOR_DE_PRUEBA");
});

test("la ruta de migración lee la credencial env y produce identidad canónica", () => {
  const clave = ["valor", "solo", "de", "prueba"].join("-");
  assert.deepEqual(readEnvCredentialForMigration(" Emisor de prueba ", {
    ARCA_CLIENT_EMISOR_DE_PRUEBA_CUIT: "20-00000000-1",
    ARCA_CLIENT_EMISOR_DE_PRUEBA_CLAVE: clave,
  }), {
    issuerKey: "20000000001",
    displayName: "Emisor de prueba",
    cuit: "20000000001",
    clave,
  });
});

test("migrate-env carga un archivo explícito sin habilitar el proveedor env operativo", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arca-migrate-env-"));
  const envFile = path.join(directory, "migration.env");
  const clave = ["valor", "migracion", "archivo"].join("-");
  try {
    await writeFile(envFile, [
      "ARCA_CREDENTIAL_PROVIDER=env",
      "ARCA_CLIENT_EMISOR_DE_PRUEBA_CUIT=20-00000000-1",
      `ARCA_CLIENT_EMISOR_DE_PRUEBA_CLAVE=${clave}`,
    ].join("\n"), { encoding: "utf8", flag: "wx" });
    const environment: NodeJS.ProcessEnv = {};
    const credential = loadEnvCredentialForMigration("Emisor de prueba", { environment, envFile });
    assert.equal(credential.issuerKey, "20000000001");
    assert.equal(credential.clave, clave);
    assert.equal(environment.ARCA_CREDENTIAL_PROVIDER, "env");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("los errores de migración nombran variables, pero nunca incluyen la clave", () => {
  const clave = ["secreto", "que", "no", "debe", "salir"].join("-");
  assert.throws(() => readEnvCredentialForMigration("Emisor de prueba", {
    ARCA_CLIENT_EMISOR_DE_PRUEBA_CUIT: "20-00000000-2",
    ARCA_CLIENT_EMISOR_DE_PRUEBA_CLAVE: clave,
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /CUIT válido/i);
    assert.doesNotMatch(error.message, new RegExp(clave));
    return true;
  });
});
