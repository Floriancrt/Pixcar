// Amazon Aurora DSQL, sans AWS : tout ce qui ne dépend pas du service lui-même. Le découpage et l'adaptation des migrations, la reprise
// sur conflit de concurrence optimiste, la façon dont le pilote parle au connecteur, le déroulé d'une migration DSQL (une instruction par
// transaction, attente des index asynchrones) et la création du rôle de base de l'API. Ce qui dépend du vrai service (syntaxe acceptée,
// droits, conflits réels) est vérifié par l'auto-contrôle lancé dans AWS (server/ops.mjs, opération « selfcheck »).
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createDb, isConflict, poolDb, withRetry } from "../db.mjs";
import { MIGRATIONS_DIR, ensureRuntimeRole, migrate, waitForJob } from "../migrate.mjs";
import { isIndexStatement, splitStatements, toDsqlStatement } from "../lib/sql.mjs";

const occ = (code = "OC000") => Object.assign(new Error(`change conflicts with another transaction (${code})`), { code: "40001" });
const noWait = async () => {};

describe("splitStatements", () => {
  test("splits on semicolons, ignoring comments and semicolons inside strings, identifiers and $$ blocks", () => {
    const sql = `
      -- commentaire ; avec un point-virgule
      CREATE TABLE a (x text DEFAULT 'a;b', y text);  /* bloc ; /* imbriqué ; */ fin */
      CREATE TABLE "b;c" (z int);
      CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; SELECT 2; $body$ LANGUAGE sql;
      INSERT INTO a VALUES ('it''s;ok', $1);
      `;
    const out = splitStatements(sql);
    assert.equal(out.length, 4);
    assert.match(out[0], /^CREATE TABLE a \(x text DEFAULT 'a;b', y text\)$/);
    assert.equal(out[1], 'CREATE TABLE "b;c" (z int)');
    assert.match(out[2], /\$body\$ SELECT 1; SELECT 2; \$body\$ LANGUAGE sql$/);
    assert.match(out[3], /'it''s;ok', \$1\)$/);
  });
  test("an unterminated last statement is kept, empty ones are dropped", () => {
    assert.deepEqual(splitStatements(";; SELECT 1 ;\n\n SELECT 2"), ["SELECT 1", "SELECT 2"]);
    assert.deepEqual(splitStatements("   -- rien\n"), []);
  });
});

describe("toDsqlStatement", () => {
  test("tables become idempotent, once", () => {
    assert.equal(toDsqlStatement("CREATE TABLE t (id int)"), "CREATE TABLE IF NOT EXISTS t (id int)");
    assert.equal(toDsqlStatement("create table IF NOT EXISTS t (id int)"), "create table IF NOT EXISTS t (id int)");
  });
  test("indexes become asynchronous and idempotent, without ASC / DESC, keeping UNIQUE and the partial predicate", () => {
    assert.equal(toDsqlStatement("CREATE INDEX i ON t (a, b DESC, c ASC)"), "CREATE INDEX ASYNC IF NOT EXISTS i ON t (a, b, c)");
    assert.equal(
      toDsqlStatement("CREATE UNIQUE INDEX u ON t (a, b)\n  WHERE a IS NOT NULL AND status <> 'rejected'"),
      "CREATE UNIQUE INDEX ASYNC IF NOT EXISTS u ON t (a, b)\n  WHERE a IS NOT NULL AND status <> 'rejected'",
    );
    // un mot « DESC » dans le prédicat d'un index partiel n'est pas touché
    assert.equal(toDsqlStatement("CREATE INDEX p ON t (a DESC) WHERE note <> 'DESC order'"), "CREATE INDEX ASYNC IF NOT EXISTS p ON t (a) WHERE note <> 'DESC order'");
    assert.equal(toDsqlStatement("CREATE INDEX ASYNC IF NOT EXISTS i ON t (a)"), "CREATE INDEX ASYNC IF NOT EXISTS i ON t (a)");
  });
  test("other statements are left alone", () => {
    assert.equal(toDsqlStatement("INSERT INTO t VALUES (1)"), "INSERT INTO t VALUES (1)");
    assert.equal(toDsqlStatement("DROP TABLE t"), "DROP TABLE t");
  });
  test("every statement of the real migrations is accepted by the adapter: no DESC left, every index asynchronous", async () => {
    const sql = await readFile(join(MIGRATIONS_DIR, "001_init.sql"), "utf8");
    const statements = splitStatements(sql);
    assert.equal(statements.length, 10);
    for (const s of statements) {
      const t = toDsqlStatement(s);
      if (isIndexStatement(s)) {
        assert.match(t, /^CREATE (UNIQUE )?INDEX ASYNC IF NOT EXISTS [a-z_]+ ON [a-z_]+ \(/);
        assert.doesNotMatch(t.split(/\sWHERE\s/i)[0], /\b(DESC|ASC)\b/i);
      } else assert.match(t, /^CREATE TABLE IF NOT EXISTS /);
    }
    assert.ok(!statements.some((s) => /\bbytea\b/i.test(s)), "aucune colonne bytea : DSQL ne sait pas l'indexer");
  });
});

describe("conflicts of optimistic concurrency", () => {
  test("isConflict: SQLSTATE 40001 or an OC000 / OC001 message, nothing else", () => {
    assert.equal(isConflict(occ()), true);
    assert.equal(isConflict(Object.assign(new Error("schema has been updated by another transaction (OC001)"), { code: undefined })), true);
    assert.equal(isConflict(Object.assign(new Error("duplicate key"), { code: "23505" })), false);
    assert.equal(isConflict(new Error("boom")), false);
    assert.equal(isConflict(null), false);
  });

  test("withRetry replays on a conflict with growing waits, then gives up; other errors are not replayed", async () => {
    const waits = [];
    let calls = 0;
    const out = await withRetry(async (attempt) => {
      calls++;
      if (attempt < 3) throw occ();
      return "ok";
    }, { wait: async (ms) => waits.push(ms), baseMs: 10, maxMs: 1000 });
    assert.equal(out, "ok");
    assert.equal(calls, 4);
    assert.equal(waits.length, 3);
    assert.ok(waits[0] < waits[2], "l'attente grandit : " + waits.join(", "));

    calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw occ("OC001"); }, { retries: 2, wait: noWait }), /OC001/);
    assert.equal(calls, 3, "1 essai + 2 reprises");

    calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw Object.assign(new Error("contrainte"), { code: "23505" }); }, { wait: noWait }), /contrainte/);
    assert.equal(calls, 1);
  });

  // Un pool factice qui garde la trace de ce qu'on lui demande et qui peut échouer sur commande.
  const fakePool = (script = () => ({ rows: [], rowCount: 0 })) => {
    const log = [];
    const client = { query: async (text, params) => { log.push(String(text)); return script(String(text), params) || { rows: [], rowCount: 0 }; }, release: () => log.push("release") };
    return { log, pool: { ...client, connect: async () => client, end: async () => log.push("end"), on() {} } };
  };

  test("query() on a DSQL pool is replayed after a conflict", async () => {
    let failures = 2;
    const { pool, log } = fakePool((text) => { if (/UPDATE/.test(text) && failures-- > 0) throw occ(); return { rows: [{ ok: 1 }], rowCount: 1 }; });
    const db = poolDb(pool, { kind: "dsql", retry: { wait: noWait } });
    assert.deepEqual((await db.query("UPDATE t SET x = 1")).rows, [{ ok: 1 }]);
    assert.equal(log.filter((l) => /UPDATE/.test(l)).length, 3);
  });

  test("tx() replays the whole transaction (BEGIN … ROLLBACK, BEGIN … COMMIT), the callback must therefore be replayable", async () => {
    let failures = 1;
    const { pool, log } = fakePool((text) => { if (text === "COMMIT" && failures-- > 0) throw occ(); });
    const db = poolDb(pool, { kind: "dsql", retry: { wait: noWait } });
    let runs = 0;
    const out = await db.tx(async (t) => { runs++; await t.query("INSERT INTO t VALUES (1)"); return "fait"; });
    assert.equal(out, "fait");
    assert.equal(runs, 2);
    assert.deepEqual(log.filter((l) => l !== "release"), ["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT", "ROLLBACK", "BEGIN", "INSERT INTO t VALUES (1)", "COMMIT"]);
    assert.equal(log.filter((l) => l === "release").length, 2, "la connexion est toujours rendue au pool");
  });

  test("a PostgreSQL pool never replays anything (no optimistic concurrency there)", async () => {
    let calls = 0;
    const { pool } = fakePool(() => { calls++; throw occ(); });
    const db = poolDb(pool, { kind: "postgres" });
    await assert.rejects(db.query("SELECT 1"), /OC000/);
    assert.equal(calls, 1);
  });
});

describe("createDb in DSQL mode", () => {
  const spy = () => {
    const made = { pools: [], clients: [] };
    class Pool {
      constructor(cfg) { this.cfg = cfg; this.ended = false; made.pools.push(this); }
      on() {}
      async query() { return { rows: [], rowCount: 0 }; }
      async connect() { return { query: async () => ({ rows: [], rowCount: 0 }), release() {} }; }
      async end() { this.ended = true; }
    }
    class Client {
      constructor(cfg) { this.cfg = cfg; this.log = []; made.clients.push(this); }
      on() {}
      async connect() { this.connected = true; }
      async query(text) { this.log.push(text); return { rows: [], rowCount: 0 }; }
      async end() { this.ended = true; }
    }
    return { made, connector: { AuroraDSQLPool: Pool, AuroraDSQLClient: Client } };
  };

  test("the pool is small, authenticated as the given database role, and closed with the database", async () => {
    const { made, connector } = spy();
    const db = await createDb({ dsql: { endpoint: "abc.dsql.eu-north-1.on.aws", user: "pixcar_api", max: 3, connector } });
    assert.equal(db.kind, "dsql");
    assert.equal(made.pools.length, 1);
    assert.deepEqual({ host: made.pools[0].cfg.host, user: made.pools[0].cfg.user, max: made.pools[0].cfg.max, database: made.pools[0].cfg.database }, { host: "abc.dsql.eu-north-1.on.aws", user: "pixcar_api", max: 3, database: "postgres" });
    assert.ok(made.pools[0].cfg.connectionTimeoutMillis <= 5000 && made.pools[0].cfg.query_timeout >= 1000, "délais bornés");
    assert.ok(made.pools[0].cfg.maxLifetimeSeconds > 0 && made.pools[0].cfg.maxLifetimeSeconds <= 55 * 60, "connexions renouvelées avant la limite de 60 minutes de DSQL");
    await db.close();
    assert.equal(made.pools[0].ended, true);
  });

  test("session(): its own client, no locks, closed afterwards", async () => {
    const { made, connector } = spy();
    const db = await createDb({ dsql: { endpoint: "abc.dsql.eu-north-1.on.aws", user: "admin", connector } });
    const out = await db.session(async (s) => {
      await s.lock(1);
      await s.exec("SELECT 1");
      await s.unlock(1);
      return typeof s.tx;
    });
    assert.equal(out, "function");
    assert.equal(made.clients.length, 1);
    assert.equal(made.clients[0].connected, true);
    assert.deepEqual(made.clients[0].log, ["SELECT 1"], "ni SELECT pg_advisory_lock ni autre chose : DSQL n'a pas de verrous");
    assert.equal(made.clients[0].ended, true);
  });
});

// ---- migrations sur DSQL, avec une session factice
function dsqlSession({ jobs = {}, applied = [], failOn } = {}) {
  const log = [];
  const polls = {};
  const s = {
    log,
    lock: async () => log.push("lock"),
    unlock: async () => log.push("unlock"),
    exec: async (sql) => { log.push("exec: " + sql.replace(/\s+/g, " ")); if (failOn && failOn.test(sql)) throw new Error("refus de DSQL"); },
    query: async (sql, params) => {
      log.push("query: " + sql.replace(/\s+/g, " ").slice(0, 90));
      if (/FROM schema_migrations/.test(sql)) return { rows: applied.map((version) => ({ version })), rowCount: applied.length };
      if (/^CREATE (UNIQUE )?INDEX ASYNC/.test(sql)) { const name = /EXISTS (\w+)/.exec(sql)[1]; return { rows: [{ job_id: "job-" + name }], rowCount: 1 }; }
      if (/FROM sys\.jobs/.test(sql)) {
        const seq = jobs[params[0]] || ["completed"];
        const n = (polls[params[0]] = (polls[params[0]] || 0) + 1);
        const status = seq[Math.min(n - 1, seq.length - 1)];
        return { rows: [{ status, details: status === "failed" ? "Found duplicate key while validating index for UCVs" : "" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    tx: async () => { throw new Error("DSQL : pas de transaction pour la structure"); },
  };
  return { s, db: { kind: "dsql", session: (fn) => fn(s) } };
}
async function migrationsDir(files) {
  const dir = await mkdtemp(join(tmpdir(), "pixcar-mig-"));
  for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
  return dir;
}
const fast = { pollMs: 0, timeoutMs: 5000 };

describe("migrate on DSQL", () => {
  test("one DDL statement at a time (autocommit), the asynchronous indexes are waited for, the version is recorded last", async () => {
    const dir = await migrationsDir({ "001_a.sql": "CREATE TABLE t (id int PRIMARY KEY, n int); CREATE INDEX t_n ON t (n DESC); INSERT INTO t VALUES (1, 1);" });
    const { s, db } = dsqlSession({ jobs: { "job-t_n": ["submitted", "processing", "completed"] } });
    const applied = await migrate(db, dir, () => {}, fast);
    assert.deepEqual(applied, ["001_a.sql"]);
    const steps = s.log.filter((l) => !/schema_migrations \(version text/.test(l));
    const expected = [
      /^lock$/,
      /^query: SELECT version FROM schema_migrations/,
      /^exec: CREATE TABLE IF NOT EXISTS t \(id int PRIMARY KEY, n int\)$/,
      /^query: CREATE INDEX ASYNC IF NOT EXISTS t_n ON t \(n\)$/,
      /^query: SELECT status, details FROM sys\.jobs WHERE job_id = \$1$/, // submitted
      /^query: SELECT status, details FROM sys\.jobs WHERE job_id = \$1$/, // processing
      /^query: SELECT status, details FROM sys\.jobs WHERE job_id = \$1$/, // completed
      /^exec: INSERT INTO t VALUES \(1, 1\)$/,
      /^query: INSERT INTO schema_migrations \(version\) VALUES \(\$1\)/,
      /^unlock$/,
    ];
    assert.equal(steps.length, expected.length, steps.join("\n"));
    expected.forEach((re, i) => assert.match(steps[i], re, `étape ${i + 1}`));
  });

  test("a migration already recorded is skipped; the real migrations produce 4 tables and 6 index jobs", async () => {
    const { s, db } = dsqlSession({ applied: ["001_init.sql"] });
    assert.deepEqual(await migrate(db, MIGRATIONS_DIR, () => {}, fast), []);
    assert.ok(!s.log.some((l) => /CREATE TABLE IF NOT EXISTS (garages|repairs)/.test(l)));

    const fresh = dsqlSession();
    assert.deepEqual(await migrate(fresh.db, MIGRATIONS_DIR, () => {}, fast), ["001_init.sql"]);
    assert.equal(fresh.s.log.filter((l) => /^exec: CREATE TABLE IF NOT EXISTS (garages|repairs|write_log|upstream_cache)/.test(l)).length, 4);
    assert.equal(fresh.s.log.filter((l) => /^query: CREATE (UNIQUE )?INDEX ASYNC IF NOT EXISTS/.test(l)).length, 6);
  });

  test("a failed index build stops the migration with the reason, and nothing is recorded", async () => {
    const dir = await migrationsDir({ "001_a.sql": "CREATE TABLE t (id int PRIMARY KEY, n int); CREATE UNIQUE INDEX t_n ON t (n);" });
    const { s, db } = dsqlSession({ jobs: { "job-t_n": ["processing", "failed"] } });
    await assert.rejects(migrate(db, dir, () => {}, fast), /construction d'index échouée.*duplicate key/s);
    assert.ok(!s.log.some((l) => /INSERT INTO schema_migrations/.test(l)));
    assert.ok(s.log.includes("unlock"), "le verrou (sans effet ici) est toujours rendu");
  });

  test("waitForJob gives up on an unknown job and on a job that never ends", async () => {
    const s = { query: async () => ({ rows: [] }) };
    await assert.rejects(waitForJob(s, "j", { pollMs: 0, wait: noWait }), /introuvable/);
    const slow = { query: async () => ({ rows: [{ status: "processing" }] }) };
    await assert.rejects(waitForJob(slow, "j", { pollMs: 1, timeoutMs: 20 }), /trop longue/);
  });
});

describe("ensureRuntimeRole", () => {
  const ARN = "arn:aws:iam::123456789012:role/pixcar-api-role";
  // mappings : lignes de sys.iam_pg_role_mappings que la base « connaît » ; null = la vue n'existe pas (la requête échoue)
  const session = (fail = {}, mappings = null) => {
    const log = [], queries = [];
    const s = {
      exec: async (sql) => { log.push(sql); for (const [re, err] of Object.entries(fail)) if (new RegExp(re).test(sql)) throw err; },
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (mappings === null) throw new Error('relation "sys.iam_pg_role_mappings" does not exist');
        return { rows: mappings.filter((m) => m.pg_role_name === params[0] && m.arn === params[1]).map(() => ({ ok: 1 })) };
      },
    };
    return { log, queries, db: { kind: "dsql", session: (fn) => fn(s) } };
  };

  test("creates the role, binds it to the IAM role of the API, opens the schema and grants only DML on the four tables", async () => {
    const { db, log, queries } = session();
    const steps = await ensureRuntimeRole(db, { iamRoleArn: ARN }, () => {});
    assert.deepEqual(log, [
      "CREATE ROLE pixcar_api WITH LOGIN",
      `AWS IAM GRANT pixcar_api TO '${ARN}'`,
      "GRANT USAGE ON SCHEMA public TO pixcar_api",
      "GRANT SELECT, INSERT, UPDATE, DELETE ON garages, repairs, write_log, upstream_cache TO pixcar_api",
    ]);
    assert.equal(steps.length, 4);
    assert.deepEqual(queries.map((q) => [q.sql, q.params]), [["SELECT 1 AS ok FROM sys.iam_pg_role_mappings WHERE pg_role_name = $1 AND arn = $2", ["pixcar_api", ARN]]]);
  });

  test("can be run again: an existing role or an existing link is not an error (even if the mappings view cannot be read)", async () => {
    const { db, log } = session({ "^CREATE ROLE": Object.assign(new Error('role "pixcar_api" already exists'), { code: "42710" }), "^AWS IAM GRANT": new Error("role already has a trust relationship") });
    const steps = await ensureRuntimeRole(db, { iamRoleArn: ARN }, () => {});
    assert.equal(log.length, 4);
    assert.match(steps[0], /déjà en place/);
    assert.match(steps[1], /déjà en place/);
    assert.match(steps[2], /fait/);
    assert.match(steps[3], /fait/);
  });

  test("a link that the mappings view already shows is not granted again — whatever the wording of DSQL's error would be", async () => {
    const { db, log } = session({ "^AWS IAM GRANT": new Error("cela ne doit pas être exécuté") }, [{ pg_role_name: "pixcar_api", arn: ARN }]);
    const steps = await ensureRuntimeRole(db, { iamRoleArn: ARN }, () => {});
    assert.ok(!log.some((l) => /^AWS IAM GRANT/.test(l)));
    assert.match(steps[1], /lien avec le rôle IAM : déjà en place/);
    assert.equal(log.length, 3);
    // un autre rôle IAM lié au même rôle de base n'empêche pas de lier celui-ci
    const other = session({}, [{ pg_role_name: "pixcar_api", arn: "arn:aws:iam::123456789012:role/autre" }]);
    await ensureRuntimeRole(other.db, { iamRoleArn: ARN }, () => {});
    assert.ok(other.log.some((l) => l.startsWith("AWS IAM GRANT")));
  });

  test("any other failure is reported, and nothing unsafe is ever put into the SQL", async () => {
    await assert.rejects(ensureRuntimeRole(session({ "^GRANT": new Error("permission denied") }).db, { iamRoleArn: ARN }), /permission denied/);
    for (const bad of ["", "pas-un-arn", "arn:aws:iam::123456789012:role/x'; DROP TABLE repairs; --", "arn:aws:iam::12345:role/x", "arn:aws:iam::123456789012:user/x"]) {
      await assert.rejects(ensureRuntimeRole(session().db, { iamRoleArn: bad }), /ARN/, bad);
    }
    for (const role of ["Pixcar", "x; DROP ROLE admin", "1abc", ""]) await assert.rejects(ensureRuntimeRole(session().db, { role, iamRoleArn: ARN }), /rôle invalide/, role);
    await assert.rejects(ensureRuntimeRole(session().db, { iamRoleArn: ARN, tables: ["repairs; DROP TABLE x"] }), /table invalide/);
  });

  test("does nothing outside DSQL", async () => {
    const out = await ensureRuntimeRole({ kind: "postgres" }, { iamRoleArn: ARN });
    assert.ok(out.skipped);
  });
});
