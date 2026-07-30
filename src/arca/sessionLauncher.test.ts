import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";
import {
  acknowledgeSessionRuntimeAclVerification,
  attestSessionRuntimeToWorker,
  buildSessionWorkerArgs,
  createSessionPublishedMessage,
  createSessionRuntimeAclVerificationAckMessage,
  createSessionRuntimeAclVerificationMessage,
  isSessionHandoffAckMessage,
  isSessionHandoffMessage,
  isSessionPublishedMessage,
  isSessionRuntimeAclVerificationAckMessage,
  isSessionRuntimeAclVerificationMessage,
  isSessionShutdownMessage,
  sessionHandoffAckMessage,
  sessionHandoffMessage,
  sessionShutdownMessage,
  notifySessionPublished,
  retrySessionStatus,
  waitForSessionPublished,
  waitForSessionRuntimeAclVerification,
} from "./sessionLauncher.js";

const verificationId = "123e4567-e89b-42d3-a456-426614174000";

test("el wrapper ejecuta el worker directamente con el loader de tsx", () => {
  assert.deepEqual(buildSessionWorkerArgs({ scriptPath: "arca-session.mts", issuer: "EMISOR" }), [
    "--import",
    "tsx",
    "arca-session.mts",
    "--issuer",
    "EMISOR",
  ]);
  assert.deepEqual(buildSessionWorkerArgs({ scriptPath: "arca-session.mts", issuer: "EMISOR", productionHidden: true, capability: "invoice" }).slice(-3), [
    "--production-hidden",
    "--capability",
    "invoice",
  ]);
  assert.deepEqual(buildSessionWorkerArgs({ scriptPath: "arca-session.mts", issuer: "EMISOR", revalidationCapability: "invoice" }).slice(-2), [
    "--revalidate-irreversible",
    "invoice",
  ]);
});

test("reconoce únicamente los mensajes IPC de ciclo de vida", () => {
  assert.equal(isSessionShutdownMessage(sessionShutdownMessage), true);
  assert.equal(isSessionHandoffMessage(sessionHandoffMessage), true);
  assert.equal(isSessionHandoffAckMessage(sessionHandoffAckMessage), true);
  assert.equal(isSessionShutdownMessage(sessionHandoffMessage), false);
  assert.equal(isSessionHandoffMessage({ type: "otro" }), false);
  assert.equal(isSessionHandoffAckMessage(null), false);
  assert.equal(isSessionPublishedMessage(createSessionPublishedMessage(1234)), true);
  assert.equal(isSessionPublishedMessage({ type: "session-published", pid: 0 }), false);
  assert.equal(isSessionPublishedMessage({ type: "session-published", pid: 1234, token: "no" }), false);
});

test("la publicación IPC reemplaza el polling y conserva el PID exacto", async () => {
  const channel = new EventEmitter() as EventEmitter & {
    connected: boolean;
    send: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  };
  channel.connected = true;
  channel.send = (message, callback) => {
    callback?.(null);
    setImmediate(() => channel.emit("message", message));
    return true;
  };
  const waiting = waitForSessionPublished(channel as unknown as ChildProcess, 100);
  await notifySessionPublished(channel as unknown as NodeJS.Process, 4321, 100);
  assert.equal(await waiting, 4321);
});

test("la espera de publicación falla cerrada ante desconexión o timeout", async () => {
  const disconnected = new EventEmitter() as EventEmitter & { connected: boolean };
  disconnected.connected = true;
  const pending = waitForSessionPublished(disconnected as unknown as ChildProcess, 100);
  disconnected.emit("disconnect");
  assert.equal(await pending, undefined);

  const stalled = new EventEmitter() as EventEmitter & { connected: boolean };
  stalled.connected = true;
  assert.equal(await waitForSessionPublished(stalled as unknown as ChildProcess, 5), undefined);
});

test("el estado local se reintenta dentro de un plazo acotado", async () => {
  let attempts = 0;
  const status = await retrySessionStatus(async () => {
    attempts += 1;
    return attempts === 3 ? { readyState: "portal" } : undefined;
  }, 100, 1);
  assert.deepEqual(status, { readyState: "portal" });
  assert.equal(attempts, 3);

  const startedAt = Date.now();
  assert.equal(await retrySessionStatus(async () => undefined, 10, 2), undefined);
  assert.ok(Date.now() - startedAt < 100);
  await assert.rejects(() => retrySessionStatus(async () => undefined, 0), /tiempos de sondeo/i);
});

test("la atestación IPC de ACL valida raíz, forma exacta y nonce", () => {
  const root = path.resolve("runtime-privado");
  const message = createSessionRuntimeAclVerificationMessage(root, verificationId);
  const ack = createSessionRuntimeAclVerificationAckMessage(verificationId);
  assert.equal(isSessionRuntimeAclVerificationMessage(message), true);
  assert.equal(isSessionRuntimeAclVerificationAckMessage(ack, verificationId), true);
  assert.equal(isSessionRuntimeAclVerificationAckMessage(ack, "550e8400-e29b-41d4-a716-446655440000"), false);
  assert.equal(isSessionRuntimeAclVerificationMessage({ ...message, extra: true }), false);
  assert.equal(isSessionRuntimeAclVerificationMessage({ ...message, root: "" }), false);
  assert.equal(isSessionRuntimeAclVerificationMessage({ ...message, verificationId: "predecible" }), false);
  assert.throws(() => createSessionRuntimeAclVerificationMessage("relativa", verificationId), /absoluta/i);
});

test("el launcher solo acepta el ACK correspondiente a su atestación", async () => {
  const channel = new EventEmitter() as EventEmitter & {
    connected: boolean;
    send: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  };
  channel.connected = true;
  channel.send = (message, callback) => {
    callback?.(null);
    const sent = message as { verificationId: string };
    setImmediate(() => {
      const wrongId = sent.verificationId === verificationId ? "550e8400-e29b-41d4-a716-446655440000" : verificationId;
      channel.emit("message", createSessionRuntimeAclVerificationAckMessage(wrongId));
      channel.emit("message", createSessionRuntimeAclVerificationAckMessage(sent.verificationId));
    });
    return true;
  };
  assert.equal(await attestSessionRuntimeToWorker(channel as unknown as ChildProcess, path.resolve("runtime"), 100), true);
});

test("un ACK de otro intercambio nunca completa la atestación", async () => {
  const channel = new EventEmitter() as EventEmitter & {
    connected: boolean;
    send: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  };
  channel.connected = true;
  channel.send = (_message, callback) => {
    callback?.(null);
    setImmediate(() => channel.emit("message", createSessionRuntimeAclVerificationAckMessage(verificationId)));
    return true;
  };
  assert.equal(await attestSessionRuntimeToWorker(channel as unknown as ChildProcess, path.resolve("runtime"), 20), false);
});

test("el launcher falla cerrado si el canal no está disponible o el envío falla", async () => {
  const disconnected = new EventEmitter() as EventEmitter & { connected: boolean };
  disconnected.connected = false;
  assert.equal(await attestSessionRuntimeToWorker(disconnected as unknown as ChildProcess, path.resolve("runtime"), 20), false);

  const failed = new EventEmitter() as EventEmitter & {
    connected: boolean;
    send: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  };
  failed.connected = true;
  failed.send = (_message, callback) => { callback?.(new Error("ipc-error")); return false; };
  assert.equal(await attestSessionRuntimeToWorker(failed as unknown as ChildProcess, path.resolve("runtime"), 20), false);
});

test("el worker acepta una atestación válida e ignora mensajes ajenos", async () => {
  const channel = new EventEmitter() as EventEmitter & { connected: boolean };
  channel.connected = true;
  const controller = new AbortController();
  const expected = createSessionRuntimeAclVerificationMessage(path.resolve("runtime"), verificationId);
  const pending = waitForSessionRuntimeAclVerification(channel as unknown as NodeJS.Process, controller.signal, 100);
  channel.emit("message", { type: "otro" });
  channel.emit("message", expected);
  assert.deepEqual(await pending, expected);
});

test("el ACK del worker conserva exactamente el nonce validado", async () => {
  let sent: unknown;
  const channel = new EventEmitter() as EventEmitter & {
    connected: boolean;
    send: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  };
  channel.connected = true;
  channel.send = (message, callback) => { sent = message; callback?.(null); return true; };
  await acknowledgeSessionRuntimeAclVerification(channel as unknown as NodeJS.Process, verificationId, 100);
  assert.deepEqual(sent, createSessionRuntimeAclVerificationAckMessage(verificationId));

  channel.connected = false;
  await assert.rejects(
    () => acknowledgeSessionRuntimeAclVerification(channel as unknown as NodeJS.Process, verificationId, 20),
    /canal IPC/i,
  );
});

test("el ACK del worker falla ante error o timeout del canal", async () => {
  const failed = new EventEmitter() as EventEmitter & {
    connected: boolean;
    send: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  };
  failed.connected = true;
  failed.send = (_message, callback) => { callback?.(new Error("ipc-error")); return false; };
  await assert.rejects(
    () => acknowledgeSessionRuntimeAclVerification(failed as unknown as NodeJS.Process, verificationId, 20),
    /ipc-error/i,
  );

  const stalled = new EventEmitter() as EventEmitter & {
    connected: boolean;
    send: () => boolean;
  };
  stalled.connected = true;
  stalled.send = () => true;
  await assert.rejects(
    () => acknowledgeSessionRuntimeAclVerification(stalled as unknown as NodeJS.Process, verificationId, 5),
    /timeout/i,
  );
});

test("la espera del worker falla cerrada ante mensaje inválido, desconexión o timeout", async () => {
  const createChannel = () => {
    const channel = new EventEmitter() as EventEmitter & { connected: boolean };
    channel.connected = true;
    return channel;
  };
  const invalid = createChannel();
  const invalidWait = waitForSessionRuntimeAclVerification(invalid as unknown as NodeJS.Process, new AbortController().signal, 100);
  invalid.emit("message", { type: "runtime-acl-verified", root: "", verificationId });
  await assert.rejects(invalidWait, /inválida/i);

  const disconnected = createChannel();
  const disconnectedWait = waitForSessionRuntimeAclVerification(disconnected as unknown as NodeJS.Process, new AbortController().signal, 100);
  disconnected.emit("disconnect");
  await assert.rejects(disconnectedWait, /desconectó/i);

  const timedOut = createChannel();
  await assert.rejects(
    waitForSessionRuntimeAclVerification(timedOut as unknown as NodeJS.Process, new AbortController().signal, 5),
    /timeout/i,
  );

  const aborted = createChannel();
  const controller = new AbortController();
  const abortedWait = waitForSessionRuntimeAclVerification(aborted as unknown as NodeJS.Process, controller.signal, 100);
  controller.abort();
  await assert.rejects(abortedWait, /cancelada/i);

  const alreadyAborted = createChannel();
  const preAbortedController = new AbortController();
  preAbortedController.abort();
  await assert.rejects(
    waitForSessionRuntimeAclVerification(alreadyAborted as unknown as NodeJS.Process, preAbortedController.signal, 100),
    /cancelada/i,
  );
});
