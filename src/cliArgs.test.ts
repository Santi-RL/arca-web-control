import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "./cliArgs.js";

test("parseCliArgs habilita dry-run en todos los modos", () => {
  const options = parseCliArgs(["--job", "jobs/factura.example.json", "--guided"]);

  assert.equal(options.jobPath, "jobs/factura.example.json");
  assert.equal(options.guided, true);
  assert.equal(options.dryRun, true);
});

test("parseCliArgs rechaza la emisión por el CLI legado", () => {
  assert.throws(
    () => parseCliArgs(["--job", "jobs/factura.example.json", "--guided", "--allow-emit"]),
    /exclusivamente dry-run/,
  );
});

test("parseCliArgs requires a job path", () => {
  assert.throws(() => parseCliArgs(["--guided"]), /--job/);
});
