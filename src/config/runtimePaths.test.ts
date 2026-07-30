import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeCanonicalTemporaryDirectory } from "../testing/temporaryDirectory.js";
import { ensureRuntimeLayout, getRuntimePathsForTesting, useLauncherVerifiedRuntimeLayout } from "./runtimePaths.js";

const execFileAsync = promisify(execFile);

function windowsPowerShellEnvironment(): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  return {
    ...process.env,
    PSModulePath: [
      path.join(programFiles, "WindowsPowerShell", "Modules"),
      path.join(systemRoot, "system32", "WindowsPowerShell", "v1.0", "Modules"),
    ].join(path.delimiter),
  };
}

function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function runWindowsPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'; ${script}`, "utf16le").toString("base64");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    encoded,
  ], { windowsHide: true, env: windowsPowerShellEnvironment() });
  return stdout.trim();
}

async function addEveryoneReadAce(target: string, directory: boolean): Promise<void> {
  const inheritance = directory
    ? "[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit"
    : "[Security.AccessControl.InheritanceFlags]::None";
  await runWindowsPowerShell([
    `$p = ${powerShellLiteral(target)}`,
    "$acl = Get-Acl -LiteralPath $p",
    "$sid = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
    `$inheritance = ${inheritance}`,
    "$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::ReadAndExecute, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)",
    "$acl.AddAccessRule($rule)",
    "(Get-Item -LiteralPath $p -Force).SetAccessControl($acl)",
  ].join("; "));
}

async function countEveryoneAces(target: string): Promise<number> {
  const output = await runWindowsPowerShell([
    `$acl = Get-Acl -LiteralPath ${powerShellLiteral(target)}`,
    "$bad = @($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-1-0' })",
    "Write-Output $bad.Count",
  ].join("; "));
  return Number.parseInt(output, 10);
}

async function aclSddl(target: string): Promise<string> {
  return await runWindowsPowerShell([
    `$acl = Get-Acl -LiteralPath ${powerShellLiteral(target)}`,
    "$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All)",
  ].join("; "));
}

test("runtime privado crea todas las carpetas fuera del repositorio", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-runtime-");
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const runtime = await ensureRuntimeLayout(getRuntimePathsForTesting(root));
  assert.equal(runtime.root, root);
  for (const directory of Object.values(runtime)) assert.equal((await fs.stat(directory)).isDirectory(), true);
});

test("runtime atestiguado exige la misma raíz y toda la estructura existente", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-runtime-attested-");
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const paths = getRuntimePathsForTesting(root);
  const created = await ensureRuntimeLayout(paths);
  const reused = await useLauncherVerifiedRuntimeLayout(root, paths);
  assert.deepEqual(reused, created);
  await assert.rejects(
    () => useLauncherVerifiedRuntimeLayout(path.join(root, "otro"), paths),
    /no coincide/i,
  );
  await fs.rm(created.logs, { recursive: true, force: true });
  await assert.rejects(
    () => useLauncherVerifiedRuntimeLayout(root, paths),
    /no está disponible/i,
  );
});

test("runtime atestiguado rechaza un directorio fijo redirigido fuera de la raíz", { skip: process.platform !== "win32" }, async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-runtime-junction-");
  const external = await makeCanonicalTemporaryDirectory("arca-runtime-external-");
  context.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  });
  const paths = getRuntimePathsForTesting(root);
  const runtime = await ensureRuntimeLayout(paths);
  await fs.rm(runtime.logs, { recursive: true, force: true });
  await fs.symlink(external, runtime.logs, "junction");
  await assert.rejects(
    () => useLauncherVerifiedRuntimeLayout(root, paths),
    /redirecciones no permitidas/i,
  );
});

test("runtime elimina ACE explícitas no autorizadas de directorios y archivos existentes", { skip: process.platform !== "win32" }, async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-runtime-acl-");
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const paths = await ensureRuntimeLayout(getRuntimePathsForTesting(root));
  const existingFile = path.join(paths.logs, "existing.jsonl");
  await fs.writeFile(existingFile, "{}\n", "utf8");
  await addEveryoneReadAce(existingFile, false);
  assert.equal(await countEveryoneAces(existingFile), 1, "la precondición debe agregar una ACE explícita al archivo");
  await addEveryoneReadAce(paths.logs, true);
  assert.equal(await countEveryoneAces(paths.logs), 1, "la precondición debe agregar una ACE al directorio");

  await ensureRuntimeLayout(paths);
  assert.equal(await countEveryoneAces(paths.logs), 0);
  assert.equal(await countEveryoneAces(existingFile), 0);
});

test("runtime rechaza un junction anidado sin alterar la ACL del destino externo", { skip: process.platform !== "win32" }, async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-runtime-nested-junction-");
  const external = await makeCanonicalTemporaryDirectory("arca-runtime-untouched-");
  const paths = await ensureRuntimeLayout(getRuntimePathsForTesting(root));
  const junction = path.join(paths.logs, "escape");
  await fs.symlink(external, junction, "junction");
  context.after(async () => {
    await fs.unlink(junction).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  });
  const before = await aclSddl(external);
  await assert.rejects(() => ensureRuntimeLayout(paths), /ACL exclusiva/i);
  assert.equal(await aclSddl(external), before);
});

test("runtime no crea carpetas externas a través de un junction preexistente", { skip: process.platform !== "win32" }, async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-runtime-parent-junction-");
  const external = await makeCanonicalTemporaryDirectory("arca-runtime-parent-external-");
  const junction = path.join(root, "jobs");
  await fs.symlink(external, junction, "junction");
  context.after(async () => {
    await fs.unlink(junction).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  });
  await assert.rejects(
    () => ensureRuntimeLayout(getRuntimePathsForTesting(root)),
    /redirección|redirecciones/i,
  );
  await assert.rejects(() => fs.access(path.join(external, "private")));
});
