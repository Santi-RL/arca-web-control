import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeCanonicalTemporaryDirectory } from "../testing/temporaryDirectory.js";
import { ensurePrivateFile, ensureRuntimeLayout, getRuntimePathsForTesting, repairManagedRuntimeAcl, useActiveSessionRuntimeLayout, useLauncherVerifiedRuntimeLayout } from "./runtimePaths.js";

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

async function setCurrentUserListDeny(target: string, enabled: boolean): Promise<void> {
  await runWindowsPowerShell([
    `$p = ${powerShellLiteral(target)}`,
    "$item = Get-Item -LiteralPath $p -Force",
    "$acl = Get-Acl -LiteralPath $p",
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$deny = [Security.AccessControl.AccessControlType]::Deny",
    "$rules = @($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value -and $_.AccessControlType -eq $deny -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ListDirectory) -ne 0 })",
    enabled
      ? "$rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::ListDirectory, [Security.AccessControl.InheritanceFlags]::None, [Security.AccessControl.PropagationFlags]::None, $deny); $acl.AddAccessRule($rule)"
      : "foreach ($rule in $rules) { $null = $acl.RemoveAccessRuleSpecific($rule) }",
    "$item.SetAccessControl($acl)",
  ].join("; "));
}

test("runtime privado crea todas las carpetas fuera del repositorio", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-runtime-");
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const runtime = await ensureRuntimeLayout(getRuntimePathsForTesting(root));
  assert.equal(runtime.root, root);
  for (const directory of Object.values(runtime)) assert.equal((await fs.stat(directory)).isDirectory(), true);
});

test("un runtime administrado anterior exige reparación una sola vez", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-runtime-upgrade-");
  const paths = getRuntimePathsForTesting(root);
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(paths.logs, { recursive: true });
  await assert.rejects(() => ensureRuntimeLayout(paths), /única reparación administrada/i);
  await repairManagedRuntimeAcl(paths);
  await ensureRuntimeLayout(paths);
  await fs.writeFile(path.join(paths.config, "runtime-layout-v3.json"), "{}\n", "utf8");
  await assert.rejects(() => ensureRuntimeLayout(paths), /única reparación administrada/i);
  await repairManagedRuntimeAcl(paths);
  await ensureRuntimeLayout(paths);
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

test("una sesión viva o un handoff no pueden eludir el marcador de migración", async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-runtime-active-marker-");
  const paths = await ensureRuntimeLayout(getRuntimePathsForTesting(root));
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.rm(path.join(paths.config, "runtime-layout-v3.json"));
  await assert.rejects(() => useActiveSessionRuntimeLayout(paths), /única reparación administrada/i);
  await assert.rejects(() => useLauncherVerifiedRuntimeLayout(root, paths), /única reparación administrada/i);
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

test("el hot path protege límites y la reparación explícita sanea descendientes existentes", { skip: process.platform !== "win32" }, async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-runtime-acl-");
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const paths = await ensureRuntimeLayout(getRuntimePathsForTesting(root));
  const existingFile = path.join(paths.logs, "existing.jsonl");
  await fs.writeFile(existingFile, "{}\n", "utf8");
  await addEveryoneReadAce(existingFile, false);
  assert.equal(await countEveryoneAces(existingFile), 1, "la precondición debe agregar una ACE explícita al archivo");
  await addEveryoneReadAce(paths.logs, true);
  assert.equal(await countEveryoneAces(paths.logs), 1, "la precondición debe agregar una ACE al directorio");
  const marker = path.join(paths.config, "runtime-layout-v3.json");
  await addEveryoneReadAce(marker, false);
  assert.equal(await countEveryoneAces(marker), 1, "la precondición debe agregar una ACE explícita al marcador");

  await ensureRuntimeLayout(paths);
  assert.equal(await countEveryoneAces(paths.logs), 0);
  assert.equal(await countEveryoneAces(marker), 0, "el hot path debe proteger su atestación fija sin recorrer el runtime");
  assert.equal(await countEveryoneAces(existingFile), 1, "el hot path no debe recorrer archivos históricos");

  await repairManagedRuntimeAcl(paths);
  assert.equal(await countEveryoneAces(existingFile), 0);
});

test("la reparación rechaza un junction administrado sin alterar la ACL del destino externo", { skip: process.platform !== "win32" }, async (context) => {
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
  await ensureRuntimeLayout(paths);
  await assert.rejects(() => repairManagedRuntimeAcl(paths), /ACL exclusiva/i);
  assert.equal(await aclSddl(external), before);
});

test("la reparación rechaza hardlinks antes de modificar la ACL del objeto externo", { skip: process.platform !== "win32" }, async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-runtime-hardlink-");
  const external = await makeCanonicalTemporaryDirectory("arca-runtime-hardlink-external-");
  const paths = await ensureRuntimeLayout(getRuntimePathsForTesting(root));
  const externalFile = path.join(external, "externo.txt");
  const insideLink = path.join(paths.logs, "enlace-duro.txt");
  await fs.writeFile(externalFile, "contenido ficticio");
  await fs.link(externalFile, insideLink);
  context.after(async () => {
    await fs.unlink(insideLink).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  });
  const before = await aclSddl(externalFile);
  await assert.rejects(() => repairManagedRuntimeAcl(paths), /ACL exclusiva/i);
  assert.equal(await aclSddl(externalFile), before);
});

test("ensurePrivateFile rechaza un hardlink antes de alterar la ACL del objeto externo", { skip: process.platform !== "win32" }, async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-private-file-hardlink-");
  const external = await makeCanonicalTemporaryDirectory("arca-private-file-hardlink-external-");
  const externalFile = path.join(external, "externo.txt");
  const insideLink = path.join(root, "enlace-duro.txt");
  await fs.writeFile(externalFile, "contenido ficticio");
  await fs.link(externalFile, insideLink);
  context.after(async () => {
    await fs.unlink(insideLink).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  });
  const before = await aclSddl(externalFile);
  await assert.rejects(() => ensurePrivateFile(insideLink), /hard links|única identidad/i);
  assert.equal(await aclSddl(externalFile), before);
});

test("private-import y guided existentes se detectan como runtime administrado que requiere migración", async (context) => {
  for (const managedName of ["private-import", "guided"]) {
    const root = await makeCanonicalTemporaryDirectory(`arca-runtime-${managedName}-`);
    context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
    await fs.mkdir(path.join(root, managedName), { recursive: true });
    await assert.rejects(
      () => ensureRuntimeLayout(getRuntimePathsForTesting(root)),
      /única reparación administrada/i,
    );
  }
});

test("el runtime operativo y la reparación ignoran árboles históricos desconocidos", { skip: process.platform !== "win32" }, async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-runtime-unmanaged-");
  const external = await makeCanonicalTemporaryDirectory("arca-runtime-unmanaged-external-");
  const paths = await ensureRuntimeLayout(getRuntimePathsForTesting(root));
  const legacy = path.join(root, "legacy-private");
  await fs.mkdir(legacy);
  const junction = path.join(legacy, "escape");
  await fs.symlink(external, junction, "junction");
  context.after(async () => {
    await fs.unlink(junction).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  });
  const before = await aclSddl(external);

  await ensureRuntimeLayout(paths);
  await repairManagedRuntimeAcl(paths);

  assert.equal(await aclSddl(external), before);
});

test("el runtime operativo no enumera una carpeta histórica inaccesible", { skip: process.platform !== "win32" }, async (context) => {
  const root = await makeCanonicalTemporaryDirectory("arca-runtime-inaccessible-");
  const paths = await ensureRuntimeLayout(getRuntimePathsForTesting(root));
  const legacy = path.join(root, "legacy-private");
  await fs.mkdir(legacy);
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  await setCurrentUserListDeny(legacy, true);
  try {
    await assert.rejects(
      () => fs.readdir(legacy),
      (error: NodeJS.ErrnoException) => error.code === "EACCES" || error.code === "EPERM",
      "la precondición debe volver inaccesible el árbol histórico",
    );
    await ensureRuntimeLayout(paths);
    await repairManagedRuntimeAcl(paths);
  } finally {
    await setCurrentUserListDeny(legacy, false);
  }
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
