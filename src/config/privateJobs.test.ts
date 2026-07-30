import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeCanonicalTemporaryDirectory } from "../testing/temporaryDirectory.js";
import { readPrivateInvoiceJobFile, resolvePrivateInvoiceJobPath } from "./privateJobs.js";

test("acepta únicamente un JSON regular dentro de jobs/private", async (context) => {
  const runtime = await makeCanonicalTemporaryDirectory("arca-private-job-");
  context.after(async () => { await fs.rm(runtime, { recursive: true, force: true }); });
  const privateJobs = path.join(runtime, "jobs", "private");
  await fs.mkdir(privateJobs, { recursive: true });
  const job = path.join(privateJobs, "factura.json");
  await fs.writeFile(job, "{}\n", "utf8");
  assert.equal(await resolvePrivateInvoiceJobPath(job, privateJobs, runtime), await fs.realpath(job));
  await assert.rejects(() => resolvePrivateInvoiceJobPath(privateJobs, privateJobs, runtime), /jobs\\private/i);
});

test("acepta un handle opaco canónico y lo resuelve dentro de jobs/private", async (context) => {
  const runtime = await makeCanonicalTemporaryDirectory("arca-private-job-handle-");
  context.after(async () => { await fs.rm(runtime, { recursive: true, force: true }); });
  const privateJobs = path.join(runtime, "jobs", "private");
  await fs.mkdir(privateJobs, { recursive: true });
  const handle = "invoice-2030-06-15-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json";
  const job = path.join(privateJobs, handle);
  await fs.writeFile(job, "{}\n", "utf8");
  assert.equal(await resolvePrivateInvoiceJobPath(handle, privateJobs, runtime), await fs.realpath(job));
  await assert.rejects(() => resolvePrivateInvoiceJobPath("../" + handle, privateJobs, runtime), /jobs\\private/i);

  const currentHandle = `invoice-${"a".repeat(64)}.json`;
  const currentJob = path.join(privateJobs, currentHandle);
  await fs.writeFile(currentJob, "{}\n", "utf8");
  assert.equal(await resolvePrivateInvoiceJobPath(currentHandle, privateJobs, runtime), await fs.realpath(currentJob));
  assert.equal((await readPrivateInvoiceJobFile(currentHandle, privateJobs, runtime)).contents, "{}\n");
});

test("rechaza archivos externos, extensiones distintas y enlaces", async (context) => {
  const runtime = await makeCanonicalTemporaryDirectory("arca-private-job-runtime-");
  const externalRoot = await makeCanonicalTemporaryDirectory("arca-private-job-external-");
  context.after(async () => {
    await fs.rm(runtime, { recursive: true, force: true });
    await fs.rm(externalRoot, { recursive: true, force: true });
  });
  const privateJobs = path.join(runtime, "jobs", "private");
  await fs.mkdir(privateJobs, { recursive: true });
  const external = path.join(externalRoot, "externo.json");
  await fs.writeFile(external, "{}\n", "utf8");
  await assert.rejects(() => resolvePrivateInvoiceJobPath(external, privateJobs, runtime), /jobs\\private/i);
  const wrongExtension = path.join(privateJobs, "factura.txt");
  await fs.writeFile(wrongExtension, "{}\n", "utf8");
  await assert.rejects(() => resolvePrivateInvoiceJobPath(wrongExtension, privateJobs, runtime), /jobs\\private/i);

  const junction = path.join(privateJobs, "escape");
  await fs.symlink(externalRoot, junction, "junction");
  await assert.rejects(() => resolvePrivateInvoiceJobPath(path.join(junction, "externo.json"), privateJobs, runtime), /jobs\\private/i);
  await fs.unlink(junction).catch(() => undefined);
});

test("rechaza un job enlazado también fuera del runtime", async (context) => {
  const runtime = await makeCanonicalTemporaryDirectory("arca-private-job-hardlink-runtime-");
  const externalRoot = await makeCanonicalTemporaryDirectory("arca-private-job-hardlink-external-");
  context.after(async () => {
    await fs.rm(runtime, { recursive: true, force: true });
    await fs.rm(externalRoot, { recursive: true, force: true });
  });
  const privateJobs = path.join(runtime, "jobs", "private");
  await fs.mkdir(privateJobs, { recursive: true });
  const external = path.join(externalRoot, "job.json");
  const handle = `invoice-${"b".repeat(64)}.json`;
  await fs.writeFile(external, "{}\n", "utf8");
  await fs.link(external, path.join(privateJobs, handle));

  await assert.rejects(() => resolvePrivateInvoiceJobPath(handle, privateJobs, runtime), /jobs\\private/i);
  await assert.rejects(() => readPrivateInvoiceJobFile(handle, privateJobs, runtime), /único e inmutable/i);
});
