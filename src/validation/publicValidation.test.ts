import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { checkPublicPath, isAllowedGitNoreplyEmail, redactRepositoryIssuePaths, scanPublicFileName, scanPublicText, validatePublicRepository } from "../../scripts/public-repo-check.mjs";
import { validateSkill } from "../../scripts/validate-skill.mjs";

const execFileAsync = promisify(execFile);

test("validate-skill acepta la estructura canónica y referencias directas", async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), "validator-skill-test-"));
  try {
    const skillRoot = path.join(root, "sample-skill");
    await fs.mkdir(path.join(skillRoot, "agents"), { recursive: true });
    await fs.mkdir(path.join(skillRoot, "references"), { recursive: true });
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), [
      "---",
      "name: sample-skill",
      "description: Ejecutar una tarea de prueba reproducible.",
      "---",
      "",
      "Leer `references/runtime.md` antes de operar.",
      "",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(skillRoot, "agents", "openai.yaml"), [
      "interface:",
      "  display_name: \"Sample Skill\"",
      "  short_description: \"Tarea de prueba reproducible\"",
      "  default_prompt: \"Usa $sample-skill para ejecutar la prueba.\"",
      "",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(skillRoot, "references", "runtime.md"), "# Runtime\n", "utf8");

    assert.deepEqual(await validateSkill(skillRoot), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("validate-skill rechaza metadata, referencias y auxiliares inválidos", async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), "validator-skill-test-"));
  try {
    const skillRoot = path.join(root, "wrong-folder");
    await fs.mkdir(path.join(skillRoot, "agents"), { recursive: true });
    await fs.mkdir(path.join(skillRoot, "references"), { recursive: true });
    await fs.writeFile(path.join(skillRoot, "SKILL.md"), [
      "---",
      "name: sample-skill",
      "description: Prueba.",
      "metadata: no-admitida",
      "---",
      "Leer `references/missing.md`.",
      "",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(skillRoot, "agents", "openai.yaml"), [
      "interface:",
      "  display_name: Sample Skill",
      "  short_description: \"Breve\"",
      "  default_prompt: \"Ejecuta la prueba.\"",
      "",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(skillRoot, "references", "orphan.md"), "# Huérfana\n", "utf8");
    await fs.writeFile(path.join(skillRoot, "README.md"), "No admitido.\n", "utf8");

    const categories = (await validateSkill(skillRoot)).map((issue) => issue.category);
    assert.equal(categories.some((category) => category.includes("solo admite")), true);
    assert.equal(categories.some((category) => category.includes("no coincide")), true);
    assert.equal(categories.some((category) => category.includes("no existe")), true);
    assert.equal(categories.some((category) => category.includes("no está enlazada")), true);
    assert.equal(categories.some((category) => category.includes("archivo auxiliar")), true);
    assert.equal(categories.some((category) => category.includes("entre comillas")), true);
    assert.equal(categories.some((category) => category.includes("$nombre")), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("public-repo-check bloquea rutas privadas y permite plantillas explícitas", () => {
  assert.deepEqual(checkPublicPath(".env.local.example"), []);
  assert.equal(checkPublicPath(".env.local").some((issue) => issue.category.includes("entorno privado")), true);
  assert.equal(checkPublicPath("artifacts/comprobante.pdf").some((issue) => issue.category.includes("ruta reservada")), true);
  assert.equal(checkPublicPath("artifacts/comprobante.pdf").some((issue) => issue.category.includes("formato privado")), true);
  assert.equal(checkPublicPath("jobs/factura.example.json").length, 0);
  assert.equal(checkPublicPath("jobs/factura-real.txt").some((issue) => issue.category.includes("job no anonimizado")), true);
});

test("public-repo-check admite fixtures sintéticas y detecta PII sin devolver valores", () => {
  const safe = [
    "CUIT 20000000001",
    "CUIT 27-00000000-6",
    "CAE 99999999999999",
    "Comprobante 00001-00000042",
    "correo demo@example.com",
  ].join("\n");
  assert.deepEqual(scanPublicText(safe, "fixture.txt"), []);

  const unknownCuit = ["20", "98765432", "1"].join("");
  const personalEmail = ["persona", "dominio-real.invalid.ar"].join("@");
  const text = `línea segura\n${unknownCuit}\n${personalEmail}`;
  const issues = scanPublicText(text, "fixture.txt");
  assert.equal(issues.some((issue) => issue.category.includes("identificador fiscal")), true);
  assert.equal(issues.some((issue) => issue.category.includes("correo electrónico")), true);
  assert.equal(JSON.stringify(issues).includes(unknownCuit), false);
  assert.equal(JSON.stringify(issues).includes(personalEmail), false);
  assert.equal(issues.every((issue) => issue.file === "fixture.txt" && typeof issue.line === "number"), true);
});

test("public-repo-check detecta claves fiscales aunque sean cortas y permite valores vacíos", () => {
  assert.deepEqual(scanPublicText("ARCA_CLIENT_DEMO_CLAVE=", ".env.local.example"), []);
  assert.deepEqual(scanPublicText("ARCA_CLIENT_DEMO_CLAVE=\"\"", ".env.local.example"), []);
  const issues = scanPublicText("ARCA_CLIENT_DEMO_CLAVE=abc12345", ".env.local.example");
  assert.equal(issues.some((issue) => issue.category.includes("clave fiscal")), true);
  assert.equal(JSON.stringify(issues).includes("abc12345"), false);
});

test("public-repo-check no refleja PII encontrada en nombres de archivo", () => {
  const privateIdentifier = ["2098765432", "1"].join("");
  const issues = scanPublicFileName(`fixtures/${privateIdentifier}.txt`);
  assert.equal(issues.some((issue) => issue.category.includes("nombre o ruta")), true);
  assert.equal(JSON.stringify(issues).includes(privateIdentifier), false);
  assert.equal(issues.every((issue) => issue.file === "[ruta-de-archivo-redactada]"), true);
});

test("public-repo-check redacta toda ruta antes de devolver findings del repositorio", () => {
  const privateName = "nombre-apellido.csv";
  const [issue] = redactRepositoryIssuePaths([{ file: `jobs/private/${privateName}`, category: "ruta privada" }]);
  assert.ok(issue);
  assert.equal(issue.file.startsWith("[archivo-"), true);
  assert.equal(issue.file.includes(privateName), false);
});

test("public-repo-check exige identidades Git con correo noreply", () => {
  assert.equal(isAllowedGitNoreplyEmail("123+contributor@users.noreply.github.com"), true);
  assert.equal(isAllowedGitNoreplyEmail("contributor@users.noreply.github.com"), true);
  assert.equal(isAllowedGitNoreplyEmail("noreply@github.com"), true);
  assert.equal(isAllowedGitNoreplyEmail("contributor@example.com"), false);
});

test("public-repo-check inspecciona los padres reales de un merge sintético de PR", async (context) => {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryRoot, "arca-public-history-"));
  context.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const noreplyEmail = "123+contributor@users.noreply.github.com";
  const personalEmail = ["actor", "correo.invalid.ar"].join("@");
  const runGit = async (args: string[], email = noreplyEmail): Promise<string> => {
    const { stdout } = await execFileAsync("git", args, {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Colaborador Ficticio",
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: "Colaborador Ficticio",
        GIT_COMMITTER_EMAIL: email,
      },
    });
    return stdout.trim();
  };

  await runGit(["init", "-b", "main"]);
  await fs.writeFile(path.join(root, "fixture.txt"), "contenido ficticio\n", "utf8");
  await runGit(["add", "fixture.txt"]);
  await runGit(["commit", "-m", "Crear fixture ficticio"]);
  const baseCommit = await runGit(["rev-parse", "HEAD"]);

  await runGit(["switch", "-c", "capacidad-ficticia"]);
  await fs.appendFile(path.join(root, "fixture.txt"), "cambio ficticio\n", "utf8");
  await runGit(["add", "fixture.txt"]);
  await runGit(["commit", "-m", "Actualizar fixture ficticio"]);
  const headCommit = await runGit(["rev-parse", "HEAD"]);
  const headTree = await runGit(["rev-parse", `${headCommit}^{tree}`]);
  const safeHeadFixture = "contenido ficticio\ncambio ficticio\n";
  const syntheticMerge = await runGit([
    "commit-tree", headTree,
    "-p", baseCommit,
    "-p", headCommit,
    "-m", "Merge sintético de pull request",
  ], personalEmail);
  await runGit(["update-ref", "refs/remotes/pull/1/merge", syntheticMerge]);

  const syntheticIssues = await validatePublicRepository(root);
  assert.equal(syntheticIssues.some((issue) => issue.category.includes("identidad Git")), false);
  assert.equal(syntheticIssues.some((issue) => issue.category.includes("correo electrónico")), false);

  await fs.writeFile(path.join(root, "fixture.txt"), `${safeHeadFixture}${personalEmail}\n`, "utf8");
  await runGit(["add", "fixture.txt"]);
  const unsafeSyntheticTree = await runGit(["write-tree"]);
  await fs.writeFile(path.join(root, "fixture.txt"), safeHeadFixture, "utf8");
  await runGit(["add", "fixture.txt"]);
  const treeLeakMerge = await runGit([
    "commit-tree", unsafeSyntheticTree,
    "-p", baseCommit,
    "-p", headCommit,
    "-m", "Merge sintético con árbol no permitido",
  ]);
  await runGit(["update-ref", "refs/remotes/pull/1/merge", treeLeakMerge]);
  const treeLeakIssues = await validatePublicRepository(root);
  assert.equal(treeLeakIssues.some((issue) => issue.category.includes("correo electrónico")), true);

  const messageLeakMerge = await runGit([
    "commit-tree", headTree,
    "-p", baseCommit,
    "-p", headCommit,
    "-m", `Merge sintético ${personalEmail}`,
  ]);
  await runGit(["update-ref", "refs/remotes/pull/1/merge", messageLeakMerge]);
  const messageLeakIssues = await validatePublicRepository(root);
  assert.equal(messageLeakIssues.some((issue) => issue.category.includes("correo electrónico")), true);

  await runGit(["update-ref", "refs/remotes/pull/1/merge", syntheticMerge]);
  await runGit(["update-ref", "refs/remotes/origin/pull/1/merge", syntheticMerge]);
  const similarRefIssues = await validatePublicRepository(root);
  assert.equal(similarRefIssues.some((issue) => issue.category.includes("identidad Git")), true);
  await runGit(["update-ref", "-d", "refs/remotes/origin/pull/1/merge"]);

  const invalidSyntheticTip = await runGit([
    "commit-tree", headTree,
    "-p", headCommit,
    "-m", "Tip sintético de un solo padre",
  ]);
  await runGit(["update-ref", "refs/remotes/pull/2/merge", invalidSyntheticTip]);
  await assert.rejects(
    () => validatePublicRepository(root),
    /merge válido de dos padres/i,
  );
  await runGit(["update-ref", "-d", "refs/remotes/pull/2/merge"]);

  const detachedCommit = await runGit([
    "commit-tree", headTree,
    "-p", headCommit,
    "-m", "Commit separado no permitido",
  ], personalEmail);
  await runGit(["switch", "--detach", detachedCommit]);
  const detachedIssues = await validatePublicRepository(root);
  assert.equal(detachedIssues.some((issue) => issue.category.includes("identidad Git")), true);
  await runGit(["switch", "capacidad-ficticia"]);

  await runGit(["update-ref", "refs/heads/historial-no-permitido", syntheticMerge]);
  const branchIssues = await validatePublicRepository(root);
  assert.equal(branchIssues.some((issue) => issue.category.includes("identidad Git")), true);
  assert.equal(branchIssues.some((issue) => issue.category.includes("correo electrónico")), true);
});
