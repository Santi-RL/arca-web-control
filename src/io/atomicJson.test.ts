import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJsonIfExists, writeJsonAtomic } from "./atomicJson.js";

test("writeJsonAtomic reemplaza estado previo sin dejar temporales", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arca-atomic-"));
  const filePath = path.join(directory, "state.json");
  await writeJsonAtomic(filePath, { version: 1 });
  await writeJsonAtomic(filePath, { version: 2 });
  assert.deepEqual(await readJsonIfExists(filePath), { version: 2 });
  assert.deepEqual((await fs.readdir(directory)).sort(), ["state.json"]);
});

test("writeJsonAtomic fuerza el temporal antes del rename", async () => {
  const source = await fs.readFile(new URL("./atomicJson.ts", import.meta.url), "utf8");
  const sync = source.indexOf("await handle.sync()");
  const close = source.indexOf("await handle.close()", sync);
  const rename = source.indexOf("await fs.rename(temporary, filePath)", close);
  assert.ok(sync >= 0 && close > sync && rename > close);
});
