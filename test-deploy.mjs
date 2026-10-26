// 部署场景专项测试（必须独立进程运行：模块级播种标志会互相污染）
import { makeDB } from './mock.mjs';
import worker from './worker.js';

let pass_n = 0, fail_n = 0;
function check(name, ok, extra = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass_n++ : fail_n++;
}
const J = (m, d, t) => ({ method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: d ? JSON.stringify(d) : undefined });
const ASSETS = { async fetch(){ return new Response('x', { headers: { 'Content-Type': 'text/html' } }); } };

// 可统计语句数的 D1 包装（batch 按条数计，模拟最严格场景）
function countedDB() {
  const db = makeDB(); let n = 0;
  return {
    _reset(){ n = 0; }, _n(){ return n; },
    prepare(sql){ n++; const st = db.prepare(sql);
      return { bind(...a){ const s = st.bind(...a); return { all:()=>s.all(), first:()=>s.first(), run:()=>s.run() }; },
        all:()=>st.all(), first:()=>st.first(), run:()=>st.run() }; },
    async batch(ss){ n += ss.length; const o = []; for (const s of ss) o.push(await s.run()); return o; },
    async exec(x){ n++; return db.exec(x); },
  };
}
function makeCall(env) {
  return async (p, o = {}) => {
    const r = await worker.fetch(new Request('https://x.dev' + p, o), env, {});
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? await r.json() : await r.text();
  };
}

console.log('── 部署场景：分批播种 ──');

// ① 单次请求的语句数必须可控（不能出现 800+ 条塞进一个请求）
{
  const counted = countedDB();
  const env2 = { DB: counted, ASSETS, TEACHER_PASSWORD: 'gg26x' };
  const c2 = makeCall(env2);
  counted._reset(); await c2('/api/health'); const tbl = counted._n();
  counted._reset(); await c2('/api/auth', J('POST', { password: 'gg26x' })); const lg = counted._n();
  check('★ 登录不再触发全量播种（原本 847 条）', lg < 20, `登录 ${lg} 条语句（建表 ${tbl} 条）`);
  const tk2 = (await c2('/api/auth', J('POST', { password: 'gg26x' }))).token;
  let maxPerReq = 0, rounds = 0;
  for (let i = 0; i < 200; i++) {
    counted._reset(); rounds++;
    const sr = await c2('/api/seed?limit=100', { headers: { Authorization: 'Bearer ' + tk2 } });
    maxPerReq = Math.max(maxPerReq, counted._n());
    if (sr.done || sr.remaining === 0) break;
  }
  check('★ 单次播种请求语句数可控', maxPerReq < 400, `最多 ${maxPerReq} 条/次，共 ${rounds} 轮`);
  const sc2 = await c2('/api/admin/scales', { headers: { Authorization: 'Bearer ' + tk2 } });
  check('★ 分批播种最终完整', sc2.length === 24
    && sc2.reduce((a, s) => a + s.itemImported, 0) === 669,
    `${sc2.length} 量表 / ${sc2.reduce((a, s) => a + s.itemImported, 0)} 题`);
}

// ② 中断后可恢复：造一个"只播了一半"的库，继续调用必须能补完
{
  const env3 = { DB: makeDB(), ASSETS, TEACHER_PASSWORD: 'gg26x' };
  const c3 = makeCall(env3);
  await c3('/api/health');
  const tk3 = (await c3('/api/auth', J('POST', { password: 'gg26x' }))).token;
  // 只跑一轮，人为制造"半截状态"
  await c3('/api/seed?limit=30', { headers: { Authorization: 'Bearer ' + tk3 } });
  const mid = await c3('/api/seed', { headers: { Authorization: 'Bearer ' + tk3 } });
  check('中断后仍报告未完成', mid.done === false && mid.remaining > 0, `还剩 ${mid.remaining} 个`);
  // 继续补完
  for (let i = 0; i < 200; i++) {
    const sr = await c3('/api/seed?limit=150', { headers: { Authorization: 'Bearer ' + tk3 } });
    if (sr.done || sr.remaining === 0) break;
  }
  const fin = await c3('/api/admin/scales', { headers: { Authorization: 'Bearer ' + tk3 } });
  check('★ 中断后可继续补完（不会永久卡死）', fin.length === 24
    && fin.reduce((a, s) => a + s.itemImported, 0) === 669,
    `${fin.length} 量表 / ${fin.reduce((a, s) => a + s.itemImported, 0)} 题`);
}

// ③ /api/diag 能报告题库状态
{
  const env4 = { DB: makeDB(), ASSETS, TEACHER_PASSWORD: 'gg26x' };
  const c4 = makeCall(env4);
  await c4('/api/health');
  const tk4 = (await c4('/api/auth', J('POST', { password: 'gg26x' }))).token;
  for (let i = 0; i < 200; i++) {
    const sr = await c4('/api/seed?limit=150', { headers: { Authorization: 'Bearer ' + tk4 } });
    if (sr.done || sr.remaining === 0) break;
  }
  const d = await c4('/api/diag?pwd=gg26x');
  check('★ 诊断接口报告题库完整度', d && d['题库完整'] === true,
    `量表 ${d['内置量表数']}/${d['应有量表数']}，题目 ${d['题目总数']}/${d['应有题目数']}`);
}


console.log('\n==========================================');
console.log(`  通过 ${pass_n} 项，失败 ${fail_n} 项`);
console.log('==========================================');
process.exit(fail_n ? 1 : 0);
