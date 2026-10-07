import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.js";
import { Guarantees } from "../server/guarantees.js";
import { Jobs } from "../server/jobs.js";
function fixture() {
  const s = new Store(":memory:");
  const a = s.saveAnchor({ name: "A" }),
    b = s.saveAnchor({ name: "B" });
  const x = s.createAccount({ anchorId: a.id, handle: "x" }),
    y = s.createAccount({ anchorId: a.id, handle: "y" });
  return { s, g: new Guarantees(s), a, b, x, y };
}
function session(id, date, duration) {
  return {
    roomId: id,
    date,
    title: "test",
    start: date + " 10:00:00",
    end: date + " 12:00:00",
    duration,
    followers: 0,
    gifters: 0,
  };
}
test("monthly guarantees sum multiple accounts, distinguish equality/excess and stay independent by month", () => {
  const { s, g, a, x, y } = fixture();
  try {
    g.set(a.id, "2024-02", 7200, "admin");
    g.set(a.id, "2024-03", 3600, "admin");
    s.saveDay(x.id, "2024-02-01", [session("100", "2024-02-01", 1800)]);
    s.saveDay(y.id, "2024-02-02", [session("101", "2024-02-02", 3600)]);
    let p = g.progress("2024-02", a.id)[0];
    assert.equal(p.remaining, 1800);
    assert.equal(p.actual, 5400);
    s.saveDay(x.id, "2024-02-01", [session("100", "2024-02-01", 3600)]);
    assert.equal(g.progress("2024-02", a.id)[0].status, "met");
    s.saveDay(x.id, "2024-02-01", [session("100", "2024-02-01", 4200)]);
    p = g.progress("2024-02", a.id)[0];
    assert.equal(p.excess, 600);
    assert.equal(p.status, "exceeded");
    assert.equal(g.progress("2024-03", a.id)[0].target, 3600);
    assert.equal(g.progress("2024-04", a.id)[0].target, null);
  } finally {
    s.close();
  }
});
test("last seven calendar days notify once per anchor per day, persist across restarts and respect ownership", () => {
  const { s, g, a, b } = fixture();
  try {
    g.set(a.id, "2024-02", 7200, "admin");
    g.set(b.id, "2024-02", 3600, "admin");
    const user = { id: "u", role: "anchor", anchor_id: a.id };
    g.remind(new Date("2024-02-22T15:59:00Z"));
    assert.equal(g.notices(user).length, 0);
    g.remind(new Date("2024-02-22T16:00:00Z"));
    g.remind(new Date("2024-02-23T01:00:00Z"));
    assert.equal(g.notices(user).length, 1);
    new Guarantees(s).remind(new Date("2024-02-23T02:00:00Z"));
    assert.equal(g.notices(user).length, 1);
    const n = g.notices(user)[0];
    g.read(n.id, user);
    assert.equal(g.notices(user)[0].is_read, 1);
    assert.throws(
      () =>
        g.read(
          g
            .notices({ id: "admin", role: "admin" })
            .find((n) => n.anchor_id === b.id).id,
          user,
        ),
      /不存在/,
    );
    g.remind(new Date("2024-02-23T16:00:00Z"));
    assert.equal(g.notices(user).length, 2);
    s.db
      .prepare("UPDATE monthly_guarantees SET seconds=0 WHERE anchor_id=?")
      .run(a.id);
    g.remind(new Date("2024-02-24T10:00:00Z"));
    assert.ok(g.notices(user).every((n) => n.resolved));
    g.remind(new Date("2024-03-01T00:00:00Z"));
    assert.equal(g.notices(user).length, 2);
  } finally {
    s.close();
  }
});
test("retention removes only old operations, preserves statistics, targets and active jobs; queue pages contain only active tasks", async () => {
  const { s, g, a, x } = fixture();
  const jobs = new Jobs(s, { bindings: new Map(), close: async () => {} });
  clearInterval(jobs.timer);
  try {
    g.set(a.id, "2024-02", 7200, "admin");
    s.saveDay(x.id, "2024-02-01", [session("100", "2024-02-01", 3600)]);
    const old = "2024-02-01T00:00:00.000Z",
      boundary = "2024-02-13T00:00:00.000Z";
    const run = s.startRun(x.id, "2024-02-01", "2024-02-01", "manual");
    s.endRun(run, "success", "ok");
    s.db.prepare("UPDATE runs SET started_at=?,ended_at=?").run(old, old);
    s.audit("admin", "old", a.id, x.id, {});
    s.db.prepare("UPDATE audit_events SET created_at=?").run(old);
    s.audit("admin", "boundary", a.id, x.id, {});
    s.db
      .prepare("UPDATE audit_events SET created_at=? WHERE action='boundary'")
      .run(boundary);
    for (let i = 0; i < 17; i++)
      s.db
        .prepare(
          "INSERT INTO jobs(id,account_id,kind,payload,dedupe,status,created_at) VALUES(?,?,'check','{}',?,'queued',?)",
        )
        .run("job" + i, x.id, "d" + i, old);
    s.db
      .prepare(
        "INSERT INTO jobs(id,account_id,kind,payload,dedupe,status,created_at) VALUES('done',?,'check','{}','done','success',?)",
      )
      .run(x.id, old);
    g.cleanup(new Date("2024-02-20T00:00:00Z"));
    assert.equal(s.runs().length, 0);
    assert.equal(s.audits().length, 1);
    assert.equal(s.report("2024-02").totals.duration, 3600);
    assert.equal(g.progress("2024-02", a.id)[0].target, 7200);
    assert.equal(jobs.count({ role: "admin" }), 17);
    assert.equal(jobs.list({ role: "admin" }, 1, true).length, 15);
    assert.equal(jobs.list({ role: "admin" }, 2, true).length, 2);
  } finally {
    await jobs.close();
    s.close();
  }
});
