import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkPublicPath, isAllowedGitNoreplyEmail, redactRepositoryIssuePaths, scanPublicFileName, scanPublicText } from "../../scripts/public-repo-check.mjs";
import { validateSkill } from "../../scripts/validate-skill.mjs";

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
