import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  unlinkSync,
  truncateSync,
} from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { chinaDate } from "./domain.js";

export function installRuntimeLog(dataDir) {
  const dir = path.join(dataDir, "runtime-logs");
  mkdirSync(dir, { recursive: true });
  for (const level of ["log", "warn", "error"]) {
    const fallback = console[level].bind(console);
    console[level] = (...args) => {
      try {
        const now = new Date(),
          file = path.join(dir, `server-${chinaDate(now)}.log`);
        // Bound even a noisy single day. Database audit records are separate.
        let size = 0;
        try {
          size = lstatSync(file).size;
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        if (size < 10 * 1024 * 1024)
          appendFileSync(
            file,
            `${now.toISOString()} [${level}] ${format(...args).slice(0, 16000)}\n`,
          );
      } catch {
        fallback(...args);
      }
    };
  }
}

export function cleanupFiles(dataDir, now = new Date()) {
  const cutoff = now.getTime() - 7 * 86400000;
  for (const [folder, allowed] of [
    ["diagnostics", /^[a-f\d-]{36}(?:-requests)?\.(json|png|jpg|jpeg)$/i],
    ["runtime-logs", /^server-\d{4}-\d{2}-\d{2}\.log$/],
  ]) {
    const dir = path.join(dataDir, folder);
    let entries;
    try {
      if (lstatSync(dir).isSymbolicLink()) continue;
      entries = readdirSync(dir);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    for (const name of entries) {
      if (!allowed.test(name)) continue;
      const file = path.join(dir, name),
        stat = lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < cutoff)
        unlinkSync(file);
    }
  }
  // Legacy supervisor/stderr files are no longer the application log destination.
  for (const name of ["server.log", "server-error.log", "supervisor.log"]) {
    const file = path.join(dataDir, name);
    try {
      const stat = lstatSync(file);
      if (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.size &&
        (stat.mtimeMs < cutoff || stat.size > 5 * 1024 * 1024)
      )
        truncateSync(file, 0);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}
