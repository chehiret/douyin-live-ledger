import {
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chinaDate } from "./domain.js";

export class Backups {
  constructor(store, dataDir) {
    this.store = store;
    this.dir = path.join(dataDir, "backups");
    mkdirSync(this.dir, { recursive: true });
    this.lastDay = "";
  }
  list() {
    return readdirSync(this.dir)
      .filter((n) => /^backup-[\w-]+\.sqlite$/.test(n))
      .map((name) => ({
        name,
        bytes: statSync(path.join(this.dir, name)).size,
        created_at: statSync(path.join(this.dir, name)).mtime.toISOString(),
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  file(name) {
    if (
      !/^backup-[\w-]+\.sqlite$/.test(name) ||
      !this.list().some((b) => b.name === name)
    )
      throw new Error("备份不存在");
    return path.join(this.dir, name);
  }
  delete(name) {
    const file = this.file(name);
    unlinkSync(file);
    const manifest = file + ".json";
    if (existsSync(manifest)) unlinkSync(manifest);
    return { ok: true };
  }
  verify(name) {
    const file = this.file(name),
      db = new DatabaseSync(file, { readOnly: true });
    try {
      if (
        db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
        db.prepare("PRAGMA foreign_key_check").all().length
      )
        throw new Error("备份完整性校验失败");
      const counts = Object.fromEntries(
        ["anchors", "accounts", "sessions", "coverage"].map((table) => [
          table,
          db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,
        ]),
      );
      const checksum = createHash("sha256")
        .update(readFileSync(file))
        .digest("hex");
      const manifest = JSON.parse(readFileSync(file + ".json", "utf8"));
      if (manifest.sha256 !== checksum) throw new Error("备份校验值不一致");
      return { ok: true, counts };
    } finally {
      db.close();
    }
  }
  create() {
    const name = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.sqlite`,
      file = path.join(this.dir, name);
    this.store.db.prepare("VACUUM INTO ?").run(file);
    writeFileSync(
      file + ".json",
      JSON.stringify(
        {
          created_at: new Date().toISOString(),
          sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
        },
        null,
        2,
      ),
    );
    const result = this.verify(name);
    this.store.resolveNotice(null, "backup");
    this.lastDay = chinaDate();
    for (const old of this.list().slice(30)) {
      unlinkSync(this.file(old.name));
      const manifest = path.join(this.dir, old.name + ".json");
      if (existsSync(manifest)) unlinkSync(manifest);
    }
    return { name, ...result };
  }
  daily() {
    const today = chinaDate();
    if (this.lastDay === today) return;
    try {
      for (const backup of this.list().filter(
        (b) => chinaDate(new Date(b.created_at)) === today,
      )) {
        try {
          this.verify(backup.name);
          this.lastDay = today;
          return;
        } catch {}
      }
      this.create();
    } catch (e) {
      this.store.notify(null, "backup", "自动备份失败：" + e.message);
    }
  }
}
