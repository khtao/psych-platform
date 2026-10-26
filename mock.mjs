/**
 * 内存版 D1 + Assets 模拟，供 test-worker.mjs 与 serve.mjs 共用。
 * 支持本项目用到的 SQL 模式：CREATE TABLE / INSERT / UPDATE / DELETE / SELECT(含 COUNT、WHERE、ORDER BY)
 */

function makeDB() {
  const tables = {};
  const has = {};
  let lastChanges = 0;
  const norm = s => s.replace(/\s+/g, ' ').trim();

  function coerce(v) {
    if (v === undefined) return undefined;
    let t = String(v).trim();
    if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
    if (t === 'null') return null;
    if (t === '0' || t === '1') return Number(t);
    if (/^-?\d+$/.test(t)) return Number(t);
    return v;
  }

  function ensure(t) { if (!has[t]) { has[t] = true; tables[t] = []; } return tables[t]; }

  function matchWhere(sql, row, wargs) {
    if (!/WHERE/.test(sql)) return true;
    const w = sql.slice(sql.indexOf('WHERE') + 5);
    // 参数化等式：按 ? 出现顺序
    const eqs = [...w.matchAll(/(\w+)\s*=\s*\?/g)].map(m => m[1]);
    let ai = 0;
    for (const col of eqs) {
      if (String(row[col]) !== String(wargs[ai++])) return false;
    }
    // 硬编码等式
    const hardEq = [...w.matchAll(/(\w+)\s*=\s*(\d+)/g)];
    for (const m of hardEq) {
      if (m[1] === 'deleted' || m[1] === 'valid' || m[1] === 'usable' || m[1] === 'builtin' || m[1] === 'reverse') {
        if (Number(row[m[1]]) !== Number(m[2])) return false;
      }
    }
    const hardStr = [...w.matchAll(/(\w+)\s*=\s*'([^']*)'/g)];
    for (const m of hardStr) if (String(row[m[1]]) !== m[2]) return false;
    // IN (?)
    const inM = w.match(/(\w+)\s+IN\s+\(([^)]+)\)/);
    if (inM) {
      const vals = wargs.slice(ai);
      if (!vals.map(String).includes(String(row[inM[1]]))) return false;
    }
    // LIKE
    const like = w.match(/(\w+)\s+LIKE\s+\?/);
    if (like) {
      const pat = String(wargs[ai] || '').replace(/%/g, '');
      if (!String(row[like[1]] || '').includes(pat)) return false;
    }
    return true;
  }

  function meta() { return { success: true, meta: { changes: lastChanges, rows_written: lastChanges } }; }

  // 单条 SELECT：支持 `col AS alias`、`COUNT(*) AS n`、`IN (?,?)`、`GROUP BY`
  async function runSelect(s, args) {
    const sel = s.match(/^SELECT (.+?) FROM (\w+)/);
    if (!sel) return [];
    const projRaw = sel[1].trim();
    const t = ensure(sel[2]);
    let rows = t.slice();
    const afterWhere = s.match(/WHERE (.+?)(?: GROUP BY| ORDER BY|$)/);
    if (afterWhere) rows = rows.filter(r => matchWhere('WHERE ' + afterWhere[1], r, args));

    // 投影：`*` 原样；否则解析每一列的 表达式/别名
    const isStar = projRaw === '*';
    const cols = isStar ? null : projRaw.split(',').map(x => x.trim()).map(spec => {
      const m = spec.match(/^(.+?)\s+AS\s+(\w+)$/i);
      if (m) return { expr: m[1].trim(), alias: m[2] };
      const m2 = spec.match(/^(\w+)\s+(\w+)$/);          // `col alias`（无 AS）
      if (m2 && !/^(COUNT|SUM|MAX|MIN|AVG)$/i.test(m2[1])) return { expr: m2[1], alias: m2[2] };
      return { expr: spec, alias: spec };
    });

    // GROUP BY
    const gb = s.match(/GROUP BY (\w+)/);
    if (gb && cols) {
      const key = gb[1];
      const buckets = new Map();
      for (const r of rows) {
        const k = String(r[key] ?? '');
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(r);
      }
      const out = [];
      for (const [k, group] of buckets) {
        const obj = {};
        for (const c of cols) {
          if (/^COUNT\(\*\)$/i.test(c.expr)) obj[c.alias] = group.length;
          else obj[c.alias] = group[0][c.expr];
        }
        out.push(obj);
      }
      return out;
    }

    const ob = s.match(/ORDER BY (\w+)\s*(ASC|DESC)?/);
    if (ob) {
      rows.sort((a, b) => {
        const x = String(a[ob[1]] ?? ''), y = String(b[ob[1]] ?? '');
        return (ob[2] === 'DESC') ? y.localeCompare(x) : x.localeCompare(y);
      });
    }
    if (isStar) return rows.map(r => ({ ...r }));
    return rows.map(r => {
      const obj = {};
      for (const c of cols) obj[c.alias] = r[c.expr];
      return obj;
    });
  }

  const stmt = sql => {
    let args = [];
    const api = {

      bind(...a) { args = a; return api; },

      async run() {
        const s = norm(sql);
        const ct = s.match(/^CREATE TABLE IF NOT EXISTS (\w+)/);
        if (ct) { const t = ct[1]; if (!has[t]) { has[t] = true; tables[t] = tables[t] || []; lastChanges = 1; } else lastChanges = 0; return meta(); }
        if (/^CREATE INDEX/.test(s)) { lastChanges = 0; return meta(); }

        const ins = s.match(/^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)/);
        if (ins) {
          const t = ensure(ins[1]);
          const cols = ins[2].split(',').map(x => x.trim());
          const vals = ins[3].split(',').map(x => x.trim());
          const obj = {};
          let ai = 0;
          cols.forEach((c, i) => { obj[c] = vals[i] === '?' ? args[ai++] : coerce(vals[i]); });
          // ON CONFLICT 简易模拟：主键存在则更新
          const pkIdx = t.findIndex(r => String(r[cols[0]]) === String(obj[cols[0]]));
          if (pkIdx >= 0) { Object.assign(t[pkIdx], obj); } else { t.push(obj); }
          lastChanges = 1;
          return meta();
        }

        if (/^UPDATE (\w+) SET/.test(s)) {
          const t = ensure(s.match(/^UPDATE (\w+) SET/)[1]);
          const setPart = s.match(/SET (.+?) WHERE/);
          const afterWhere = s.match(/WHERE (.+)$/);
          const sets = setPart[1].split(',').map(x => x.trim());
          let ai = 0;
          const setters = sets.map(pair => {
            const eq = pair.lastIndexOf('=');
            const k = pair.slice(0, eq).trim(), v = pair.slice(eq + 1).trim();
            if (v === '?') return { k, val: args[ai++] };
            if (v === 'NULL') return { k, val: null };
            return { k, val: coerce(v) };
          });
          const wargs = args.slice(ai);
          let n = 0;
          t.forEach(row => {
            if (afterWhere && !matchWhere('WHERE ' + afterWhere[1], row, wargs)) return;
            setters.forEach(({ k, val }) => { row[k] = val; });
            n++;
          });
          lastChanges = n;
          return meta();
        }

        if (/^DELETE FROM (\w+)/.test(s)) {
          const t = ensure(s.match(/^DELETE FROM (\w+)/)[1]);
          const before = t.length;
          const afterWhere = s.match(/WHERE (.+)$/);
          if (afterWhere) {
            for (let i = t.length - 1; i >= 0; i--) {
              if (matchWhere('WHERE ' + afterWhere[1], t[i], args)) t.splice(i, 1);
            }
          } else { t.length = 0; }
          lastChanges = before - t.length;
          return meta();
        }
        lastChanges = 0;
        return meta();
      },

      async all() {
        const s = norm(sql);
        if (/sqlite_master/.test(s)) {
          const names = Object.keys(has).filter(t => has[t]);
          if (/name\s*=\s*\?/.test(s)) return { success: true, results: names.filter(n => n === args[0]).map(n => ({ name: n })) };
          return { success: true, results: names.map(n => ({ name: n })) };
        }

        // UNION ALL：分段执行后拼接（health 接口把 4 次 COUNT 合并成 1 次）
        if (/ UNION ALL /.test(s)) {
          const parts = s.split(/ UNION ALL /);
          const out = [];
          let consumed = 0;
          for (const part of parts) {
            const sub = await runSelect(part, args.slice(consumed));
            consumed += (part.match(/\?/g) || []).length;
            out.push(...sub);
          }
          return { success: true, results: out };
        }

        return { success: true, results: await runSelect(s, args) };
      },

      async first() {
        const s = norm(sql);
        if (/sqlite_master/.test(s)) { const r = await api.all(); return r.results[0] || null; }
        if (/SELECT id FROM (\w+) LIMIT 1/.test(s)) {
          const t = s.match(/SELECT id FROM (\w+) LIMIT 1/)[1];
          if (!has[t]) throw new Error('no such table: ' + t);
          return (tables[t] && tables[t][0]) || null;
        }
        if (/COUNT\(\*\)/.test(s)) {
          const t = s.match(/FROM (\w+)/)[1];
          if (!has[t]) throw new Error('no such table: ' + t);
          const r = await api.all();
          return { n: r.results.length };
        }
        const r = await api.all();
        return r.results[0] || null;
      },
    };
    return api;
  };

  // D1 原生批量接口：接收已 bind 的 prepared statement 数组
  async function batch(stmts) {
    const out = [];
    for (const s of stmts) out.push(await s.run());
    return out;
  }

  return { prepare: stmt, batch, _t: tables, _has: has };
}

function makeAssets(files) {
  return {
    async fetch(req) {
      const u = (req && req.url) ? new URL(req.url) : new URL(String(req));
      const key = u.pathname.replace(/^\//, '');
      const body = files[key];
      if (body === undefined) return new Response('not found', { status: 404 });
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    },
  };
}

export { makeDB, makeAssets };
