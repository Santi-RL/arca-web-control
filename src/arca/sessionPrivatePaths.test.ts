import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeCanonicalTemporaryDirectory } from "../testing/temporaryDirectory.js";
import { prepareSessionPrivatePaths } from "./sessionPrivatePaths.js";

test("rechaza artifacts y perfiles redirigidos antes de crear artefactos de sesión", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-session-private-");
  const external = await makeCanonicalTemporaryDirectory("arca-session-private-external-");
  const config = { runtimeRoot: root, profileRoot: path.join(root, "profiles") };
  const artifacts = path.join(root, "sessions", "artifacts");
  await fs.mkdir(path.dirname(artifacts), { recursive: true });
  await fs.mkdir(config.profileRoot, { recursive: true });
  await fs.symlink(external, artifacts, process.platform === "win32" ? "junction" : "dir");
  context.after(async () => {
    await fs.rm(path.join(config.profileRoot, "session_20000000001"), { force: true }).catch(() => undefined);
    await fs.rm(artifacts, { force: true }).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  });

  await assert.rejects(() => prepareSessionPrivatePaths({
    config,
    issuerKey: "20000000001",
    artifactName: "2030-06-15T00-00-00-000Z",
  }), /enlace|junction/i);
  await assert.rejects(() => fs.access(path.join(external, "2030-06-15T00-00-00-000Z")));

  await fs.rm(artifacts, { force: true });
  await fs.mkdir(artifacts);
  const profile = path.join(config.profileRoot, "session_20000000001");
  await fs.symlink(external, profile, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => prepareSessionPrivatePaths({
    config,
    issuerKey: "20000000001",
    artifactName: "2030-06-15T00-00-00-001Z",
  }), /enlace|junction/i);
  await assert.rejects(() => fs.access(path.join(artifacts, "2030-06-15T00-00-00-001Z")));
});

test("rechaza raíces ordinarias que queden fuera del runtime privado", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-session-contained-");
  const external = await makeCanonicalTemporaryDirectory("arca-session-contained-external-");
  context.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  });
  await assert.rejects(() => prepareSessionPrivatePaths({
    config: { runtimeRoot: root, profileRoot: path.join(root, "profiles") },
    issuerKey: "20000000001",
    artifactName: "2030-06-15T00-00-00-000Z",
    artifactRoot: external,
  }), /dentro del runtime privado/i);
});
