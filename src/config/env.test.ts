import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalCuitSelector,
  loadCredentials,
  loadCredentialsAsync,
  loadRuntimeConfig,
  resolveCredentialIdentity,
  resolveCredentialRoutingIdentity,
} from "./env.js";

test("el routing canónico resuelve un CUIT localmente y rechaza un DV inválido", () => {
  const previousProvider = process.env.ARCA_CREDENTIAL_PROVIDER;
  try {
    process.env.ARCA_CREDENTIAL_PROVIDER = "windows";
    assert.equal(canonicalCuitSelector("20-00000000-1"), "20000000001");
    assert.deepEqual(resolveCredentialRoutingIdentity("20-00000000-1"), {
      issuerKey: "20000000001",
      cuit: "20000000001",
    });
    assert.equal(canonicalCuitSelector("Emisor de prueba"), undefined);
    assert.throws(() => canonicalCuitSelector("20-00000000-2"), /CUIT válido/i);
  } finally {
    restoreEnv("ARCA_CREDENTIAL_PROVIDER", previousProvider);
  }
});

test("un proveedor temporal desconocido queda bloqueado y los errores no exponen secretos", async () => {
  const testValue = ["valor", "no", "real"].join("-");
  const previous = {
    provider: process.env.ARCA_CREDENTIAL_PROVIDER,
    file: process.env.ARCA_CREDENTIAL_FILE,
    cuit: process.env.ARCA_CLIENT_EMISOR_PRUEBA_CUIT,
    clave: process.env.ARCA_CLIENT_EMISOR_PRUEBA_CLAVE,
  };
  try {
    process.env.ARCA_CREDENTIAL_PROVIDER = "desconocido";
    delete process.env.ARCA_CREDENTIAL_FILE;
    process.env.ARCA_CLIENT_EMISOR_PRUEBA_CUIT = "20-00000000-1";
    process.env.ARCA_CLIENT_EMISOR_PRUEBA_CLAVE = testValue;
    const assertPublicError = (error: unknown): boolean => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /ARCA_CREDENTIAL_PROVIDER_UNAVAILABLE/i);
      assert.doesNotMatch(error.message, new RegExp(testValue));
      return true;
    };
    assert.throws(() => loadCredentials("Emisor Prueba"), assertPublicError);
    await assert.rejects(loadCredentialsAsync("Emisor Prueba"), assertPublicError);
    assert.throws(() => resolveCredentialIdentity("Emisor Prueba"), assertPublicError);
    assert.deepEqual(resolveCredentialRoutingIdentity("20-00000000-1"), {
      issuerKey: "20000000001",
      cuit: "20000000001",
    });
  } finally {
    restoreEnv("ARCA_CREDENTIAL_PROVIDER", previous.provider);
    restoreEnv("ARCA_CREDENTIAL_FILE", previous.file);
    restoreEnv("ARCA_CLIENT_EMISOR_PRUEBA_CUIT", previous.cuit);
    restoreEnv("ARCA_CLIENT_EMISOR_PRUEBA_CLAVE", previous.clave);
  }
});

test("loadRuntimeConfig rejects accidental headless real flows", () => {
  const previousHeadless = process.env.ARCA_HEADLESS;

  try {
    process.env.ARCA_HEADLESS = "true";

    assert.throws(() => loadRuntimeConfig(), /ARCA_HEADLESS=true/);
  } finally {
    restoreEnv("ARCA_HEADLESS", previousHeadless);
  }
});

test("loadRuntimeConfig rechaza redirigir el login o los perfiles fuera del runtime canónico", () => {
  const previousLogin = process.env.ARCA_LOGIN_URL;
  const previousProfile = process.env.ARCA_PROFILE_ROOT;
  try {
    process.env.ARCA_LOGIN_URL = "https://example.invalid/login";
    assert.throws(() => loadRuntimeConfig(), /ARCA_LOGIN_URL no está permitido/);
    delete process.env.ARCA_LOGIN_URL;
    process.env.ARCA_PROFILE_ROOT = "C:\\ruta-no-canonica";
    assert.throws(() => loadRuntimeConfig(), /ARCA_PROFILE_ROOT no está permitido/);
  } finally {
    restoreEnv("ARCA_LOGIN_URL", previousLogin);
    restoreEnv("ARCA_PROFILE_ROOT", previousProfile);
  }
});

test("loadRuntimeConfig accepts explicit Playwright browser channel", () => {
  const previousChannel = process.env.ARCA_PLAYWRIGHT_CHANNEL;

  try {
    process.env.ARCA_PLAYWRIGHT_CHANNEL = "chrome";

    assert.equal(loadRuntimeConfig().browserChannel, "chrome");
  } finally {
    restoreEnv("ARCA_PLAYWRIGHT_CHANNEL", previousChannel);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
