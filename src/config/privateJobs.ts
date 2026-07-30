import fs from "node:fs/promises";
import path from "node:path";

export async function resolvePrivateInvoiceJobPath(value: string, privateJobsRoot: string, trustedRuntimeRoot: string): Promise<string> {
  try {
    const repositoryReal = await fs.realpath(process.cwd());
    const trustedPath = path.resolve(trustedRuntimeRoot);
    const trustedStat = await fs.lstat(trustedPath);
    if (!trustedStat.isDirectory() || trustedStat.isSymbolicLink()) throw new Error("invalid-runtime-root");
    const trustedReal = await fs.realpath(trustedPath);
    if (isWithin(repositoryReal, trustedReal)) throw new Error("runtime-inside-repository");

    const jobsPath = path.resolve(privateJobsRoot);
    const jobsStat = await fs.lstat(jobsPath);
    if (!jobsStat.isDirectory() || jobsStat.isSymbolicLink()) throw new Error("invalid-jobs-root");
    const jobsReal = await fs.realpath(jobsPath);
    if (!isWithin(trustedReal, jobsReal) || isWithin(repositoryReal, jobsReal)) throw new Error("escaped-jobs-root");

    const lexicalCandidate = path.resolve(value);
    if (path.extname(lexicalCandidate).toLowerCase() !== ".json") throw new Error("invalid-extension");
    if (!isWithin(jobsPath, lexicalCandidate) || samePath(jobsPath, lexicalCandidate)) throw new Error("lexical-escape");
    const candidateStat = await fs.lstat(lexicalCandidate);
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) throw new Error("invalid-job-file");
    const candidateReal = await fs.realpath(lexicalCandidate);
    if (!isWithin(jobsReal, candidateReal) || isWithin(repositoryReal, candidateReal)) throw new Error("canonical-escape");
    return candidateReal;
  } catch {
    throw new Error("El job debe ser un archivo JSON regular dentro de la carpeta privada jobs\\private del runtime local.");
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (entry: string) => {
    const resolved = path.resolve(entry);
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
