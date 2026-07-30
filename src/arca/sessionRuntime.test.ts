import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { RuntimePaths } from "../config/runtimePaths.js";
import type { SessionRuntimeDependencies } from "./sessionRuntime.js";
import { resolveSessionRuntime } from "./sessionRuntime.js";

const runtime: RuntimePaths = {
  root: "runtime",
  config: "config",
  profiles: "profiles",
  issuers: "issuers",
  sessions: "sessions",
  learning: "learning",
  ledger: "ledger",
  privateJobs: "jobs",
  privateImport: "private-import",
  guided: "guided",
  logs: "logs",
  downloads: "downloads",
};
const verification = {
  type: "runtime-acl-verified" as const,
  root: "runtime",
  verificationId: "123e4567-e89b-42d3-a456-426614174000",
};

test("el worker directo verifica la ACL y no espera una atestación", async () => {
  let ensureCount = 0;
  let waitCount = 0;
  let useCount = 0;
  let acknowledgeCount = 0;
  const dependencies: SessionRuntimeDependencies = {
    ensure: async () => { ensureCount += 1; return runtime; },
    waitForVerification: async () => { waitCount += 1; return verification; },
    useVerification: async () => { useCount += 1; return runtime; },
    acknowledge: async () => { acknowledgeCount += 1; },
  };
  const result = await resolveSessionRuntime(false, { connected: false } as NodeJS.Process, new AbortController().signal, dependencies);
  assert.equal(result, runtime);
  assert.equal(ensureCount, 1);
  assert.equal(waitCount, 0);
  assert.equal(useCount, 0);
  assert.equal(acknowledgeCount, 0);
});

test("el worker administrado reutiliza solo la atestación IPC y no reaplica la ACL", async () => {
  let ensureCount = 0;
  let usedRoot: string | undefined;
  let acknowledgedId: string | undefined;
  const dependencies: SessionRuntimeDependencies = {
    ensure: async () => { ensureCount += 1; return runtime; },
    waitForVerification: async () => verification,
    useVerification: async (root) => { usedRoot = root; return runtime; },
    acknowledge: async (_target, id) => { acknowledgedId = id; },
  };
  const result = await resolveSessionRuntime(true, { connected: true } as NodeJS.Process, new AbortController().signal, dependencies);
  assert.equal(result, runtime);
  assert.equal(ensureCount, 0);
  assert.equal(usedRoot, verification.root);
  assert.equal(acknowledgedId, verification.verificationId);
});

test("una variable de modo sin canal IPC no permite omitir la ACL", async () => {
  let dependencyCalls = 0;
  const dependencies: SessionRuntimeDependencies = {
    ensure: async () => { dependencyCalls += 1; return runtime; },
    waitForVerification: async () => { dependencyCalls += 1; return verification; },
    useVerification: async () => { dependencyCalls += 1; return runtime; },
    acknowledge: async () => { dependencyCalls += 1; },
  };
  await assert.rejects(
    () => resolveSessionRuntime(true, { connected: false } as NodeJS.Process, new AbortController().signal, dependencies),
    /canal IPC/i,
  );
  assert.equal(dependencyCalls, 0);
});

test("una raíz rechazada no recibe ACK", async () => {
  let acknowledgeCount = 0;
  const dependencies: SessionRuntimeDependencies = {
    ensure: async () => runtime,
    waitForVerification: async () => verification,
    useVerification: async () => { throw new Error("La raíz no coincide."); },
    acknowledge: async () => { acknowledgeCount += 1; },
  };
  await assert.rejects(
    () => resolveSessionRuntime(true, { connected: true } as NodeJS.Process, new AbortController().signal, dependencies),
    /no coincide/i,
  );
  assert.equal(acknowledgeCount, 0);
});

test("un cierre durante el ACK impide continuar hacia las credenciales", async () => {
  const controller = new AbortController();
  const dependencies: SessionRuntimeDependencies = {
    ensure: async () => runtime,
    waitForVerification: async () => verification,
    useVerification: async () => runtime,
    acknowledge: async () => { controller.abort(); },
  };
  await assert.rejects(
    () => resolveSessionRuntime(true, { connected: true } as NodeJS.Process, controller.signal, dependencies),
    /cancelada/i,
  );
});

test("la resolución administrada respeta wait, validación y ACK en ese orden", async () => {
  const order: string[] = [];
  const dependencies: SessionRuntimeDependencies = {
    ensure: async () => runtime,
    waitForVerification: async () => { order.push("wait"); return verification; },
    useVerification: async () => { order.push("use"); return runtime; },
    acknowledge: async () => { order.push("ack"); },
  };
  await resolveSessionRuntime(true, { connected: true } as NodeJS.Process, new AbortController().signal, dependencies);
  assert.deepEqual(order, ["wait", "use", "ack"]);
});

test("la atestación ocurre antes de credenciales y Chrome", async () => {
  const worker = await fs.readFile(path.resolve("scripts", "arca-session.mts"), "utf8");
  const runtimeResolution = worker.indexOf("await resolveSessionRuntime(");
  const config = worker.indexOf("loadRuntimeConfig()");
  const credentials = worker.indexOf("loadCredentialsAsync(args.issuer, expectedCredentialProviderFingerprint)");
  const sessionModule = worker.indexOf('import("../src/arca/liveSession.js")');
  const browser = worker.indexOf("ArcaLiveSession.create(");
  assert.ok(runtimeResolution >= 0 && config > runtimeResolution && credentials > runtimeResolution && sessionModule > runtimeResolution && browser > credentials && browser > sessionModule);

  const launcher = await fs.readFile(path.resolve("scripts", "arca-session-start.mts"), "utf8");
  const publishedWait = launcher.indexOf("waitForSessionPublished(child");
  const runtimeAttestation = launcher.indexOf('measureArcaPerformance("launcher_runtime_handoff"');
  const readyWait = launcher.indexOf('measureArcaPerformance("launcher_spawn_ready"');
  const publishedResult = launcher.indexOf("await publishedSession", readyWait);
  const liveStatus = launcher.indexOf("await fetchStatus(current)", publishedResult);
  const handoff = launcher.indexOf("await completeIpcHandoff(child)", liveStatus);
  assert.ok(publishedWait >= 0 && runtimeAttestation > publishedWait && readyWait > runtimeAttestation);
  assert.ok(publishedResult > readyWait && liveStatus > publishedResult && handoff > liveStatus);

  const publishStage = worker.indexOf('measureArcaPerformance("worker_publish_ready"');
  const currentWrite = worker.indexOf("await writeCurrent();", publishStage);
  const publishedNotification = worker.indexOf("await notifySessionPublished(process, process.pid)", currentWrite);
  assert.ok(publishStage >= 0 && currentWrite > publishStage && publishedNotification > currentWrite);
  assert.match(launcher, /retrySessionStatus/);
  assert.match(launcher, /AbortSignal\.timeout\(1000\)/);
});

test("los entrypoints de comandos exigen el marcador antes de toda mutación", async () => {
  const cli = await fs.readFile(path.resolve("scripts", "arca-session-cmd.mts"), "utf8");
  assert.match(cli, /command\.type !== "status"\) await useActiveSessionRuntimeLayout\(runtime\)/);

  const mcp = await fs.readFile(path.resolve("scripts", "arca-mcp.mts"), "utf8");
  const guard = mcp.indexOf("await useActiveSessionRuntimeLayout(runtime)");
  const post = mcp.indexOf('sessionRequest("POST", "/command"', guard);
  assert.ok(guard >= 0 && post > guard);
  const learningGuard = mcp.indexOf("await useActiveSessionRuntimeLayout(runtime)", guard + 1);
  const learningPost = mcp.indexOf("buildLearningControlUrl(current)", learningGuard);
  assert.ok(learningGuard > guard && learningPost > learningGuard);

  const recovery = await fs.readFile(path.resolve("scripts", "arca-invoice-recover-pdf.mts"), "utf8");
  assert.match(recovery, /await ensureRuntimeLayout\(getRuntimePaths\(\)\)/);
});
