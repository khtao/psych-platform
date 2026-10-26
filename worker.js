/**
 * 学校心理健康筛查与干预管理平台 · Cloudflare Worker
 *
 * 工作流：普查计划 → 阳性筛查 → 访谈复核 → 建档干预 → 复测对比 → 转介/结案
 * 存储：D1（KV 免费层每天仅 1000 次写入，全校普查会超限）
 */

import { SCALE_ITEM_BANK } from './scale-items.js';
import { SCALE_ITEM_BANK2 } from './scale-items2.js';

// 合并两批题库
Object.assign(SCALE_ITEM_BANK, SCALE_ITEM_BANK2);

export default {
  async fetch(request, env, ctx) {
    return handle(request, env).catch(err => {
      console.error('[未捕获异常] message =', err && err.message);
      console.error('[未捕获异常] cause  =', err && err.cause && err.cause.message);
      console.error('[未捕获异常] stack  =', err && err.stack);
      return json({
        ok: false,
        message: (err && err.message) ? err.message : String(err),
        hint: '若提示 no such table，请访问 /setup 初始化数据库',
      }, 500);
    });
  },
};

// ==================== 基础工具 ====================
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

function json(data, status = 200, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...(extraHeaders || {}) },
  });
}

function parseJSON(v, fallback) {
  if (typeof v !== 'string') return (v === undefined || v === null) ? fallback : v;
  try { return JSON.parse(v); } catch (e) { return fallback; }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nowISO = () => new Date().toISOString();

// ---------- 密码：存在 D1 settings 表，支持修改 ----------
const DEFAULT_PWD = 'gg26x';

async function getSetting(env, k, fallback = '') {
  try {
    const r = await env.DB.prepare('SELECT v FROM settings WHERE k = ?').bind(k).first();
    return (r && r.v !== undefined && r.v !== null) ? r.v : fallback;
  } catch (e) { return fallback; }
}

async function setSetting(env, k, v) {
  await env.DB.prepare(
    'INSERT INTO settings (k, v, updatedAt) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=?, updatedAt=?'
  ).bind(k, v, nowISO(), v, nowISO()).run();
}

// 密码优先取 D1 settings，其次 secret/vars
async function password(env) {
  const s = await getSetting(env, 'teacher_password', '');
  if (s) return s;
  return env.TEACHER_PASSWORD || env.PASSWORD || DEFAULT_PWD;
}

async function passwordSource(env) {
  const s = await getSetting(env, 'teacher_password', '');
  if (s) return 'database';
  if (env.TEACHER_PASSWORD || env.PASSWORD) return 'config';
  return 'default';
}

// ---------- 无状态 token（HMAC，含过期时间）----------
function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

async function issueToken(env, hours = 720) {   // 默认 30 天，登录持久化
  const payload = b64url(new TextEncoder().encode(JSON.stringify({
    exp: Date.now() + hours * 3600 * 1000, pwdVer: await getSetting(env, 'pwd_version', '1'),
  })));
  return payload + '.' + (await hmac(await password(env), payload));
}

async function verifyToken(env, token) {
  if (!token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  if (sig !== await hmac(await password(env), payload)) return false;
  try {
    const d = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return Date.now() < d.exp;
  } catch (e) { return false; }
}

function bearer(req) {
  const h = req.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

// ==================== 自动建表 ====================
const TABLES = {
  scales: `CREATE TABLE IF NOT EXISTS scales (
    id TEXT PRIMARY KEY, code TEXT, name TEXT NOT NULL, shortName TEXT,
    itemCount INTEGER, responseType TEXT, gradeRange TEXT, dimensionNote TEXT,
    scoringNote TEXT, reliability TEXT, revision TEXT, copyright TEXT,
    copyrightNote TEXT, normNote TEXT, usable INTEGER DEFAULT 0,
    builtin INTEGER DEFAULT 0, createdAt TEXT, deleted INTEGER DEFAULT 0)`,
  scale_dims: `CREATE TABLE IF NOT EXISTS scale_dims (
    id TEXT PRIMARY KEY, scaleId TEXT NOT NULL, dimIndex INTEGER NOT NULL,
    name TEXT NOT NULL, itemCount INTEGER, direction TEXT DEFAULT 'higher_worse',
    maxScore INTEGER, cutNormal INTEGER, cutBorder INTEGER, note TEXT)`,
  scale_items: `CREATE TABLE IF NOT EXISTS scale_items (
    id TEXT PRIMARY KEY, scaleId TEXT NOT NULL, dimId TEXT, itemIndex INTEGER NOT NULL,
    type TEXT DEFAULT 'normal', title TEXT NOT NULL, options TEXT,
    reverse INTEGER DEFAULT 0, scoreMap TEXT)`,
  plans: `CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, term TEXT, gradeScope TEXT, classScope TEXT,
    scaleIds TEXT, startAt TEXT, endAt TEXT, status TEXT DEFAULT 'draft',
    anonymous INTEGER DEFAULT 0, notice TEXT, createdAt TEXT, deleted INTEGER DEFAULT 0)`,
  responses: `CREATE TABLE IF NOT EXISTS responses (
    id TEXT PRIMARY KEY, planId TEXT NOT NULL, studentKey TEXT, name TEXT, gender TEXT,
    grade TEXT, className TEXT, answers TEXT, startedAt TEXT, submittedAt TEXT,
    durationSec INTEGER, valid INTEGER DEFAULT 1, invalidReason TEXT, validityNote TEXT,
    scores TEXT, suggested TEXT, deleted INTEGER DEFAULT 0, deletedAt TEXT)`,
  screenings: `CREATE TABLE IF NOT EXISTS screenings (
    id TEXT PRIMARY KEY, responseId TEXT NOT NULL, planId TEXT NOT NULL, studentKey TEXT,
    name TEXT, grade TEXT, className TEXT, suggested TEXT, opLevel TEXT, respLevel TEXT,
    confirmed TEXT, confirmedBy TEXT, confirmedAt TEXT, riskFlag INTEGER DEFAULT 0,
    note TEXT, updatedAt TEXT)`,
  interviews: `CREATE TABLE IF NOT EXISTS interviews (
    id TEXT PRIMARY KEY, screeningId TEXT NOT NULL, planId TEXT, studentKey TEXT,
    name TEXT, grade TEXT, className TEXT, interviewedAt TEXT, teacher TEXT,
    chiefComplaint TEXT, observation TEXT, riskAssessment TEXT, conclusion TEXT,
    conclusionNote TEXT, planText TEXT, guardianNotify INTEGER DEFAULT 0, createdAt TEXT)`,
  cases: `CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY, studentKey TEXT NOT NULL, name TEXT, grade TEXT, className TEXT,
    gender TEXT, openedAt TEXT, source TEXT, level TEXT, mainIssues TEXT, planText TEXT,
    status TEXT DEFAULT 'active', closedAt TEXT, closeReason TEXT, teacher TEXT, updatedAt TEXT)`,
  interventions: `CREATE TABLE IF NOT EXISTS interventions (
    id TEXT PRIMARY KEY, caseId TEXT NOT NULL, date TEXT, type TEXT, content TEXT,
    effect TEXT, teacher TEXT, createdAt TEXT)`,
  retests: `CREATE TABLE IF NOT EXISTS retests (
    id TEXT PRIMARY KEY, caseId TEXT NOT NULL, studentKey TEXT, name TEXT, grade TEXT,
    className TEXT, weeks INTEGER DEFAULT 6, dueAt TEXT, status TEXT DEFAULT 'pending',
    baselinePlanId TEXT, doneAt TEXT, donePlanId TEXT, note TEXT, createdAt TEXT)`,
  referrals: `CREATE TABLE IF NOT EXISTS referrals (
    id TEXT PRIMARY KEY, caseId TEXT NOT NULL, studentKey TEXT, name TEXT, grade TEXT,
    className TEXT, toOrg TEXT, reason TEXT, guardianConsent INTEGER DEFAULT 0,
    referredAt TEXT, feedback TEXT, feedbackAt TEXT, teacher TEXT, createdAt TEXT)`,
  closures: `CREATE TABLE IF NOT EXISTS closures (
    id TEXT PRIMARY KEY, caseId TEXT NOT NULL, studentKey TEXT, name TEXT, grade TEXT,
    className TEXT, reason TEXT, reasonNote TEXT, summary TEXT, closedAt TEXT,
    teacher TEXT, createdAt TEXT)`,
  settings: `CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT, updatedAt TEXT)`,
  surveys: `CREATE TABLE IF NOT EXISTS surveys (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'draft',
    anonymous INTEGER DEFAULT 0, startAt TEXT, endAt TEXT, notice TEXT,
    createdAt TEXT, deleted INTEGER DEFAULT 0)`,
  questions: `CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY, surveyId TEXT NOT NULL, qIndex INTEGER NOT NULL,
    type TEXT NOT NULL, title TEXT NOT NULL, required INTEGER DEFAULT 1,
    options TEXT, config TEXT)`,
  survey_responses: `CREATE TABLE IF NOT EXISTS survey_responses (
    id TEXT PRIMARY KEY, surveyId TEXT NOT NULL, studentKey TEXT, name TEXT, grade TEXT,
    className TEXT, answers TEXT, startedAt TEXT, submittedAt TEXT, durationSec INTEGER,
    deleted INTEGER DEFAULT 0, deletedAt TEXT)`,
};

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_dims_scale ON scale_dims(scaleId, dimIndex)',
  'CREATE INDEX IF NOT EXISTS idx_items_scale ON scale_items(scaleId, itemIndex)',
  'CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status, deleted)',
  'CREATE INDEX IF NOT EXISTS idx_resp_plan ON responses(planId, deleted)',
  'CREATE INDEX IF NOT EXISTS idx_resp_student ON responses(studentKey)',
  'CREATE INDEX IF NOT EXISTS idx_scr_plan ON screenings(planId)',
  'CREATE INDEX IF NOT EXISTS idx_scr_student ON screenings(studentKey)',
  'CREATE INDEX IF NOT EXISTS idx_scr_suggest ON screenings(suggested)',
  'CREATE INDEX IF NOT EXISTS idx_intv_scr ON interviews(screeningId)',
  'CREATE INDEX IF NOT EXISTS idx_cases_student ON cases(studentKey)',
  'CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status)',
  'CREATE INDEX IF NOT EXISTS idx_interv_case ON interventions(caseId)',
  'CREATE INDEX IF NOT EXISTS idx_retest_status ON retests(status, dueAt)',
  'CREATE INDEX IF NOT EXISTS idx_refer_case ON referrals(caseId)',
  'CREATE INDEX IF NOT EXISTS idx_close_case ON closures(caseId)',
  'CREATE INDEX IF NOT EXISTS idx_surveys_status ON surveys(status, deleted)',
  'CREATE INDEX IF NOT EXISTS idx_questions_survey ON questions(surveyId, qIndex)',
  'CREATE INDEX IF NOT EXISTS idx_sresp_survey ON survey_responses(surveyId, deleted)',
];

let _schemaReady = false;

async function tableExists(env, name) {
  try {
    const r = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).bind(name).first();
    return !!(r && r.name);
  } catch (e) {
    try { await env.DB.prepare(`SELECT id FROM ${name} LIMIT 1`).first(); return true; }
    catch (e2) { return false; }
  }
}

// ==================== 性能：模块级 TTL 缓存 ====================
// Worker 是多实例的，缓存只在单实例内有效；因此用短 TTL（默认 60s）
// 保证即使某个实例的失效通知没触达，数据也最多延迟 TTL 时间同步。
const _cache = new Map();
function cacheGet(key) {
  const e = _cache.get(key);
  if (!e) return undefined;
  if (Date.now() > e.exp) { _cache.delete(key); return undefined; }
  return e.val;
}
function cacheSet(key, val, ttlMs = 60000) {
  _cache.set(key, { val, exp: Date.now() + ttlMs });
  if (_cache.size > 200) {                       // 防止无界增长
    const now = Date.now();
    for (const [k, v] of _cache) if (now > v.exp) _cache.delete(k);
  }
}
// 量表/题目相关数据变动时调用，清掉本实例缓存
function invalidate(prefix) {
  for (const k of [..._cache.keys()]) {
    if (!prefix || k.startsWith(prefix)) _cache.delete(k);
  }
}

// 批量计数：把 N 次 COUNT 查询合并为 1 次 GROUP BY
// countBy(env, 'responses', 'planId', ['a','b']) → { a: 3, b: 5 }
async function countBy(env, table, col, ids, extraWhere = '') {
  const out = {};
  const valid = (ids || []).filter(Boolean);
  if (!valid.length) return out;
  const ph = valid.map(() => '?').join(',');
  try {
    const r = await env.DB.prepare(
      `SELECT ${col} AS k, COUNT(*) AS n FROM ${table} WHERE ${col} IN (${ph})${extraWhere} GROUP BY ${col}`
    ).bind(...valid).all();
    for (const x of (r.results || [])) out[x.k] = x.n;
  } catch (e) { /* 表不存在时静默返回空，由调用方兜底 */ }
  return out;
}

// 为响应生成 ETag 并处理 If-None-Match → 304。
// HTML 页改动不频繁，但每次全量重传（admin.html 数十 KB）会拖慢打开速度；
// 304 只传头部，体感明显更快，且不影响更新（内容一变 ETag 就变）。
const _etags = new Map();   // 页面内容部署后固定，ETag 只需算一次
async function withETag(request, resp) {
  try {
    const inm = request.headers.get('If-None-Match');
    const buf = await resp.arrayBuffer();
    // key 含字节长度：内容长度变了就重算（内容本身部署后固定，不必每次哈希）
    const key = request.url + '|' + buf.byteLength;
    let etag = _etags.get(key);
    if (!etag) {
      let h = 5381;
      const view = new Uint8Array(buf);
      for (let i = 0; i < view.length; i++) h = ((h << 5) + h + view[i]) | 0;
      etag = '"' + (h >>> 0).toString(16) + view.length.toString(16) + '"';
      if (_etags.size > 50) _etags.clear();
      _etags.set(key, etag);
    }
    if (inm && inm === etag) {
      return new Response(null, { status: 304, headers: {
        ETag: etag, 'Cache-Control': 'no-cache', Vary: 'If-None-Match',
      }});
    }
    const headers = new Headers(resp.headers);
    headers.set('ETag', etag);
    headers.set('Cache-Control', 'no-cache');   // 必须回源校验，保证改完网页能立刻生效
    headers.set('Vary', 'If-None-Match');
    return new Response(buf, { status: resp.status, headers });
  } catch (e) {
    return resp;                                 // 兜底：原样返回
  }
}

// 分批并发提交写操作（默认每批 50），把 N 次串行往返压到 N/50 轮
async function flushAll(stmts, size = 50) {
  for (let k = 0; k < stmts.length; k += size) {
    await Promise.all(stmts.slice(k, k + size));
  }
}

async function ensureSchema(env, force = false) {
  if (_schemaReady && !force) return { ok: true, skipped: true };
  const out = { created: [], indexes: 0, error: '' };
  try {
    for (const [name, sql] of Object.entries(TABLES)) {
      const exists = force ? false : await tableExists(env, name);
      if (!exists) { await env.DB.prepare(sql).run(); out.created.push(name); }
    }
    for (const sql of INDEXES) {
      try { await env.DB.prepare(sql).run(); out.indexes++; } catch (e) {}
    }
    _schemaReady = true;
    return { ok: true, ...out };
  } catch (e) {
    out.error = (e && e.message) ? e.message : String(e);
    return { ok: false, ...out };
  }
}

// ==================== 内置量表档案 ====================
// 说明：仅存维度结构与分档规则；题目需学校取得授权后自行导入
// ==================== 内置量表元数据（维度与题目由题库生成）====================
const BUILTIN_SCALES = [
  { id: 'mht', code: 'MHT', name: '心理健康诊断测验（MHT）', shortName: 'MHT',
    itemCount: 100, responseType: 'binary', gradeRange: '4-6',
    dimensionNote: '效度量表 + 8 个内容量表：学习焦虑、对人焦虑、孤独倾向、自责倾向、过敏倾向、身体症状、恐怖倾向、冲动倾向',
    scoringNote: '是=1 / 否=0；总分 1–55 正常、56–64 问题倾向、≥65 较严重；单项 ≥8 提示该维度问题；效度题 ≥7 判无效',
    reliability: '总量表折半信度约 0.91，分量表 0.84–0.88；重测信度 0.667–0.863',
    revision: '周步成等 1991 年修订，华东师范大学出版社',
    copyright: 'internal', copyrightNote: '校内非商业使用，建议与正版手册核对',
    normNote: '可转常模标准分（0–5 正常、6–7 有问题、≥8 较严重），须绑定手册版本' },

  { id: 'sdq', code: 'SDQ', name: '长处与困难问卷（学生自评版）', shortName: 'SDQ',
    itemCount: 25, responseType: 'likert3', gradeRange: '5-6',
    dimensionNote: '情绪症状、品行问题、多动、同伴交往问题（合计困难总分 0–40）；亲社会行为为长处维度，反向解释',
    scoringNote: '不符合/有点符合/完全符合 = 0/1/2；困难总分 0–15 正常、16–19 边缘、20–40 异常；亲社会 6–10 正常、5 边缘、0–4 异常',
    reliability: 'Goodman 1997 编制；中文版由寇建华、杜亚松、夏黎明等建立上海常模',
    revision: '中文版上海常模',
    copyright: 'internal', copyrightNote: '校内非商业使用；若对外分发或改编需 Youthinmind 授权',
    normNote: '学生版与成人报告版界值不同，须按报告者版本执行' },

  { id: 'scared', code: 'SCARED', name: '儿童焦虑性情绪障碍筛查表', shortName: 'SCARED',
    itemCount: 41, responseType: 'likert3', gradeRange: '4-6',
    dimensionNote: '躯体化/惊恐、广泛性焦虑、分离性焦虑、社交恐怖、学校恐怖',
    scoringNote: '没有/有时/经常 = 0/1/2；总分 0–82；≥25 为常用划界（灵敏度 79%、特异度 82%）',
    reliability: 'Birmaher 编制，1999 年扩为 41 题；中国修订见苏林雁、王凯等',
    revision: '中国城市常模约 9–18 岁',
    copyright: 'internal', copyrightNote: '校内非商业使用', normNote: '另有 ≥23 的文献划界版本' },

  { id: 'cdi', code: 'CDI', name: '儿童抑郁量表', shortName: 'CDI',
    itemCount: 27, responseType: 'likert3', gradeRange: '4-6',
    dimensionNote: '27 题加总为抑郁总分（0–54），含负性情绪、人际问题、效能低下、快感缺乏、负性自我概念等方面',
    scoringNote: '每题三选一计 0/1/2；总分 ≥19 或 20 为常用划界；含 1 道风险题，最高分作答自动触发危机标记',
    reliability: 'Kovacs 编制',
    revision: '原始量表约 7–17 岁；中国研究扩展至 6–17 岁',
    copyright: 'internal', copyrightNote: '校内非商业使用', normNote: '19 分见于较大样本中国应用，20 分见于部分筛查研究' },

  { id: 'lonely', code: 'LONELY', name: '儿童孤独感量表（Asher）', shortName: '孤独感',
    itemCount: 24, responseType: 'likert5', gradeRange: '3-6',
    dimensionNote: '16 个核心孤独题计分（总分 16–80）+ 8 项活动偏好插入题（不计分）',
    scoringNote: '五级计分，含 5 道反向题；分数越高孤独感越强；无统一临床界值，建议按百分位分层（参考 M=32.5、SD=11.8）',
    reliability: 'Asher、Hymel、Renshaw 1984',
    revision: '原量表适用 3–6 年级',
    copyright: 'internal', copyrightNote: '校内非商业使用', normNote: '无统一诊断界值，宜用本地常模百分位' },

  { id: 'peer', code: 'PEER', name: '同伴关系量表（邹泓）', shortName: '同伴关系',
    itemCount: 14, responseType: 'likert4', gradeRange: '3-6',
    dimensionNote: '同伴接受 / 社会适应（单维）',
    scoringNote: '四级计分，含 9 道反向题；总分 14–56，分数越高同伴关系越好',
    reliability: '邹泓 1998 编制', revision: '小学生版',
    copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '无全国统一三档划界，宜按同地区同年级同性别常模分位数分档' },

  { id: 'bully', code: 'BULLY', name: '校园欺凌受害筛查', shortName: '欺凌受害',
    itemCount: 12, responseType: 'freq4', gradeRange: '2-6',
    dimensionNote: '外显受害、关系受害、声誉受害',
    scoringNote: '按发生频率分层（从来没有 / 1–2 次 / 每月几次 / 每周至少一次）；建议分维度报告，不建议合并成唯一总分',
    reliability: '参考 RPEQ（Prinstein/Vernberg 系）与 Olweus BVQ 张文新等 1999 中文修订',
    revision: '小学版', copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '按频率分层；任一维"每月几次"及以上应引起关注' },

  { id: 'aat', code: 'AAT', name: '学习适应性测验（AAT）', shortName: 'AAT',
    itemCount: 81, responseType: 'likert3', gradeRange: '3-4',
    dimensionNote: '学习态度、学习技术、学习环境、心身健康',
    scoringNote: '经常/有时/从不 = 2/1/0；正式解释须按全国常模换算标准分（0–100）：65+ 优、55–64 中上、45–54 中、35–44 中下、≤34 差。本平台报告原始分，换算表见正版手册',
    reliability: '日本教育研究所编制，周步成等 1991 修订，华东师大出版社',
    revision: '小学 3–4 年级版 81 题', copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '标准分转换表须取自正版手册，平台不自建经验分档' },
  { id: 'phcss', code: 'PHCSS', name: '儿童自我意识量表（PHCSS）', shortName: 'PHCSS',
    itemCount: 80, responseType: 'binary', gradeRange: '2-6',
    dimensionNote: '行为、智力与学校情况、躯体外貌、焦虑、合群、幸福与满足六个分量表',
    scoringNote: '是/否二选一，正向题选"与描述相符"计 1 分；总分 0–80，得分越高自我意识水平越高。分档按本校常模设定',
    reliability: 'Piers-Harris 1969 编制；苏林雁等 1994 建立中国城市常模，Cronbach α 约 0.61–0.75',
    revision: '中国城市常模版', copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '中国常模总分 P30 / P70 可作为校本分档参考，建议按本校数据校准' },

  { id: 'testanxiety', code: 'TAS', name: '考试焦虑测验', shortName: '考试焦虑',
    itemCount: 27, responseType: 'likert4', gradeRange: '3-6',
    dimensionNote: '认知担忧、生理唤醒、行为与注意分散三个维度',
    scoringNote: '从不/有时/经常/总是 = 0/1/2/3；总分 0–81，分数越高焦虑越强',
    reliability: '参考 Sarason 考试焦虑量表（TAS）中文修订与国内研究维度编制',
    revision: '小学生版', copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '无统一临床界值，建议按本校百分位分档（如 P75 / P90）' },

  { id: 'resilience', code: 'RSCA', name: '青少年心理韧性量表', shortName: '心理韧性',
    itemCount: 30, responseType: 'likert5', gradeRange: '3-6',
    dimensionNote: '目标专注、情绪控制、积极认知、家庭支持、人际协助五个因子',
    scoringNote: '五级计分 1–5，分数越高韧性越好；低分提示抗挫折资源不足',
    reliability: '参照胡月琴、甘怡群 2008《青少年心理韧性量表》五因子结构改编',
    revision: '小学生改编版', copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '越高越好；低分（低于本校 P25）提示需要支持性干预' },

  { id: 'ctq', code: 'CTQ', name: '儿童期创伤问卷简版（CTQ-SF）', shortName: 'CTQ',
    itemCount: 28, responseType: 'likert5', gradeRange: '4-6',
    dimensionNote: '情感虐待、躯体虐待、性虐待、情感忽视、躯体忽视 + 3 题最小化/否认效度题',
    scoringNote: '五级频率计分 1–5，忽视维度为反向计分。分档参考中文版常模：情感虐待 9/13、躯体虐待 8/10、性虐待 6/8、情感忽视 10/15、躯体忽视 8/10。掩饰效度题 3 题全选"总是"判无效',
    reliability: 'Bernstein 等 1998 编制简版；中文版信效度良好（α 0.60–0.87）',
    revision: '简版 28 题', copyright: 'internal', copyrightNote: '校内非商业使用；属敏感量表',
    normNote: '⚠️ 敏感量表：建议仅在访谈发现线索后单独施测，不宜纳入全员普查' },

  { id: 'aslec', code: 'ASLEC', name: '青少年生活事件量表', shortName: 'ASLEC',
    itemCount: 27, responseType: 'event5', gradeRange: '4-6',
    dimensionNote: '人际关系、学习压力、受惩罚、丧失、健康适应五个因子',
    scoringNote: '原量表按"发生与否+影响程度"计分；本平台简化为五级频率。分数越高负性生活事件影响越大',
    reliability: '刘贤臣等 1987 编制；27 题版为常用版本',
    revision: '小学生改编版', copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '无统一诊断界值，界值为校本建议值，宜按本校数据调整' },

  { id: 'lifesat', code: 'SLSS', name: '学生生活满意度量表', shortName: '生活满意度',
    itemCount: 25, responseType: 'likert6', gradeRange: '3-6',
    dimensionNote: '家庭满意、朋友满意、学校满意、生活环境满意、自我满意五维',
    scoringNote: '六级计分 1–6，分数越高满意度越高',
    reliability: '参照 Huebner 学生生活满意度量表（SLSS/MSLSS）多维结构编制',
    revision: '小学生版', copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '越高越好；无统一划界，界值为校本建议值' },

  { id: 'scsq', code: 'SCSQ', name: '简易应对方式问卷', shortName: '应对方式',
    itemCount: 20, responseType: 'likert4', gradeRange: '4-6',
    dimensionNote: '积极应对（12 题）、消极应对（8 题）两个分量表',
    scoringNote: '不采取/偶尔/有时/经常 = 0/1/2/3；积极与消极分量表分别计分，不做总分合并',
    reliability: '解亚宁 1998 编制；α 分别为 0.89（积极）与 0.78（消极）',
    revision: '中文版', copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '消极应对偏高提示需关注；积极应对偏低提示应对资源不足' },

  { id: 'dsrsc', code: 'DSRSC', name: '儿童抑郁障碍自评量表', shortName: 'DSRSC',
    itemCount: 18, responseType: 'likert3rev', gradeRange: '3-6',
    dimensionNote: '抑郁总分（含 1 道自伤风险题）',
    scoringNote: '经常/有时/没有 = 2/1/0（正向题反向计分）；总分 0–36，≥15 为常用划界',
    reliability: 'Birleson 1981 编制；苏林雁等 2003 建立中国城市常模，Cronbach α 约 0.73',
    revision: '中国城市常模版', copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '总分 ≥15 提示抑郁倾向；风险题选"经常"自动触发危机预警' },

  { id: 'pssm', code: 'PSSM', name: '学校归属感量表', shortName: '学校归属',
    itemCount: 18, responseType: 'likert6', gradeRange: '3-6',
    dimensionNote: '归属与接纳、认同与喜欢、教师支持三个维度，含 5 道反向题',
    scoringNote: '六级计分 1–6，分数越高归属感越强；低分提示学校适应不良风险',
    reliability: 'Goodenow 1993 编制 PSSM，中文修订版信效度良好',
    revision: '中文修订版', copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '越高越好；低分与辍学风险、学校适应不良相关' },

  { id: 'psss', code: 'PSSS', name: '领悟社会支持量表', shortName: '社会支持',
    itemCount: 12, responseType: 'likert7', gradeRange: '3-6',
    dimensionNote: '家庭支持、朋友支持、其他支持（老师/亲戚/同学）三个维度',
    scoringNote: '七级计分 1–7，总分 12–84；分数越高领悟到的社会支持越多',
    reliability: 'Zimet 等 1988 编制；姜乾金等 2001 修订中文版',
    revision: '中文修订版', copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '越高越好；低分提示社会支持系统薄弱，是重要的保护性因素指标' },

  { id: 'bullydoer', code: 'BULLY-D', name: '欺凌行为筛查（施暴方）', shortName: '欺凌行为',
    itemCount: 12, responseType: 'freq4', gradeRange: '2-6',
    dimensionNote: '外显欺凌、关系欺凌、声誉欺凌三个维度',
    scoringNote: '按发生频率分层（从来没有 / 1–2 次 / 每月几次 / 每周至少一次）；任一维"每月几次"及以上需访谈确认',
    reliability: '与受害筛查配套的自陈式施暴筛查', revision: '小学版',
    copyright: 'internal', copyrightNote: '校内非商业使用；结果须访谈确认后使用',
    normNote: '⚠️ 自陈施暴行为易受社会赞许性影响，仅作干预参考，不用于处分依据' },

  { id: 'phoneuse', code: 'MPU', name: '手机与网络使用状况筛查', shortName: '网络使用',
    itemCount: 12, responseType: 'likert5', gradeRange: '3-6',
    dimensionNote: '失控性、戒断反应、功能损害三个维度',
    scoringNote: '五级计分 1–5；分数越高依赖倾向越明显，功能损害维度优先关注',
    reliability: '参考手机成瘾倾向量表（MPATS）与网络成瘾量表维度编制',
    revision: '小学生版', copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '筛查性质，不用于诊断；结果应与家长沟通后干预' },

  { id: 'sasc', code: 'SASC', name: '儿童社交焦虑量表', shortName: '社交焦虑',
    itemCount: 10, responseType: 'likert3', gradeRange: '2-6',
    dimensionNote: '害怕否定评价、社交回避与苦恼两个维度',
    scoringNote: '从不/有时/总是 = 0/1/2；总分 0–20，分数越高社交焦虑越强',
    reliability: 'La Greca 等 1988 编制；中文修订版信效度良好',
    revision: '中文修订版', copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '无统一临床界值，建议按本校百分位分档' },

  { id: 'rses', code: 'RSES', name: '自尊量表', shortName: '自尊',
    itemCount: 10, responseType: 'likert4', gradeRange: '4-6',
    dimensionNote: '单维自尊水平，含 5 道反向题',
    scoringNote: '四级计分 1–4（反向题倒转）；总分 10–40，越高自尊越高',
    reliability: 'Rosenberg 1965 编制；中文版应用广泛，α 约 0.77–0.88',
    revision: '中文版', copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '越高越好；低自尊与抑郁、社交退缩相关' },

  { id: 'gses', code: 'GSES', name: '一般自我效能感量表', shortName: '自我效能',
    itemCount: 10, responseType: 'likert4', gradeRange: '4-6',
    dimensionNote: '单维自我效能感',
    scoringNote: '四级计分 1–4；总分 10–40，越高自我效能感越强',
    reliability: 'Schwarzer 等编制；王才康等 2001 修订中文版，α 约 0.87',
    revision: '中文修订版', copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '越高越好；低分提示面对困难时信心不足' },

  { id: 'hope', code: 'CHS', name: '儿童希望量表', shortName: '希望感',
    itemCount: 6, responseType: 'likert6', gradeRange: '3-6',
    dimensionNote: '动力思维（agency）、路径思维（pathway）两个维度',
    scoringNote: '六级计分 1–6，总分 6–36；分数越高希望水平越高',
    reliability: 'Snyder 儿童希望量表（CHS）中文修订版', revision: '中文修订版',
    copyright: 'internal', copyrightNote: '校内非商业使用',
    normNote: '越高越好；低希望水平与抑郁、适应不良相关' },

];

// ==================== 量表题库播种 ====================
// 维度临界值：_default 表示该量表所有维度相同；higher_better 表示分数越高越好
const CUTS = {
  // ---- 第一批：越高越需关注 ----
  mht: { _default: { n: 6, b: 8 } },
  sdq: {
    '情绪症状': { n: 5, b: 6 },
    '品行问题': { n: 3, b: 4 },
    '多动': { n: 5, b: 6 },
    '同伴交往问题': { n: 3, b: 4 },
    '亲社会行为': { n: 5, b: 4, dir: 'higher_better' },
  },
  scared: {}, cdi: {}, lonely: {}, bully: {},
  peer: { _default: { dir: 'higher_better' } },
  aat: { _default: { dir: 'higher_better' } },

  // ---- 第二批 ----
  // CTQ：分档界值参考中文版常模（n=正常界, b=异常界）
  ctq: {
    '情感虐待': { n: 9, b: 13 },
    '躯体虐待': { n: 8, b: 10 },
    '性虐待': { n: 6, b: 8 },
    '情感忽视': { n: 10, b: 15 },
    '躯体忽视': { n: 8, b: 10 },
  },
  // 频率型：任一维"每月几次"及以上需关注
  bullydoer: { _default: { n: 2, b: 4 } },
  // 按满分比例推算的校本建议值（无公认划界，可在后台调整）
  testanxiety: { _default: { n: 14, b: 20 } },        // 单维满分 27
  aslec: { _default: { n: 8, b: 12 } },               // 五维平均单维满分 15
  scsq: { _default: { n: 12, b: 16 } },               // 积极应对满分 36 / 消极 24
  phoneuse: { _default: { n: 10, b: 13 } },           // 单维满分 20
  sasc: { _default: { n: 5, b: 7 } },                 // 单维满分 10
  dsrsc: {},                                          // 以总分为准（≥15）
  // 越高越好：低分才提示风险
  phcss: { _default: { dir: 'higher_better', n: 40, b: 30 } },
  resilience: { _default: { dir: 'higher_better', n: 15, b: 12 } },
  lifesat: { _default: { dir: 'higher_better', n: 20, b: 16 } },
  pssm: { _default: { dir: 'higher_better', n: 54, b: 42 } },
  psss: { _default: { dir: 'higher_better', n: 36, b: 24 } },
  rses: { _default: { dir: 'higher_better', n: 25, b: 20 } },
  gses: { _default: { dir: 'higher_better', n: 24, b: 20 } },
  hope: { _default: { dir: 'higher_better', n: 18, b: 14 } },
};

// 总分临界值（部分量表以总分为准）
// dir: 'higher_worse'(默认) 总分越高越需关注；'lower_worse' 总分越低越需关注
const TOTAL_CUTS = {
  mht: { n: 56, b: 65 },
  sdq: { n: 16, b: 20, dims: ['情绪症状', '品行问题', '多动', '同伴交往问题'] },
  scared: { n: null, b: 25 },
  cdi: { n: null, b: 19 },
  dsrsc: { n: null, b: 15 },
  // 越高越好型：总分低于界值才需关注
  phcss: { dir: 'lower_worse', n: 46, b: 36 },
  resilience: { dir: 'lower_worse', n: 90, b: 72 },
  lifesat: { dir: 'lower_worse', n: 100, b: 80 },
  pssm: { dir: 'lower_worse', n: 72, b: 58 },
  psss: { dir: 'lower_worse', n: 48, b: 36 },
  rses: { dir: 'lower_worse', n: 25, b: 20 },
  gses: { dir: 'lower_worse', n: 24, b: 20 },
  hope: { dir: 'lower_worse', n: 20, b: 15 },
  ctq: { n: null, b: null },       // 只看分维度，不看总分
  bullydoer: { n: null, b: null },
  aslec: { n: null, b: 27 },
};

function cutoffOf(scaleId, dimName) {
  const c = CUTS[scaleId] || {};
  return c[dimName] || c._default || {};
}

// 从题库生成扁平题目列表
function buildItems(scaleId) {
  const bank = SCALE_ITEM_BANK[scaleId] || SCALE_ITEM_BANK2[scaleId];
  if (!bank) return [];
  const out = [];
  const maxPer = bank.customOptions
    ? (bank.optionCount || 3) - 1
    : Math.max(...Object.values(bank.scoreMap || {}).map(Number));

  const push = (raw, dimName, type) => {
    let title, options, scoreMap, reverse = false;
    if (Array.isArray(raw)) {                     // CDI：每题自带三个选项
      if (raw[0].startsWith('!')) { title = raw[0].slice(1); type = 'risk'; }
      else title = raw[0];
      options = raw.map(x => x.startsWith('!') ? x.slice(1) : x);
      scoreMap = {}; options.forEach((o, i) => { scoreMap[o] = i; });
      return out.push({ title, options, scoreMap, reverse: false, dimName, type });
    }
    if (typeof raw === 'string') {
      let t = raw;
      if (t.startsWith('!')) { t = t.slice(1); type = 'risk'; }
      if (t.endsWith('*')) { t = t.slice(0, -1); reverse = true; }
      title = t;
    } else title = String(raw);
    out.push({ title, options: bank.options, scoreMap: bank.scoreMap, reverse, dimName, type });
  };

  for (const [dimName, list] of Object.entries(bank.dims || {})) {
    for (const it of list) push(it, dimName, 'normal');
  }
  (bank.validity || []).forEach(it => push(it, null, 'validity'));
  (bank.filler || []).forEach(it => push(it, null, 'filler'));
  return out.map(x => ({ ...x, maxPer }));
}

// ---------------------------------------------------------------
// 题库播种（分块 + 可恢复）
//
// 为什么必须分块：24 个量表 669 题，一次性插入需要 800+ 条 D1 语句，
// 全部塞进"一个请求"里。Cloudflare 上这个请求会被中断（超限/超时），
// 已写入的部分留下"半截状态"，而旧代码一旦发现 scales 表非空就跳过播种，
// 于是永远补不完 —— 表现就是"本地有量表，部署后没有"。
//
// 现在改成：每次请求只补有限工作量，靠多次请求推进完成，中断也能续上。
// ---------------------------------------------------------------

// 单个量表的元数据 + 维度（幂等）
async function seedOneScaleMeta(env, s) {
  const bank = SCALE_ITEM_BANK[s.id] || SCALE_ITEM_BANK2[s.id];
  const ex = await env.DB.prepare('SELECT id FROM scales WHERE id=? LIMIT 1').bind(s.id).first();
  if (ex) return false;
  await env.DB.prepare(`
    INSERT INTO scales (id, code, name, shortName, itemCount, responseType, gradeRange,
      dimensionNote, scoringNote, reliability, revision, copyright, copyrightNote,
      normNote, usable, builtin, createdAt, deleted)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,0)
  `).bind(s.id, s.code, s.name, s.shortName, s.itemCount, s.responseType, s.gradeRange,
    s.dimensionNote, s.scoringNote, s.reliability, s.revision, s.copyright,
    s.copyrightNote, s.normNote, bank ? 1 : 0, nowISO()).run();

  const dimDefs = [];
  if (bank) {
    let i = 0;
    for (const [dimName, list] of Object.entries(bank.dims || {})) {
      const c = cutoffOf(s.id, dimName);
      const maxPer = bank.customOptions ? (bank.optionCount || 3) - 1
        : Math.max(...Object.values(bank.scoreMap || {}).map(Number));
      dimDefs.push({
        id: `${s.id}_d${i}`, name: dimName, itemCount: list.length,
        direction: c.dir || 'higher_worse', maxScore: list.length * maxPer,
        cutNormal: c.n == null ? null : c.n, cutBorder: c.b == null ? null : c.b,
        note: bank.sourceNote || '',
      });
      i++;
    }
  } else {
    (s.dims || []).forEach((d, i) => dimDefs.push({
      id: `${s.id}_d${i}`, name: d.name, itemCount: d.itemCount || 0,
      direction: d.direction || 'higher_worse', maxScore: d.maxScore || 0,
      cutNormal: d.cutNormal ?? null, cutBorder: d.cutBorder ?? null, note: d.note || '',
    }));
  }
  const stmts = dimDefs.map((d, i) => env.DB.prepare(`
    INSERT INTO scale_dims (id, scaleId, dimIndex, name, itemCount, direction, maxScore, cutNormal, cutBorder, note)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).bind(d.id, s.id, i, d.name, d.itemCount, d.direction, d.maxScore,
    d.cutNormal, d.cutBorder, d.note));
  await runWrites(env, stmts);
  return true;
}

// 单个量表的题目（可断点续传）
//
// 关键：支持只写一部分。如果一个量表有 100 题而本次预算只剩 40 行，
// 就先写 40 行，下次接着写 —— 否则"永远装不下"会导致永久卡死。
//
// maxRows：本次最多写多少行（不传 = 一次写完）
async function seedItemsFor(env, scaleId, maxRows) {
  const bank = SCALE_ITEM_BANK[scaleId] || SCALE_ITEM_BANK2[scaleId];
  if (!bank) return 0;
  const ex = await env.DB.prepare('SELECT COUNT(*) AS n FROM scale_items WHERE scaleId=?').bind(scaleId).first();
  const have = ex ? ex.n : 0;
  const list = buildItems(scaleId);
  if (!list.length) return 0;
  if (have >= list.length) {
    await env.DB.prepare('UPDATE scales SET usable=1 WHERE id=?').bind(scaleId).run();
    return 0;
  }
  const dims = await env.DB.prepare('SELECT id,name FROM scale_dims WHERE scaleId=?').bind(scaleId).all();
  const byName = {};
  (dims.results || []).forEach(d => { byName[d.name] = d.id; });

  const rest = list.slice(have);
  const take = (maxRows == null) ? rest.length : Math.max(1, Math.min(rest.length, maxRows));
  const slice = rest.slice(0, take);

  const sql = `INSERT INTO scale_items (id, scaleId, dimId, itemIndex, type, title, options, reverse, scoreMap)
    VALUES (?,?,?,?,?,?,?,?,?)`;
  const stmts = slice.map((it, k) => env.DB.prepare(sql).bind(
    uid(), scaleId, it.dimName ? (byName[it.dimName] || null) : null, have + k,
    it.type, it.title, JSON.stringify(it.options || []),
    it.reverse ? 1 : 0, JSON.stringify(it.scoreMap || null)));
  await runWrites(env, stmts);

  const after = have + slice.length;
  await env.DB.prepare('UPDATE scales SET usable=? WHERE id=?').bind(after >= list.length ? 1 : 0, scaleId).run();
  console.log(`[题库] ${scaleId} 载入 ${slice.length} 题（${after}/${list.length}）`);
  return slice.length;
}

// 统一写提交：优先 D1 原生 batch（一次往返），否则分批并发
// 入参是"已 bind 的 prepared statement"（不是 promise）
async function runWrites(env, stmts) {
  if (!stmts.length) return;
  if (typeof env.DB.batch === 'function') { await env.DB.batch(stmts); return; }
  for (let k = 0; k < stmts.length; k += 50) {
    await Promise.all(stmts.slice(k, k + 50).map(s => s.run()));
  }
}

// 按需就绪：确保某个内置量表（元数据 + 题目）可用。
// 工作量有界（最多约 100 行），即使题库整体还没播完，用到的量表也能立刻可用。
async function ensureScaleReady(env, scaleId) {
  const def = BUILTIN_SCALES.find(x => x.id === scaleId);
  if (!def) return false;
  try {
    await seedOneScaleMeta(env, def);
    await seedItemsFor(env, scaleId);
    return true;
  } catch (e) {
    console.error('[题库] 就绪失败 ' + scaleId + ': ' + (e && e.message));
    return false;
  }
}

// 题库进度盘点（2 次查询）：区分"元数据都没有"和"有元数据但题目不全"
// remaining 必须是"还没完整载入的量表总数"，否则刚建完 2 个量表就误报完成。
async function seedStatus(env) {
  const all = await env.DB.prepare('SELECT id, code FROM scales WHERE builtin=1 AND deleted=0').all();
  const rows = all.results || [];
  const have = new Set(rows.map(r => r.id));
  const cnt = await countBy(env, 'scale_items', 'scaleId', BUILTIN_SCALES.map(s => s.id));
  // 必须保留完整定义对象！只留 {id, code} 会导致写入时名称/说明/临界值全为空
  const noMeta = BUILTIN_SCALES.filter(s => !have.has(s.id));
  const partial = rows.filter(r => (cnt[r.id] || 0) < (ITEM_EST[r.id] || 0))
    .map(r => ({ id: r.id, code: r.code }));
  return {
    noMeta, partial,
    remaining: noMeta.length + partial.length,
    itemLoaded: Object.values(cnt).reduce((a, b) => a + b, 0),
  };
}

// 还缺题目的量表（用于按需补题）
async function missingItemScales(env) {
  const st = await seedStatus(env);
  return st.partial;
}

// 分块播种：补齐元数据 + 最多补 limit 个量表的题目
// 返回进度，前端据此循环调用直到 done
let _metaEnsured = false;    // 元数据只需在每个 isolate 里确认一次

// 分块播种：本次请求只补有限工作量，返回进度让前端继续调用。
// itemLimit：本次最多补几个量表的题目；metaLimit：本次最多建几个量表的元数据。
// 每个量表的大致题数（用于预算控制，避免一次塞进 MHT 的 100 题就爆掉）
const ITEM_EST = Object.fromEntries(BUILTIN_SCALES.map(s => [s.id, s.itemCount || 20]));

// 分块播种：按"语句预算"控制单次请求的工作量，而不是按量表个数。
// 这一点很关键 —— MHT 一个量表就 100 题，按个数切照样会超出单次请求上限。
async function seedChunk(env, itemBudget = 40, metaBudget = 20) {
  await ensureSchema(env);
  let metaAdded = 0, metaUsed = 0;
  const missing0 = await seedStatus(env);
  // 兜底：本 isolate 以为播过了，但库里一个内置量表都没有（数据库被重置/换库），
  // 这时必须清掉标志重新播种，否则会永远跳过。
  if (_metaEnsured && missing0.noMeta.length === BUILTIN_SCALES.length) _metaEnsured = false;
  if (!_metaEnsured) {
    const todo = missing0.noMeta;
    let did = 0;
    for (const s of todo) {
      // 估算：1 次查重 + 1 次插量表 + 每个维度 1 条
      const bankE = SCALE_ITEM_BANK[s.id] || SCALE_ITEM_BANK2[s.id];
      const nDim = bankE && bankE.dims ? Object.keys(bankE.dims).length : (s.dims || []).length || 2;
      const est = 2 + Math.max(1, nDim);
      if (did > 0 && metaUsed + est > metaBudget) break;
      if (await seedOneScaleMeta(env, s)) metaAdded++;
      metaUsed += est;
      did++;
    }
    if (todo.length === did) _metaEnsured = true;
  }
  // 缺题的量表按剩余题数从小到大：先补快的，进度条动得更明显
  const missing = missing0.partial;
  missing.sort((a, b) => (ITEM_EST[a.id] || 20) - (ITEM_EST[b.id] || 20));
  const seeded = [];
  let left = itemBudget;
  for (const r of missing) {
    if (left <= 0 && seeded.length > 0) break;
    // 本次最多用掉剩余预算，但至少写 1 行（保证有进展）
    const n = await seedItemsFor(env, r.id, Math.max(1, left));
    if (n > 0) seeded.push({ code: r.code, items: n });
    left -= n;
  }
  if (metaAdded || seeded.length) invalidate();
  // 重新盘点：remaining 必须包含"元数据都没有"的那些，否则会提前报完成
  const after = await seedStatus(env);
  const remaining = after.remaining;
  return {
    done: remaining === 0 && _metaEnsured,
    remaining,
    metaDone: _metaEnsured,
    totalScales: BUILTIN_SCALES.length,
    missingCount: remaining,
    itemLoaded: after.itemLoaded,
    metaAdded,
    seeded,
    itemTotal: BUILTIN_SCALES.reduce((a, s) => a + (s.itemCount || 0), 0),
  };
}

// 兼容旧调用：一次性补齐（仅 /setup 用，可能较慢）
async function seedScales(env) {
  const out = await seedChunk(env, 999);
  return { scales: out.metaAdded, items: out.seeded.reduce((a, x) => a + x.items, 0) };
}

// ==================== 数据映射 ====================
function mapScale(r) {
  return {
    id: r.id, code: r.code, name: r.name, shortName: r.shortName,
    itemCount: r.itemCount, responseType: r.responseType, gradeRange: r.gradeRange,
    dimensionNote: r.dimensionNote, scoringNote: r.scoringNote,
    reliability: r.reliability, revision: r.revision,
    copyright: r.copyright, copyrightNote: r.copyrightNote, normNote: r.normNote,
    usable: r.usable === 1, builtin: r.builtin === 1, createdAt: r.createdAt || '',
  };
}
function mapDim(r) {
  return {
    id: r.id, scaleId: r.scaleId, dimIndex: r.dimIndex, name: r.name,
    itemCount: r.itemCount || 0, direction: r.direction || 'higher_worse',
    maxScore: r.maxScore || 0, cutNormal: r.cutNormal, cutBorder: r.cutBorder, note: r.note || '',
  };
}
function mapItem(r) {
  return {
    id: r.id, scaleId: r.scaleId, dimId: r.dimId, itemIndex: r.itemIndex,
    type: r.type || 'normal', title: r.title, options: parseJSON(r.options, []),
    reverse: r.reverse === 1, scoreMap: parseJSON(r.scoreMap, null),
  };
}
function mapPlan(r) {
  return {
    id: r.id, title: r.title, term: r.term || '',
    gradeScope: parseJSON(r.gradeScope, []), classScope: parseJSON(r.classScope, []),
    scaleIds: parseJSON(r.scaleIds, []), startAt: r.startAt || '', endAt: r.endAt || '',
    status: r.status || 'draft', anonymous: r.anonymous === 1, notice: r.notice || '',
    createdAt: r.createdAt || '', deleted: r.deleted === 1,
  };
}
function mapResponse(r) {
  return {
    id: r.id, planId: r.planId, studentKey: r.studentKey || '', name: r.name || '',
    gender: r.gender || '', grade: r.grade || '', className: r.className || '',
    answers: parseJSON(r.answers, []), startedAt: r.startedAt || '', submittedAt: r.submittedAt || '',
    durationSec: r.durationSec || 0, valid: r.valid !== 0,
    invalidReason: r.invalidReason || '', validityNote: r.validityNote || '',
    scores: parseJSON(r.scores, {}), suggested: r.suggested || '', deleted: r.deleted === 1,
  };
}
function mapScreening(r) {
  return {
    id: r.id, responseId: r.responseId, planId: r.planId, studentKey: r.studentKey || '',
    name: r.name || '', grade: r.grade || '', className: r.className || '',
    suggested: r.suggested || '', opLevel: r.opLevel || '', respLevel: r.respLevel || '',
    confirmed: r.confirmed || 'pending', confirmedBy: r.confirmedBy || '', confirmedAt: r.confirmedAt || '',
    riskFlag: r.riskFlag === 1, note: r.note || '', updatedAt: r.updatedAt || '',
  };
}
function mapInterview(r) {
  return {
    id: r.id, screeningId: r.screeningId, planId: r.planId || '', studentKey: r.studentKey || '',
    name: r.name || '', grade: r.grade || '', className: r.className || '',
    interviewedAt: r.interviewedAt || '', teacher: r.teacher || '',
    chiefComplaint: r.chiefComplaint || '', observation: r.observation || '',
    riskAssessment: r.riskAssessment || '', conclusion: r.conclusion || '',
    conclusionNote: r.conclusionNote || '', planText: r.planText || '',
    guardianNotify: r.guardianNotify === 1, createdAt: r.createdAt || '',
  };
}
function mapCase(r) {
  return {
    id: r.id, studentKey: r.studentKey, name: r.name || '', grade: r.grade || '',
    className: r.className || '', gender: r.gender || '', openedAt: r.openedAt || '',
    source: r.source || '', level: r.level || '', mainIssues: parseJSON(r.mainIssues, []),
    planText: r.planText || '', status: r.status || 'active', closedAt: r.closedAt || '',
    closeReason: r.closeReason || '', teacher: r.teacher || '', updatedAt: r.updatedAt || '',
  };
}
function mapRetest(r) {
  return {
    id: r.id, caseId: r.caseId, studentKey: r.studentKey || '', name: r.name || '',
    grade: r.grade || '', className: r.className || '', weeks: r.weeks || 6,
    dueAt: r.dueAt || '', status: r.status || 'pending', baselinePlanId: r.baselinePlanId || '',
    doneAt: r.doneAt || '', donePlanId: r.donePlanId || '', note: r.note || '', createdAt: r.createdAt || '',
  };
}
function mapReferral(r) {
  return {
    id: r.id, caseId: r.caseId, studentKey: r.studentKey || '', name: r.name || '',
    grade: r.grade || '', className: r.className || '', toOrg: r.toOrg || '', reason: r.reason || '',
    guardianConsent: r.guardianConsent === 1, referredAt: r.referredAt || '',
    feedback: r.feedback || '', feedbackAt: r.feedbackAt || '', teacher: r.teacher || '', createdAt: r.createdAt || '',
  };
}
function mapClosure(r) {
  return {
    id: r.id, caseId: r.caseId, studentKey: r.studentKey || '', name: r.name || '',
    grade: r.grade || '', className: r.className || '', reason: r.reason || '',
    reasonNote: r.reasonNote || '', summary: r.summary || '', closedAt: r.closedAt || '',
    teacher: r.teacher || '', createdAt: r.createdAt || '',
  };
}

function mapSurvey(r) {
  return {
    id: r.id, title: r.title, description: r.description || '',
    status: r.status || 'draft', anonymous: r.anonymous === 1,
    startAt: r.startAt || '', endAt: r.endAt || '', notice: r.notice || '',
    createdAt: r.createdAt || '', deleted: r.deleted === 1,
  };
}
function mapQuestion(r) {
  return {
    id: r.id, surveyId: r.surveyId, qIndex: r.qIndex, type: r.type,
    title: r.title, required: r.required !== 0,
    options: parseJSON(r.options, []), config: parseJSON(r.config, {}),
  };
}
function mapSurveyResponse(r) {
  return {
    id: r.id, surveyId: r.surveyId, studentKey: r.studentKey || '', name: r.name || '',
    grade: r.grade || '', className: r.className || '',
    answers: parseJSON(r.answers, []), startedAt: r.startedAt || '',
    submittedAt: r.submittedAt || '', durationSec: r.durationSec || 0,
  };
}

// ==================== 计分与效度校验 ====================
function scoreResponse(items, dims, answers, meta) {
  const ansMap = {};
  (answers || []).forEach(a => { if (a && a.itemId) ansMap[a.itemId] = a.value; });

  const dimScores = {};
  dims.forEach(d => { dimScores[d.id] = 0; });

  let validityFail = 0, validityTotal = 0, riskDetected = false;
  const scaleId = (items[0] && items[0].scaleId) || '';

  for (const it of items) {
    const val = ansMap[it.id];
    if (it.type === 'validity') {
      validityTotal++;
      const map = it.scoreMap || {};
      const v = Number(map[String(val)] ?? val ?? 0);
      // 效度题选到"最极端赞许"方向才算异常：兼容 binary(是=1) 与 likert(最高分) 两种计分
      const nums = Object.values(map).map(Number);
      const vmax = nums.length ? Math.max(...nums) : 1;
      if (v >= vmax) validityFail++;
      continue;
    }
    if (it.type === 'filler') continue;                 // 插入题不计分

    if (it.dimId && dimScores[it.dimId] !== undefined) {
      const map = it.scoreMap || {};
      let v = Number(map[String(val)] ?? val ?? 0);
      if (it.reverse && it.scoreMap) {
        const nums = Object.values(it.scoreMap).map(Number);
        v = Math.max(...nums) + Math.min(...nums) - v;
      }
      dimScores[it.dimId] += Number(v) || 0;
      // 风险题：选到最严重一项 → 触发危机标记
      if (it.type === 'risk' && it.scoreMap) {
        const nums = Object.values(it.scoreMap).map(Number);
        if (v === Math.max(...nums)) riskDetected = true;
      }
    }
  }

  const dimResults = dims.map(d => {
    const raw = dimScores[d.id] || 0;
    let level = 'normal';
    if (d.direction === 'higher_better') {
      if (d.cutBorder != null && raw <= d.cutBorder) level = 'abnormal';
      else if (d.cutNormal != null && raw <= d.cutNormal) level = 'border';
    } else {
      if (d.cutBorder != null && raw >= d.cutBorder) level = 'abnormal';
      else if (d.cutNormal != null && raw >= d.cutNormal) level = 'border';
    }
    return { dimId: d.id, name: d.name, raw, max: d.maxScore, level, direction: d.direction };
  });

  // 总分（部分量表以总分为准，如 SDQ 只合计困难维度）
  const tc = TOTAL_CUTS[scaleId];
  let total = null;
  if (tc) {
    const inc = tc.dims ? dimResults.filter(d => tc.dims.includes(d.name)) : dimResults;
    total = inc.reduce((a, d) => a + (d.raw || 0), 0);
  }

  // 效度判定
  let valid = true, reason = '', note = '';
  if (validityTotal > 0 && validityFail >= Math.ceil(validityTotal * 0.6)) {
    valid = false; reason = '效度题异常';
    note = `效度题 ${validityFail}/${validityTotal} 项提示社会赞许性作答`;
  }
  const dur = Number(meta && meta.durationSec) || 0;
  const scoredCount = items.filter(i => i.type !== 'filler').length || 1;
  if (valid && dur > 0 && dur < scoredCount * 2) {
    valid = false; reason = '作答过快'; note = `${scoredCount} 题仅用 ${dur} 秒，疑似随意作答`;
  }
  if (valid && detectPattern(items, answers)) {
    valid = false; reason = '规律性作答'; note = '选项高度重复，疑似未按真实情况作答';
  }

  // 建议档位
  let suggested = 'normal';
  if (valid) {
    if (dimResults.some(d => d.level === 'abnormal')) suggested = 'interview';
    else if (dimResults.some(d => d.level === 'border')) suggested = 'watch';
    if (tc && total != null) {
      if (tc.dir === 'lower_worse') {
        if (tc.n != null && total <= tc.n) suggested = 'watch';
        if (tc.b != null && total <= tc.b) suggested = 'interview';
      } else {
        if (tc.b != null && total >= tc.b) suggested = 'interview';
        else if (tc.n != null && total >= tc.n && suggested === 'normal') suggested = 'watch';
      }
    }
  } else {
    suggested = 'retest';
  }

  return { scores: dimScores, dims: dimResults, total, valid, reason, note, suggested, riskDetected };
}

function detectPattern(items, answers) {
  const skip = new Set(items.filter(i => i.type === 'validity' || i.type === 'filler').map(i => i.id));
  const customOpt = new Set(items.filter(i => i.type === 'risk').map(i => i.id));
  const vals = (answers || [])
    .filter(a => a && a.itemId && !skip.has(a.itemId) && !customOpt.has(a.itemId))
    .map(a => String(a.value));
  if (vals.length < 10) return false;
  const counter = {};
  vals.forEach(v => { counter[v] = (counter[v] || 0) + 1; });
  const top = Math.max(...Object.values(counter));
  return top / vals.length > 0.9;
}

// ==================== CSV ====================
function csvEsc(v) {
  const s = (v === null || v === undefined) ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const BOM = '\uFEFF';

// ==================== 路由 ====================
async function handle(request, env) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
  }

  // ---- 静态页面 ----
  if (method === 'GET' || method === 'HEAD') {
    const page = p === '/' || p === '/index.html' ? '/index.html'
      : (p === '/admin' || p === '/admin/') ? '/admin.html'
      : (p === '/setup' || p === '/setup.html') ? '/setup.html' : null;
    if (page) {
      const resp = await env.ASSETS.fetch(new URL(page, request.url));
      // HTML 用协商缓存：内容不变时返回 304，省掉整页传输
      return await withETag(request, resp);
    }
  }

  // ---- 健康检查 ----
  if (p === '/api/health') {
    await ensureSchema(env);
    let dbErr = '', counts = { scales: 0, plans: 0, responses: 0, cases: 0 };
    try {
      // 4 次 COUNT → 1 次 UNION ALL 查询
      const r = await env.DB.prepare(`
        SELECT 'scales' AS k, COUNT(*) AS n FROM scales WHERE deleted = 0
        UNION ALL SELECT 'plans', COUNT(*) FROM plans WHERE deleted = 0
        UNION ALL SELECT 'responses', COUNT(*) FROM responses WHERE deleted = 0
        UNION ALL SELECT 'cases', COUNT(*) FROM cases WHERE status = 'active'
      `).all();
      for (const x of (r.results || [])) counts[x.k] = x.n;
    } catch (e) { dbErr = e.message || String(e); }
    return json({ ok: !dbErr, service: 'psych-platform', dbReady: !dbErr, dbError: dbErr,
      hint: dbErr ? '访问 /setup 初始化数据库' : '', ...counts, time: nowISO() });
  }

  // ---- 分块播种（可反复调用直到 done）----
  if (p === '/api/seed' && (method === 'GET' || method === 'POST')) {
    const okAuth = url.searchParams.get('pwd') === await password(env) || await verifyToken(env, bearer(request));
    if (!okAuth) return json({ ok: false, message: '需要教师身份' }, 401);
    // limit = 本次请求的题目语句预算（不是量表个数）
    // 默认保守：一次只写 40 行 + 少量元数据。
    // 宁可多跑几轮，也不要让单个请求在 Cloudflare 上被中断。
    const lim = Number(url.searchParams.get('limit') || 100);
    const budget = Math.min(400, Math.max(10, isNaN(lim) ? 40 : lim));
    const ml = Number(url.searchParams.get('meta') || 30);
    const metaBudget = Math.min(200, Math.max(5, isNaN(ml) ? 20 : ml));
    const out = await seedChunk(env, budget, metaBudget);
    return json({ ok: true, ...out,
      message: out.done ? '题库已完整' : `已补 ${out.seeded.length} 个，还剩 ${out.remaining} 个，请继续调用` });
  }

  // ---- 初始化 / 诊断 ----
  if ((p === '/api/setup') && (method === 'GET' || method === 'POST')) {
    if (url.searchParams.get('pwd') !== await password(env)) return json({ ok: false, message: '密码错误' }, 401);
    const res = await ensureSchema(env, true);
    const seeded = await seedScales(env);
    return json({ ok: res.ok, message: res.ok ? '数据库已就绪' : '初始化失败',
      '已创建表': res.created, '索引数': res.indexes, '已载入内置量表': seeded, '错误': res.error || '' });
  }

  if (p === '/api/diag' && method === 'GET') {
    if (url.searchParams.get('pwd') !== await password(env)) return json({ ok: false, message: '密码错误' }, 401);
    const out = { ok: true, '有DB绑定': !!env.DB, '表列表': [], '错误': '' };
    try {
      const t = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      out['表列表'] = (t.results || []).map(r => r.name);
    } catch (e) { out['错误'] = e.message || String(e); }
    for (const n of Object.keys(TABLES)) out[n + '表存在'] = await tableExists(env, n);
    out['密码来源'] = await passwordSource(env);
    // 题库状态：一眼看出"量表在本地有、部署后没有"到底卡在哪
    try {
      await ensureSchema(env);
      const all = await env.DB.prepare('SELECT id, code FROM scales WHERE builtin=1 AND deleted=0').all();
      const rows = all.results || [];
      const cnt = await countBy(env, 'scale_items', 'scaleId', rows.map(r => r.id));
      out['内置量表数'] = rows.length;
      out['应有量表数'] = BUILTIN_SCALES.length;
      out['题目总数'] = Object.values(cnt).reduce((a, b) => a + b, 0);
      out['应有题目数'] = BUILTIN_SCALES.reduce((a, s) => a + (s.itemCount || 0), 0);
      out['缺题目的量表'] = rows.filter(r => !cnt[r.id]).map(r => r.code);
      out['题库完整'] = rows.length === BUILTIN_SCALES.length && out['缺题目的量表'].length === 0;
    } catch (e) { out['题库检查错误'] = e.message || String(e); }
    return json(out);
  }

  // ---- 登录（默认 30 天，支持"记住我"）----
  if (p === '/api/auth' && method === 'POST') {
    // 只建表，不播种。播种由 /api/seed 分块推进（原来这里一次写 800+ 条语句，
    // 在 Cloudflare 上会被中断，留下半截数据）
    await ensureSchema(env);
    let body = {};
    try { body = await request.json(); } catch (e) {}
    if (body.password !== await password(env)) return json({ ok: false, message: '密码错误' }, 401);
    const hours = body.remember === false ? 12 : 720;
    return json({ ok: true, token: await issueToken(env, hours), ttl: hours >= 720 ? '30天' : '12小时' });
  }

  // ---- 校验 token 是否仍有效（前端启动时静默续期判断）----
  if (p === '/api/verify' && method === 'GET') {
    const ok = await verifyToken(env, url.searchParams.get('token') || bearer(request));
    return json({ ok });
  }

  // ==================== 以下需登录 ====================
  const isAdmin = p.startsWith('/api/admin/');
  if (isAdmin) {
    let token = bearer(request);
    if (!token && url.searchParams.get('token')) token = url.searchParams.get('token');
    if (!(await verifyToken(env, token))) return json({ ok: false, message: '登录已过期，请重新登录' }, 401);
    await ensureSchema(env);
  }

  // ---------- 修改密码 ----------
  if (p === '/api/admin/password' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const { oldPassword, newPassword } = body;
    if (!oldPassword || !newPassword) return json({ ok: false, message: '请填写原密码和新密码' }, 400);
    if (oldPassword !== await password(env)) return json({ ok: false, message: '原密码不正确' }, 400);
    if (String(newPassword).length < 4) return json({ ok: false, message: '新密码至少 4 位' }, 400);
    await setSetting(env, 'teacher_password', String(newPassword));
    // 提升密码版本，使旧 token 失效
    await setSetting(env, 'pwd_version', String(Date.now()));
    _schemaReady = true;
    const t = await issueToken(env, 720);
    return json({ ok: true, message: '密码已修改，请牢记新密码', token: t });
  }

  // ---------- 量表库 ----------
  if (p === '/api/admin/scales' && method === 'GET') {
    await ensureSchema(env);
    // 自愈：题库没播完时顺带补一小批（有界，约几十条语句）。
    // 这样即使前端不主动调用 /api/seed，反复打开页面也会逐步补齐，不会卡死。
    const st0 = await seedStatus(env);
    if (st0.remaining > 0) await seedChunk(env, 30, 10);
    // 缓存：量表库几乎不变，缓存 60s。修改量表时会 invalidate('scales')
    const ck = 'scales:list';
    const hit = cacheGet(ck);
    if (hit) return json(hit, 200, { 'X-Cache': 'HIT' });

    // 3 次查询替代原来的 1+2N 次（24 个量表 = 51 次 → 3 次）
    const res = await env.DB.prepare('SELECT * FROM scales WHERE deleted = 0 ORDER BY builtin DESC, code').all();
    const rows = res.results || [];
    const list = rows.map(mapScale);
    const ids = list.map(s => s.id);

    let dimMap = {}, cntMap = {};
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      const [dres, cres] = await Promise.all([
        env.DB.prepare(`SELECT * FROM scale_dims WHERE scaleId IN (${ph}) ORDER BY dimIndex`).bind(...ids).all(),
        env.DB.prepare(`SELECT scaleId AS k, COUNT(*) AS n FROM scale_items WHERE scaleId IN (${ph}) GROUP BY scaleId`).bind(...ids).all(),
      ]);
      for (const d of (dres.results || [])) {
        (dimMap[d.scaleId] = dimMap[d.scaleId] || []).push(mapDim(d));
      }
      for (const c of (cres.results || [])) cntMap[c.k] = c.n;
    }
    const out = list.map(s => ({ ...s, dims: dimMap[s.id] || [], itemImported: cntMap[s.id] || 0 }));
    // 缺题目的内置量表数量：>0 时前端应循环调用 /api/seed 补完
    const missing = out.filter(s => s.builtin && !s.itemImported).length;
    cacheSet(ck, out, 60000);
    return json(out, 200, { 'X-Cache': 'MISS', 'X-Seed-Remaining': String(missing) });
  }

  if (p === '/api/admin/scale-items' && method === 'GET') {
    const scaleId = url.searchParams.get('scaleId');
    if (!scaleId) return json({ ok: false, message: '缺少 scaleId' }, 400);
    await ensureSchema(env);
    // 编辑器打开时按需补齐这个量表的题目（最多 100 行）
    const res0 = await env.DB.prepare('SELECT COUNT(*) AS n FROM scale_items WHERE scaleId=?').bind(scaleId).first();
    if (!res0 || !res0.n) await ensureScaleReady(env, scaleId);
    const res = await env.DB.prepare('SELECT * FROM scale_items WHERE scaleId=? ORDER BY itemIndex').bind(scaleId).all();
    return json((res.results || []).map(mapItem));
  }

  // ---------- 自建量表：创建 / 修改 / 删除 ----------
  if (p === '/api/admin/scale' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const name = String(body.name || '').trim();
    if (!name) return json({ ok: false, message: '请填写量表名称' }, 400);
    const code = String(body.code || 'CUSTOM').trim().toUpperCase();
    const id = body.id || ('custom_' + uid());
    const dup = await env.DB.prepare('SELECT id FROM scales WHERE code=? AND deleted=0').bind(code).first();
    if (dup && dup.id !== id) return json({ ok: false, message: '量表代号已被占用，换一个' }, 400);
    await env.DB.prepare(`
      INSERT INTO scales (id, code, name, shortName, itemCount, responseType, gradeRange,
        dimensionNote, scoringNote, reliability, revision, copyright, copyrightNote,
        normNote, usable, builtin, createdAt, deleted)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,0)
    `).bind(id, code, name, String(body.shortName || name).trim(),
      Number(body.itemCount) || 0, String(body.responseType || 'likert5'),
      String(body.gradeRange || ''), String(body.dimensionNote || ''),
      String(body.scoringNote || ''), String(body.reliability || '自编量表'),
      String(body.revision || '校本自编'), 'internal',
      '校内自编量表，可自由使用', String(body.normNote || '建议按本校数据建立常模'),
      0, nowISO()).run();
    // 初始维度
    const dims = Array.isArray(body.dims) ? body.dims : [{ name: '总分', itemCount: 0 }];
    for (let i = 0; i < dims.length; i++) {
      const d = dims[i];
      await env.DB.prepare(`
        INSERT INTO scale_dims (id, scaleId, dimIndex, name, itemCount, direction, maxScore, cutNormal, cutBorder, note)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).bind(`${id}_d${i}`, id, i, String(d.name || ('维度' + (i + 1))),
        Number(d.itemCount) || 0, d.direction || 'higher_worse', Number(d.maxScore) || 0,
        d.cutNormal == null ? null : Number(d.cutNormal),
        d.cutBorder == null ? null : Number(d.cutBorder), String(d.note || '')).run();
    }
    invalidate();     // 量表库缓存立即失效，避免新建后列表看不到
    return json({ ok: true, id, message: '量表已创建，请添加题目' });
  }

  // 完整保存：元信息 + 维度 + 题目（自建与内置量表均可编辑）
  if (p === '/api/admin/scale' && method === 'PUT') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const id = body.id;
    if (!id) return json({ ok: false, message: '缺少 id' }, 400);
    const row = await env.DB.prepare('SELECT * FROM scales WHERE id=?').bind(id).first();
    if (!row) return json({ ok: false, message: '量表不存在' }, 404);

    await env.DB.prepare(`
      UPDATE scales SET name=?, shortName=?, code=?, responseType=?, gradeRange=?,
        dimensionNote=?, scoringNote=?, normNote=?, revision=?, itemCount=? WHERE id=?
    `).bind(String(body.name || row.name), String(body.shortName || row.shortName),
      String(body.code || row.code).toUpperCase(), String(body.responseType || row.responseType),
      String(body.gradeRange || ''), String(body.dimensionNote || ''),
      String(body.scoringNote || ''), String(body.normNote || ''),
      String(body.revision || row.revision), Number(body.itemCount) || 0, id).run();

    // 维度
    let nd = 0;
    if (Array.isArray(body.dims)) {
      await env.DB.prepare('DELETE FROM scale_dims WHERE scaleId=?').bind(id).run();
      const dimIds = [];
      for (let i = 0; i < body.dims.length; i++) {
        const d = body.dims[i];
        if (!String(d.name || '').trim()) continue;
        const did = d.id || `${id}_d${i}`;
        await env.DB.prepare(`
          INSERT INTO scale_dims (id, scaleId, dimIndex, name, itemCount, direction, maxScore, cutNormal, cutBorder, note)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `).bind(did, id, i, String(d.name), Number(d.itemCount) || 0,
          d.direction || 'higher_worse', Number(d.maxScore) || 0,
          d.cutNormal == null || d.cutNormal === '' ? null : Number(d.cutNormal),
          d.cutBorder == null || d.cutBorder === '' ? null : Number(d.cutBorder),
          String(d.note || '')).run();
        dimIds.push({ key: d.key || d.id, real: did, name: String(d.name) });
        nd++;
      }
      // 题目（若一并提交）
      if (Array.isArray(body.items)) {
        let itemCount = 0;
        const pending = [];
        await env.DB.prepare('DELETE FROM scale_items WHERE scaleId=?').bind(id).run();
        for (let i = 0; i < body.items.length; i++) {
          const it = body.items[i];
          if (!String(it.title || '').trim()) continue;
          let dimId = null;
          const m = dimIds.find(x => x.key && x.key === it.dimId);
          if (m) dimId = m.real;
          else {
            const byName = dimIds.find(x => x.name === it.dimName);
            if (byName) dimId = byName.real;
            else if (it.dimId) dimId = it.dimId;
          }
          // 选项与分值：默认按行序 0,1,2...，支持自定义分值串
          let opts = Array.isArray(it.options) ? it.options.map(String) : [];
          if (!opts.length && it.optionText) {
            opts = String(it.optionText).split('\n').map(x => x.trim()).filter(Boolean);
          }
          let sm = it.scoreMap && typeof it.scoreMap === 'object' ? it.scoreMap : null;
          if (!sm && it.scoreText) {
            const arr = String(it.scoreText).split(',').map(x => Number(String(x).trim()));
            if (arr.length === opts.length && arr.every(x => !isNaN(x))) {
              sm = {}; opts.forEach((o, k) => { sm[o] = arr[k]; });
            }
          }
          if (!sm) { sm = {}; opts.forEach((o, k) => { sm[o] = k; }); }
          pending.push(env.DB.prepare(`
            INSERT INTO scale_items (id, scaleId, dimId, itemIndex, type, title, options, reverse, scoreMap)
            VALUES (?,?,?,?,?,?,?,?,?)
          `).bind(it.id || uid(), id, dimId, i, it.type || 'normal',
            String(it.title), JSON.stringify(opts),
            it.reverse ? 1 : 0, JSON.stringify(sm)).run());
          itemCount++;
        }
        await flushAll(pending);
        const [u1, u2] = [
          env.DB.prepare('UPDATE scales SET itemCount=? WHERE id=?').bind(itemCount, id).run(),
          env.DB.prepare('UPDATE scales SET usable=? WHERE id=?').bind(itemCount > 0 ? 1 : 0, id).run(),
        ];
        await Promise.all([u1, u2]);
        invalidate();
        return json({ ok: true, dims: nd, items: itemCount,
          message: `已保存：${nd} 个维度、${itemCount} 道题` });
      }
      // 只改维度：按维度名重新挂接原有题目
      const oldItems = await env.DB.prepare('SELECT * FROM scale_items WHERE scaleId=? ORDER BY itemIndex').bind(id).all();
      for (const oi of (oldItems.results || [])) {
        const byName = dimIds.find(x => x.name === oi.dimId) ? null : null;
        let nid = oi.dimId;
        if (oi.dimId && !dimIds.find(x => x.real === oi.dimId)) {
          const nm = (await env.DB.prepare('SELECT name FROM scale_dims WHERE id=?').bind(oi.dimId).first());
          if (nm) { const t = dimIds.find(x => x.name === nm.name); nid = t ? t.real : null; }
        }
        await env.DB.prepare('UPDATE scale_items SET dimId=? WHERE id=?').bind(nid, oi.id).run();
      }
    }
    invalidate();
    return json({ ok: true, dims: nd, message: `已保存 ${nd} 个维度` });
  }

  if (p === '/api/admin/scale' && method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return json({ ok: false, message: '缺少 id' }, 400);
    const r0 = await env.DB.prepare('SELECT builtin FROM scales WHERE id=?').bind(id).first();
    if (r0 && r0.builtin === 1) return json({ ok: false, message: '内置量表不支持删除，可修改内容' }, 400);
    await env.DB.prepare('DELETE FROM scale_items WHERE scaleId=?').bind(id).run();
    await env.DB.prepare('DELETE FROM scale_dims WHERE scaleId=?').bind(id).run();
    await env.DB.prepare('DELETE FROM scales WHERE id=?').bind(id).run();
    invalidate();
    return json({ ok: true, message: '量表已删除' });
  }

  // 导入题目（学校取得授权后自行导入）
  if (p === '/api/admin/scale-items' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const { scaleId, items } = body;
    if (!scaleId || !Array.isArray(items)) return json({ ok: false, message: '缺少参数' }, 400);
    // 维度名 → dimId 映射（导入时可用维度名代替 id）
    const dimRows = await env.DB.prepare('SELECT * FROM scale_dims WHERE scaleId=? ORDER BY dimIndex').bind(scaleId).all();
    const dims = (dimRows.results || []).map(mapDim);
    const dimByName = {};
    dims.forEach(d => { dimByName[d.name] = d.id; });

    await env.DB.prepare('DELETE FROM scale_items WHERE scaleId=?').bind(scaleId).run();
    let n = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!String(it.title || '').trim()) continue;
      let dimId = it.dimId || null;
      if (!dimId && it.dimName && dimByName[it.dimName]) dimId = dimByName[it.dimName];
      await env.DB.prepare(`
        INSERT INTO scale_items (id, scaleId, dimId, itemIndex, type, title, options, reverse, scoreMap)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).bind(it.id || uid(), scaleId, dimId, i, it.type || 'normal',
        String(it.title), JSON.stringify(it.options || []),
        it.reverse ? 1 : 0, JSON.stringify(it.scoreMap || null)).run();
      n++;
    }
    await env.DB.prepare('UPDATE scales SET usable=1 WHERE id=?').bind(scaleId).run();
    invalidate();
    return json({ ok: true, imported: n, message: `已导入 ${n} 道题` });
  }

  // 自定义维度
  if (p === '/api/admin/scale-dims' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const { scaleId, dims } = body;
    if (!scaleId || !Array.isArray(dims)) return json({ ok: false, message: '缺少参数' }, 400);
    await env.DB.prepare('DELETE FROM scale_dims WHERE scaleId=?').bind(scaleId).run();
    let i = 0;
    for (const d of dims) {
      if (!String(d.name || '').trim()) continue;
      await env.DB.prepare(`
        INSERT INTO scale_dims (id, scaleId, dimIndex, name, itemCount, direction, maxScore, cutNormal, cutBorder, note)
        VALUES (?,?,?,?,?,?,?,?,?,?)
      `).bind(d.id || `${scaleId}_c${i}`, scaleId, i, String(d.name), Number(d.itemCount) || 0,
        d.direction || 'higher_worse', Number(d.maxScore) || 0,
        d.cutNormal == null ? null : Number(d.cutNormal),
        d.cutBorder == null ? null : Number(d.cutBorder), String(d.note || '')).run();
      i++;
    }
    invalidate();
    return json({ ok: true, saved: i, message: `已保存 ${i} 个维度` });
  }

  // ---------- 普查计划 ----------
  if (p === '/api/admin/plans' && method === 'GET') {
    const res = await env.DB.prepare('SELECT * FROM plans WHERE deleted = 0 ORDER BY createdAt DESC').all();
    const rows = res.results || [];
    // 批量统计答卷数（原来每个普查一次查询）
    const cnt = await countBy(env, 'responses', 'planId', rows.map(r => r.id));
    const list = rows.map(r => ({ ...mapPlan(r), responseCount: cnt[r.id] || 0 }));
    return json(list);
  }

  if (p === '/api/admin/plan' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const title = String(body.title || '').trim();
    if (!title) return json({ ok: false, message: '请填写普查名称' }, 400);
    const id = body.id || uid();
    await env.DB.prepare(`
      INSERT INTO plans (id, title, term, gradeScope, classScope, scaleIds, startAt, endAt,
        status, anonymous, notice, createdAt, deleted)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)
    `).bind(id, title, String(body.term || ''), JSON.stringify(body.gradeScope || []),
      JSON.stringify(body.classScope || []), JSON.stringify(body.scaleIds || []),
      String(body.startAt || ''), String(body.endAt || ''), body.status || 'draft',
      body.anonymous ? 1 : 0, String(body.notice || ''), nowISO()).run();
    return json({ ok: true, id, message: '普查计划已创建' });
  }

  if (p === '/api/admin/plan' && method === 'PUT') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const id = body.id;
    if (!id) return json({ ok: false, message: '缺少 id' }, 400);
    await env.DB.prepare(`
      UPDATE plans SET title=?, term=?, gradeScope=?, classScope=?, scaleIds=?,
        startAt=?, endAt=?, status=?, anonymous=?, notice=? WHERE id=?
    `).bind(String(body.title || ''), String(body.term || ''), JSON.stringify(body.gradeScope || []),
      JSON.stringify(body.classScope || []), JSON.stringify(body.scaleIds || []),
      String(body.startAt || ''), String(body.endAt || ''), String(body.status || 'draft'),
      body.anonymous ? 1 : 0, String(body.notice || ''), id).run();
    invalidate();     // 改了标题/时间窗口/量表，学生端必须立刻看到
    return json({ ok: true, message: '已保存' });
  }

  if (p === '/api/admin/plan' && method === 'DELETE') {
    const id = url.searchParams.get('id') || (await request.json().catch(() => ({}))).id;
    if (!id) return json({ ok: false, message: '缺少 id' }, 400);
    await env.DB.prepare('UPDATE plans SET deleted=1 WHERE id=?').bind(id).run();
    return json({ ok: true, message: '已删除普查计划' });
  }

  // ---------- 学生端：可作答的普查 ----------
  if (p === '/api/plans/open' && method === 'GET') {
    await ensureSchema(env);
    const now = nowISO();
    const res = await env.DB.prepare(
      "SELECT * FROM plans WHERE deleted=0 AND status='open' ORDER BY createdAt DESC"
    ).all();
    const rows = res.results || [];
    const cnt = await countBy(env, 'responses', 'planId', rows.map(r => r.id));
    const list = rows.map(r => {
      const pl = mapPlan(r);
      // 限时窗口判定
      let windowOpen = true, windowNote = '';
      if (pl.startAt && now < pl.startAt) { windowOpen = false; windowNote = '尚未开始'; }
      if (pl.endAt && now > pl.endAt) { windowOpen = false; windowNote = '已截止'; }
      return { ...pl, windowOpen, windowNote, responseCount: cnt[r.id] || 0 };
    });
    return json(list);
  }

  // 学生获取普查题目
  if (p === '/api/plan/detail' && method === 'GET') {
    await ensureSchema(env);
    const id = url.searchParams.get('id');
    if (!id) return json({ ok: false, message: '缺少 id' }, 400);
    const r = await env.DB.prepare('SELECT * FROM plans WHERE id=? AND deleted=0').bind(id).first();
    if (!r) return json({ ok: false, message: '普查不存在' }, 404);
    const pl = mapPlan(r);
    const now = nowISO();
    if (pl.status !== 'open') return json({ ok: false, message: '该普查未开放' }, 403);
    if (pl.startAt && now < pl.startAt) return json({ ok: false, message: '作答尚未开始', startAt: pl.startAt }, 403);
    if (pl.endAt && now > pl.endAt) return json({ ok: false, message: '作答已截止，请联系心理老师', endAt: pl.endAt }, 403);

    const ck = 'pdetail:' + id;
    const hit = cacheGet(ck);
    if (hit) return json(hit, 200, { 'X-Cache': 'HIT' });

    // 汇总所有量表的题目（内置量表按需补齐，保证学生一定能拿到题）
    const allItems = [];
    const scaleNames = [];
    for (const sid of (pl.scaleIds || [])) {
      if (BUILTIN_SCALES.some(x => x.id === sid)) await ensureScaleReady(env, sid);
      const sr = await env.DB.prepare('SELECT * FROM scales WHERE id=? AND deleted=0').bind(sid).first();
      if (sr) scaleNames.push({ id: sid, name: sr.name, shortName: sr.shortName, note: sr.scoringNote });
      const its = await env.DB.prepare('SELECT * FROM scale_items WHERE scaleId=? ORDER BY itemIndex').bind(sid).all();
      (its.results || []).forEach(it => allItems.push(mapItem(it)));
    }
    const body = { ...pl, scales: scaleNames, items: allItems };
    // 缓存：一个班的学生拉的是同一份题目，缓存后只查一次
    cacheSet('pdetail:' + id, body, 60000);
    return json(body, 200, { 'X-Cache': 'MISS' });
  }

  // ---------- 学生提交（含计分与效度）----------
  if (p === '/api/submit' && method === 'POST') {
    await ensureSchema(env);
    let payload;
    try { payload = await request.json(); } catch (e) { return json({ ok: false, message: '数据格式错误' }, 400); }
    const planId = payload.planId;
    if (!planId) return json({ ok: false, message: '缺少普查 id' }, 400);

    const pr = await env.DB.prepare('SELECT * FROM plans WHERE id=? AND deleted=0').bind(planId).first();
    if (!pr) return json({ ok: false, message: '普查不存在' }, 404);
    const pl = mapPlan(pr);
    const now = nowISO();
    if (pl.status !== 'open') return json({ ok: false, message: '该普查已关闭' }, 403);
    if (pl.startAt && now < pl.startAt) return json({ ok: false, message: '作答尚未开始' }, 403);
    if (pl.endAt && now > pl.endAt) return json({ ok: false, message: '作答已截止' }, 403);

    // 收集题目与维度
    const allItems = [], allDims = [];
    for (const sid of (pl.scaleIds || [])) {
      const its = await env.DB.prepare('SELECT * FROM scale_items WHERE scaleId=? ORDER BY itemIndex').bind(sid).all();
      (its.results || []).forEach(it => allItems.push(mapItem(it)));
      const ds = await env.DB.prepare('SELECT * FROM scale_dims WHERE scaleId=? ORDER BY dimIndex').bind(sid).all();
      (ds.results || []).forEach(d => allDims.push(mapDim(d)));
    }

    // 必填校验
    const ansMap = {};
    (payload.answers || []).forEach(a => { if (a && a.itemId) ansMap[a.itemId] = a.value; });
    for (const it of allItems) {
      const v = ansMap[it.id];
      if (v === undefined || v === null || v === '') {
        return json({ ok: false, message: '还有题目未作答，请检查后提交' }, 400);
      }
    }

    const meta = { durationSec: Number(payload.durationSec) || 0 };
    const sc = scoreResponse(allItems, allDims, payload.answers, meta);

    const name = pl.anonymous ? '' : String(payload.name || '').trim();
    const grade = pl.anonymous ? '' : String(payload.grade || '').trim();
    const className = pl.anonymous ? '' : String(payload.className || '').trim();
    const gender = pl.anonymous ? '' : String(payload.gender || '').trim();
    if (!pl.anonymous && !name) return json({ ok: false, message: '请填写姓名' }, 400);

    const studentKey = pl.anonymous ? ('anon_' + uid()) : `${grade}|${className}|${name}`;
    const id = uid();
    const startedAt = payload.startedAt || now;

    await env.DB.prepare(`
      INSERT INTO responses (id, planId, studentKey, name, gender, grade, className, answers,
        startedAt, submittedAt, durationSec, valid, invalidReason, validityNote, scores, suggested, deleted)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
    `).bind(id, planId, studentKey, name, gender, grade, className,
      JSON.stringify(payload.answers || []), startedAt, now, meta.durationSec,
      sc.valid ? 1 : 0, sc.reason, sc.note, JSON.stringify(sc.dims), sc.suggested).run();

    // 生成筛查记录（风险题命中自动打危机标记）
    const sid = uid();
    await env.DB.prepare(`
      INSERT INTO screenings (id, responseId, planId, studentKey, name, grade, className,
        suggested, opLevel, confirmed, riskFlag, note, updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,'pending',?,'',?)
    `).bind(sid, id, planId, studentKey, name, grade, className,
      sc.suggested, sc.suggested, sc.riskDetected ? 1 : 0, now).run();
    if (sc.riskDetected) console.log(`[危机预警] ${grade}${className} ${name || '匿名'} 风险题作答严重，请优先访谈`);

    console.log(`[提交] 普查「${pl.title}」 ${grade}${className} ${name || '匿名'} → ${sc.suggested}${sc.valid ? '' : '（无效:' + sc.reason + '）'}`);
    return json({ ok: true, id, suggested: sc.suggested, valid: sc.valid,
      invalidReason: sc.reason, thanksText: '谢谢你认真作答！你的答案只有心理老师可以看到。' });
  }

  // ---------- 筛查名单 ----------
  if (p === '/api/admin/screenings' && method === 'GET') {
    const planId = url.searchParams.get('planId');
    const level = url.searchParams.get('level');   // normal / watch / interview / retest / all
    let res;
    if (planId) {
      res = await env.DB.prepare('SELECT * FROM screenings WHERE planId=? ORDER BY suggested DESC, className').bind(planId).all();
    } else {
      res = await env.DB.prepare('SELECT * FROM screenings ORDER BY suggested DESC, className').all();
    }
    let list = (res.results || []).map(mapScreening);
    if (level && level !== 'all') list = list.filter(s => s.suggested === level);
    return json(list);
  }

  // 更新筛查分级（操作分级 / 响应分级）
  if (p === '/api/admin/screening' && method === 'PUT') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const { id, opLevel, respLevel, riskFlag, note } = body;
    if (!id) return json({ ok: false, message: '缺少 id' }, 400);
    await env.DB.prepare(
      'UPDATE screenings SET opLevel=?, respLevel=?, riskFlag=?, note=?, updatedAt=? WHERE id=?'
    ).bind(opLevel || null, respLevel || null, riskFlag ? 1 : 0, String(note || ''), nowISO(), id).run();
    return json({ ok: true, message: '已更新分级' });
  }

  // ---------- 访谈记录 ----------
  if (p === '/api/admin/interviews' && method === 'GET') {
    const screeningId = url.searchParams.get('screeningId');
    let res;
    if (screeningId) {
      res = await env.DB.prepare('SELECT * FROM interviews WHERE screeningId=? ORDER BY createdAt DESC').bind(screeningId).all();
    } else {
      res = await env.DB.prepare('SELECT * FROM interviews ORDER BY createdAt DESC').all();
    }
    return json((res.results || []).map(mapInterview));
  }

  if (p === '/api/admin/interview' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    if (!body.screeningId) return json({ ok: false, message: '缺少 screeningId' }, 400);
    const id = uid();
    await env.DB.prepare(`
      INSERT INTO interviews (id, screeningId, planId, studentKey, name, grade, className,
        interviewedAt, teacher, chiefComplaint, observation, riskAssessment, conclusion,
        conclusionNote, planText, guardianNotify, createdAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(id, body.screeningId, body.planId || '', body.studentKey || '', body.name || '',
      body.grade || '', body.className || '', body.interviewedAt || nowISO().slice(0, 10),
      String(body.teacher || ''), String(body.chiefComplaint || ''), String(body.observation || ''),
      String(body.riskAssessment || ''), String(body.conclusion || ''), String(body.conclusionNote || ''),
      String(body.planText || ''), body.guardianNotify ? 1 : 0, nowISO()).run();

    // 回填筛查结论
    await env.DB.prepare(
      'UPDATE screenings SET confirmed=?, confirmedBy=?, confirmedAt=?, updatedAt=? WHERE id=?'
    ).bind(String(body.conclusion || ''), String(body.teacher || ''), nowISO(), nowISO(), body.screeningId).run();

    // 确认阳性 → 自动建档
    let caseId = null;
    if (body.conclusion === 'confirmed' && body.studentKey) {
      caseId = uid();
      await env.DB.prepare(`
        INSERT INTO cases (id, studentKey, name, grade, className, gender, openedAt, source,
          level, mainIssues, planText, status, teacher, updatedAt)
        VALUES (?,?,?,?,?,?,?,'普查筛查',?,?,?,'active',?,?)
      `).bind(caseId, body.studentKey, body.name || '', body.grade || '', body.className || '',
        body.gender || '', nowISO(), String(body.respLevel || 'focus'),
        JSON.stringify(body.mainIssues || []), String(body.planText || ''),
        String(body.teacher || ''), nowISO()).run();

      // 自动生成复测提醒（默认 6 周）
      const weeks = Number(body.retestWeeks) || 6;
      const due = new Date(Date.now() + weeks * 7 * 86400000).toISOString().slice(0, 10);
      await env.DB.prepare(`
        INSERT INTO retests (id, caseId, studentKey, name, grade, className, weeks, dueAt,
          status, baselinePlanId, note, createdAt)
        VALUES (?,?,?,?,?,?,?,?,'pending',?,'',?)
      `).bind(uid(), caseId, body.studentKey, body.name || '', body.grade || '',
        body.className || '', weeks, due, body.planId || '', nowISO()).run();
    }
    return json({ ok: true, id, caseId, message: caseId ? '访谈已记录，并已自动建档+创建复测提醒' : '访谈已记录' });
  }

  // ---------- 个案档案 ----------
  if (p === '/api/admin/cases' && method === 'GET') {
    const status = url.searchParams.get('status');
    let res;
    if (status) res = await env.DB.prepare('SELECT * FROM cases WHERE status=? ORDER BY updatedAt DESC').bind(status).all();
    else res = await env.DB.prepare('SELECT * FROM cases ORDER BY updatedAt DESC').all();
    const rows = res.results || [];
    const cnt = await countBy(env, 'interventions', 'caseId', rows.map(r => r.id));
    const list = rows.map(r => ({ ...mapCase(r), interventionCount: cnt[r.id] || 0 }));
    return json(list);
  }

  if (p === '/api/admin/case' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    if (!body.studentKey) return json({ ok: false, message: '缺少学生标识' }, 400);
    const id = uid();
    await env.DB.prepare(`
      INSERT INTO cases (id, studentKey, name, grade, className, gender, openedAt, source,
        level, mainIssues, planText, status, teacher, updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?)
    `).bind(id, body.studentKey, body.name || '', body.grade || '', body.className || '',
      body.gender || '', nowISO(), String(body.source || '教师转介'), String(body.level || 'focus'),
      JSON.stringify(body.mainIssues || []), String(body.planText || ''),
      String(body.teacher || ''), nowISO()).run();
    return json({ ok: true, id, message: '档案已建立' });
  }

  if (p === '/api/admin/case' && method === 'PUT') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    if (!body.id) return json({ ok: false, message: '缺少 id' }, 400);
    await env.DB.prepare(
      'UPDATE cases SET level=?, mainIssues=?, planText=?, teacher=?, updatedAt=? WHERE id=?'
    ).bind(String(body.level || ''), JSON.stringify(body.mainIssues || []),
      String(body.planText || ''), String(body.teacher || ''), nowISO(), body.id).run();
    return json({ ok: true, message: '已更新档案' });
  }

  // ---------- 干预记录 ----------
  if (p === '/api/admin/interventions' && method === 'GET') {
    const caseId = url.searchParams.get('caseId');
    if (!caseId) return json({ ok: false, message: '缺少 caseId' }, 400);
    const res = await env.DB.prepare('SELECT * FROM interventions WHERE caseId=? ORDER BY date DESC').bind(caseId).all();
    return json((res.results || []).map(r => ({
      id: r.id, caseId: r.caseId, date: r.date || '', type: r.type || '',
      content: r.content || '', effect: r.effect || '', teacher: r.teacher || '', createdAt: r.createdAt || '',
    })));
  }

  if (p === '/api/admin/intervention' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    if (!body.caseId) return json({ ok: false, message: '缺少 caseId' }, 400);
    const id = uid();
    await env.DB.prepare(`
      INSERT INTO interventions (id, caseId, date, type, content, effect, teacher, createdAt)
      VALUES (?,?,?,?,?,?,?,?)
    `).bind(id, body.caseId, body.date || nowISO().slice(0, 10), String(body.type || ''),
      String(body.content || ''), String(body.effect || ''), String(body.teacher || ''), nowISO()).run();
    await env.DB.prepare('UPDATE cases SET updatedAt=? WHERE id=?').bind(nowISO(), body.caseId).run();
    return json({ ok: true, id, message: '干预记录已保存' });
  }

  // ---------- 复测提醒 ----------
  if (p === '/api/admin/retests' && method === 'GET') {
    const today = nowISO().slice(0, 10);
    const res = await env.DB.prepare('SELECT * FROM retests ORDER BY dueAt').all();
    const list = (res.results || []).map(mapRetest).map(r => {
      if (r.status === 'pending' && r.dueAt && r.dueAt < today) return { ...r, status: 'overdue', overdue: true };
      return r;
    });
    return json(list);
  }

  if (p === '/api/admin/retest' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    if (!body.caseId) return json({ ok: false, message: '缺少 caseId' }, 400);
    const weeks = Number(body.weeks) || 6;
    const due = body.dueAt || new Date(Date.now() + weeks * 7 * 86400000).toISOString().slice(0, 10);
    const id = uid();
    await env.DB.prepare(`
      INSERT INTO retests (id, caseId, studentKey, name, grade, className, weeks, dueAt,
        status, baselinePlanId, note, createdAt)
      VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)
    `).bind(id, body.caseId, body.studentKey || '', body.name || '', body.grade || '',
      body.className || '', weeks, due, body.baselinePlanId || '', String(body.note || ''), nowISO()).run();
    return json({ ok: true, id, dueAt: due, message: `已创建复测提醒（${weeks} 周后，${due}）` });
  }

  if (p === '/api/admin/retest' && method === 'PUT') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    if (!body.id) return json({ ok: false, message: '缺少 id' }, 400);
    await env.DB.prepare(
      'UPDATE retests SET status=?, doneAt=?, donePlanId=?, note=? WHERE id=?'
    ).bind(String(body.status || 'done'), body.status === 'done' ? nowISO() : '',
      body.donePlanId || '', String(body.note || ''), body.id).run();
    return json({ ok: true, message: '已更新复测状态' });
  }

  // 前后测对比
  if (p === '/api/admin/compare' && method === 'GET') {
    const studentKey = url.searchParams.get('studentKey');
    if (!studentKey) return json({ ok: false, message: '缺少 studentKey' }, 400);
    const res = await env.DB.prepare(
      'SELECT * FROM responses WHERE studentKey=? AND deleted=0 ORDER BY submittedAt'
    ).bind(studentKey).all();
    const list = (res.results || []).map(mapResponse);
    // 构造曲线：按时间排列每次的各维度分
    const series = list.map(r => ({
      date: String(r.submittedAt || '').slice(0, 10),
      planId: r.planId,
      dims: r.scores,
      valid: r.valid,
    }));
    return json({ ok: true, studentKey, count: list.length, series });
  }

  // ---------- 转介 ----------
  if (p === '/api/admin/referrals' && method === 'GET') {
    const res = await env.DB.prepare('SELECT * FROM referrals ORDER BY createdAt DESC').all();
    return json((res.results || []).map(mapReferral));
  }

  if (p === '/api/admin/referral' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    if (!body.caseId) return json({ ok: false, message: '缺少 caseId' }, 400);
    const id = uid();
    await env.DB.prepare(`
      INSERT INTO referrals (id, caseId, studentKey, name, grade, className, toOrg, reason,
        guardianConsent, referredAt, feedback, feedbackAt, teacher, createdAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(id, body.caseId, body.studentKey || '', body.name || '', body.grade || '',
      body.className || '', String(body.toOrg || ''), String(body.reason || ''),
      body.guardianConsent ? 1 : 0, body.referredAt || nowISO().slice(0, 10),
      String(body.feedback || ''), body.feedbackAt || '', String(body.teacher || ''), nowISO()).run();
    await env.DB.prepare("UPDATE cases SET status='referred', updatedAt=? WHERE id=?").bind(nowISO(), body.caseId).run();
    return json({ ok: true, id, message: '转介已记录，个案标记为已转介' });
  }

  if (p === '/api/admin/referral' && method === 'PUT') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    if (!body.id) return json({ ok: false, message: '缺少 id' }, 400);
    await env.DB.prepare(
      'UPDATE referrals SET feedback=?, feedbackAt=?, guardianConsent=? WHERE id=?'
    ).bind(String(body.feedback || ''), body.feedback ? nowISO().slice(0, 10) : '',
      body.guardianConsent ? 1 : 0, body.id).run();
    return json({ ok: true, message: '转介反馈已保存' });
  }

  // ---------- 结案 ----------
  if (p === '/api/admin/closure' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    if (!body.caseId) return json({ ok: false, message: '缺少 caseId' }, 400);
    const id = uid();
    const closedAt = body.closedAt || nowISO().slice(0, 10);
    await env.DB.prepare(`
      INSERT INTO closures (id, caseId, studentKey, name, grade, className, reason, reasonNote,
        summary, closedAt, teacher, createdAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(id, body.caseId, body.studentKey || '', body.name || '', body.grade || '',
      body.className || '', String(body.reason || ''), String(body.reasonNote || ''),
      String(body.summary || ''), closedAt, String(body.teacher || ''), nowISO()).run();
    await env.DB.prepare(
      "UPDATE cases SET status='closed', closedAt=?, closeReason=?, updatedAt=? WHERE id=?"
    ).bind(closedAt, String(body.reason || ''), nowISO(), body.caseId).run();
    return json({ ok: true, id, message: '已结案' });
  }

  if (p === '/api/admin/closures' && method === 'GET') {
    const res = await env.DB.prepare('SELECT * FROM closures ORDER BY closedAt DESC').all();
    return json((res.results || []).map(mapClosure));
  }

  // ---------- 个体报告 ----------
  if (p === '/api/admin/report/student' && method === 'GET') {
    const studentKey = url.searchParams.get('studentKey');
    if (!studentKey) return json({ ok: false, message: '缺少 studentKey' }, 400);
    const rs = await env.DB.prepare(
      'SELECT * FROM responses WHERE studentKey=? AND deleted=0 ORDER BY submittedAt DESC'
    ).bind(studentKey).all();
    const responses = (rs.results || []).map(mapResponse);
    if (!responses.length) return json({ ok: false, message: '暂无该学生的作答记录' }, 404);
    const latest = responses[0];

    // 访谈
    const sc = await env.DB.prepare(
      'SELECT * FROM screenings WHERE studentKey=? ORDER BY updatedAt DESC'
    ).bind(studentKey).all();
    const screenings = (sc.results || []).map(mapScreening);
    const iv = await env.DB.prepare(
      'SELECT * FROM interviews WHERE studentKey=? ORDER BY createdAt DESC'
    ).bind(studentKey).all();
    const interviews = (iv.results || []).map(mapInterview);

    // 个案
    const cs = await env.DB.prepare('SELECT * FROM cases WHERE studentKey=? ORDER BY openedAt DESC').bind(studentKey).first();
    let caseInfo = cs ? mapCase(cs) : null;
    let interventions = [];
    if (caseInfo) {
      const i2 = await env.DB.prepare('SELECT * FROM interventions WHERE caseId=? ORDER BY date DESC').bind(caseInfo.id).all();
      interventions = (i2.results || []).map(r => ({ date: r.date, type: r.type, content: r.content, effect: r.effect }));
    }

    return json({
      ok: true, studentKey, name: latest.name, grade: latest.grade, className: latest.className,
      latest: { submittedAt: latest.submittedAt, dims: latest.scores, valid: latest.valid,
        invalidReason: latest.invalidReason, suggested: latest.suggested },
      history: responses.slice(1).map(r => ({ date: String(r.submittedAt).slice(0, 10), dims: r.scores })),
      screenings, interviews, caseInfo, interventions,
    });
  }

  // ---------- 团体报告 ----------
  if (p === '/api/admin/report/group' && method === 'GET') {
    const planId = url.searchParams.get('planId');
    if (!planId) return json({ ok: false, message: '缺少 planId' }, 400);
    const rs = await env.DB.prepare(
      'SELECT * FROM responses WHERE planId=? AND deleted=0'
    ).bind(planId).all();
    const all = (rs.results || []).map(mapResponse);
    const valid = all.filter(r => r.valid);

    // 分档统计
    const byLevel = { normal: 0, watch: 0, interview: 0, retest: 0 };
    all.forEach(r => { byLevel[r.suggested] = (byLevel[r.suggested] || 0) + 1; });

    // 按班级
    const byClass = {};
    valid.forEach(r => {
      const k = `${r.grade || ''}${r.className || ''}` || '未填';
      byClass[k] = byClass[k] || { total: 0, normal: 0, watch: 0, interview: 0 };
      byClass[k].total++;
      if (byClass[k][r.suggested] !== undefined) byClass[k][r.suggested]++;
    });

    // 维度排序：统计每个维度异常/边缘人数
    const dimCount = {};
    valid.forEach(r => {
      (r.scores || []).forEach(d => {
        if (!d || !d.name) return;
        dimCount[d.name] = dimCount[d.name] || { name: d.name, abnormal: 0, border: 0, sum: 0, n: 0 };
        dimCount[d.name].n++;
        dimCount[d.name].sum += d.raw || 0;
        if (d.level === 'abnormal') dimCount[d.name].abnormal++;
        if (d.level === 'border') dimCount[d.name].border++;
      });
    });
    const dimRank = Object.values(dimCount)
      .map(d => ({ ...d, avg: d.n ? Math.round(d.sum / d.n * 10) / 10 : 0,
        riskRate: d.n ? Math.round((d.abnormal + d.border) / d.n * 100) : 0 }))
      .sort((a, b) => b.riskRate - a.riskRate || b.abnormal - a.abnormal);

    return json({
      ok: true, planId, total: all.length, validCount: valid.length,
      invalidCount: all.length - valid.length,
      byLevel,
      byClass: Object.entries(byClass).map(([k, v]) => ({ label: k, ...v,
        positiveRate: v.total ? Math.round((v.watch + v.interview) / v.total * 100) : 0 })),
      dimRank,
    });
  }

  // ---------- 导出：待谈名单 ----------
  if (p === '/api/admin/export/talklist' && method === 'GET') {
    const planId = url.searchParams.get('planId');
    if (!planId) return json({ ok: false, message: '缺少 planId' }, 400);
    const res = await env.DB.prepare(
      'SELECT * FROM screenings WHERE planId=? ORDER BY suggested DESC, className, name'
    ).bind(planId).all();
    const list = (res.results || []).map(mapScreening)
      .filter(s => s.suggested === 'interview' || s.suggested === 'watch');
    const head = ['序号', '姓名', '年级', '班级', '建议档位', '操作分级', '访谈结论', '备注'];
    const lines = [head.map(csvEsc).join(',')];
    list.forEach((s, i) => {
      lines.push([i + 1, s.name, s.grade, s.className,
        levelName(s.suggested), levelName(s.opLevel), confName(s.confirmed), s.note]
        .map(csvEsc).join(','));
    });
    return csvResponse(BOM + lines.join('\r\n'), `待谈名单-${planId}-${nowISO().slice(0, 10)}.csv`);
  }

  // ---------- 导出：脱敏上报报表 ----------
  if (p === '/api/admin/export/report' && method === 'GET') {
    const planId = url.searchParams.get('planId');
    if (!planId) return json({ ok: false, message: '缺少 planId' }, 400);
    const rs = await env.DB.prepare('SELECT * FROM responses WHERE planId=? AND deleted=0').bind(planId).all();
    const all = (rs.results || []).map(mapResponse);
    const valid = all.filter(r => r.valid);
    const pr = await env.DB.prepare('SELECT title, term FROM plans WHERE id=?').bind(planId).first();
    const title = (pr && pr.title) || '普查';

    // 脱敏：不出现姓名，班级人数 <5 时合并
    const byClass = {};
    valid.forEach(r => {
      const k = `${r.grade || ''}${r.className || ''}` || '未填';
      byClass[k] = byClass[k] || { total: 0, normal: 0, watch: 0, interview: 0 };
      byClass[k].total++;
      if (byClass[k][r.suggested] !== undefined) byClass[k][r.suggested]++;
    });

    const lines = [];
    lines.push(['普查名称', title]);
    lines.push(['学期', (pr && pr.term) || '']);
    lines.push(['导出时间', nowISO().slice(0, 10)]);
    lines.push([]);
    lines.push(['年级班级', '参与人数', '正常', '需关注', '需访谈', '关注率%']);
    let sum = { total: 0, normal: 0, watch: 0, interview: 0 };
    let smallCells = [];
    Object.entries(byClass).forEach(([k, v]) => {
      sum.total += v.total; sum.normal += v.normal; sum.watch += v.watch; sum.interview += v.interview;
      if (v.total < 5) { smallCells.push(k); return; }   // n<5 隐藏
      const rate = v.total ? Math.round((v.watch + v.interview) / v.total * 100) : 0;
      lines.push([k, v.total, v.normal, v.watch, v.interview, rate]);
    });
    if (smallCells.length) {
      const t = smallCells.reduce((a, k) => {
        const v = byClass[k]; a.total += v.total; a.normal += v.normal; a.watch += v.watch; a.interview += v.interview; return a;
      }, { total: 0, normal: 0, watch: 0, interview: 0 });
      if (t.total >= 5) {
        lines.push(['其他（人数<5已合并）', t.total, t.normal, t.watch, t.interview,
          Math.round((t.watch + t.interview) / t.total * 100)]);
      }
    }
    lines.push([]);
    lines.push(['合计', sum.total, sum.normal, sum.watch, sum.interview,
      sum.total ? Math.round((sum.watch + sum.interview) / sum.total * 100) : 0]);
    lines.push([]);
    lines.push(['说明', '本表已脱敏，不含学生姓名等个体身份信息']);

    return csvResponse(BOM + lines.map(r => r.map(csvEsc).join(',')).join('\r\n'),
      `心理健康上报汇总-${nowISO().slice(0, 10)}.csv`);
  }

  // ---------- 导出：答卷明细 ----------
  if (p === '/api/admin/export/responses' && method === 'GET') {
    const planId = url.searchParams.get('planId');
    if (!planId) return json({ ok: false, message: '缺少 planId' }, 400);
    const rs = await env.DB.prepare('SELECT * FROM responses WHERE planId=? AND deleted=0 ORDER BY submittedAt').bind(planId).all();
    const list = (rs.results || []).map(mapResponse);
    const head = ['序号', '姓名', '年级', '班级', '性别', '建议档位', '是否有效', '无效原因',
      '作答时长(秒)', '维度得分', '提交时间'];
    const lines = [head.map(csvEsc).join(',')];
    list.forEach((r, i) => {
      const dimText = (r.scores || []).map(d => `${d.name}:${d.raw}(${d.level})`).join(' | ');
      lines.push([i + 1, r.name, r.grade, r.className, r.gender, levelName(r.suggested),
        r.valid ? '有效' : '无效', r.invalidReason, r.durationSec, dimText,
        String(r.submittedAt || '').slice(0, 16).replace('T', ' ')].map(csvEsc).join(','));
    });
    return csvResponse(BOM + lines.join('\r\n'), `普查明细-${nowISO().slice(0, 10)}.csv`);
  }

  // ---------- 答卷列表 ----------
  if (p === '/api/admin/responses' && method === 'GET') {
    const planId = url.searchParams.get('planId');
    let res;
    if (planId) res = await env.DB.prepare('SELECT * FROM responses WHERE planId=? AND deleted=0 ORDER BY submittedAt DESC').bind(planId).all();
    else res = await env.DB.prepare('SELECT * FROM responses WHERE deleted=0 ORDER BY submittedAt DESC').all();
    return json((res.results || []).map(mapResponse));
  }

  // ---------- 清空某普查答卷 ----------
  if (p === '/api/admin/clear-responses' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    if (!body.planId) return json({ ok: false, message: '缺少 planId' }, 400);
    await env.DB.prepare('DELETE FROM screenings WHERE planId=?').bind(body.planId).run();
    const r = await env.DB.prepare('DELETE FROM responses WHERE planId=?').bind(body.planId).run();
    const n = r.meta ? (r.meta.changes ?? r.meta.rows_written ?? 0) : 0;
    return json({ ok: true, removed: n, message: `已清空 ${n} 份答卷（不可恢复，请谨慎）` });
  }

  // ============================================================
  //  通用问卷调查（与心理普查并列）
  // ============================================================

  // ---- 学生端：开放的问卷 ----
  if (p === '/api/surveys/open' && method === 'GET') {
    await ensureSchema(env);
    const now = nowISO();
    const res = await env.DB.prepare(
      "SELECT * FROM surveys WHERE deleted=0 AND status='open' ORDER BY createdAt DESC"
    ).all();
    const list = [];
    for (const r of (res.results || [])) {
      const sv = mapSurvey(r);
      let windowOpen = true, windowNote = '';
      if (sv.startAt && now < sv.startAt) { windowOpen = false; windowNote = '尚未开始'; }
      if (sv.endAt && now > sv.endAt) { windowOpen = false; windowNote = '已截止'; }
      const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM survey_responses WHERE surveyId=? AND deleted=0').bind(sv.id).first();
      list.push({ ...sv, windowOpen, windowNote, responseCount: c ? c.n : 0 });
    }
    return json(list);
  }

  if (p === '/api/survey/detail' && method === 'GET') {
    await ensureSchema(env);
    const id = url.searchParams.get('id');
    const r = await env.DB.prepare('SELECT * FROM surveys WHERE id=? AND deleted=0').bind(id).first();
    if (!r) return json({ ok: false, message: '问卷不存在' }, 404);
    const sv = mapSurvey(r);
    const now = nowISO();
    if (sv.status !== 'open') return json({ ok: false, message: '该问卷未开放' }, 403);
    if (sv.startAt && now < sv.startAt) return json({ ok: false, message: '填写尚未开始' }, 403);
    if (sv.endAt && now > sv.endAt) return json({ ok: false, message: '填写已截止' }, 403);
    const qs = await env.DB.prepare('SELECT * FROM questions WHERE surveyId=? ORDER BY qIndex').bind(id).all();
    return json({ ...sv, questions: (qs.results || []).map(mapQuestion) });
  }

  if (p === '/api/survey/submit' && method === 'POST') {
    await ensureSchema(env);
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ ok: false, message: '数据格式错误' }, 400); }
    const id0 = body.surveyId;
    if (!id0) return json({ ok: false, message: '缺少问卷 id' }, 400);
    const r = await env.DB.prepare('SELECT * FROM surveys WHERE id=? AND deleted=0').bind(id0).first();
    if (!r) return json({ ok: false, message: '问卷不存在' }, 404);
    const sv = mapSurvey(r);
    const now = nowISO();
    if (sv.status !== 'open') return json({ ok: false, message: '该问卷已关闭' }, 403);
    if (sv.startAt && now < sv.startAt) return json({ ok: false, message: '填写尚未开始' }, 403);
    if (sv.endAt && now > sv.endAt) return json({ ok: false, message: '填写已截止' }, 403);

    const qs = await env.DB.prepare('SELECT * FROM questions WHERE surveyId=? ORDER BY qIndex').bind(id0).all();
    const questions = (qs.results || []).map(mapQuestion);
    const ansMap = {};
    (body.answers || []).forEach(a => { if (a && a.qid) ansMap[a.qid] = a.value; });
    for (const q of questions) {
      if (!q.required) continue;
      const v = ansMap[q.id];
      const empty = (v === undefined || v === null || v === ''
        || (Array.isArray(v) && !v.length));
      if (empty) return json({ ok: false, message: '还有必填题没填，请检查后提交' }, 400);
    }

    const name = sv.anonymous ? '' : String(body.name || '').trim();
    const grade = sv.anonymous ? '' : String(body.grade || '').trim();
    const className = sv.anonymous ? '' : String(body.className || '').trim();
    if (!sv.anonymous && !name) return json({ ok: false, message: '请填写姓名' }, 400);
    const studentKey = sv.anonymous ? ('anon_' + uid()) : `${grade}|${className}|${name}`;

    const rid = uid();
    await env.DB.prepare(`
      INSERT INTO survey_responses (id, surveyId, studentKey, name, grade, className,
        answers, startedAt, submittedAt, durationSec, deleted)
      VALUES (?,?,?,?,?,?,?,?,?,?,0)
    `).bind(rid, id0, studentKey, name, grade, className,
      JSON.stringify(body.answers || []), body.startedAt || now, now,
      Number(body.durationSec) || 0).run();
    console.log(`[问卷] 「${sv.title}」 ${grade}${className} ${name || '匿名'} 已提交`);
    return json({ ok: true, id: rid, thanksText: '提交成功，谢谢你！' });
  }

  // ---- 教师端：问卷 CRUD ----
  if (p === '/api/admin/surveys' && method === 'GET') {
    const res = await env.DB.prepare('SELECT * FROM surveys WHERE deleted = 0 ORDER BY createdAt DESC').all();
    const rows = res.results || [];
    const ids = rows.map(r => r.id);
    // 原来每个问卷 2 次查询，现在固定 2 次
    const [qc, rc] = await Promise.all([
      countBy(env, 'questions', 'surveyId', ids),
      countBy(env, 'survey_responses', 'surveyId', ids, ' AND deleted=0'),
    ]);
    const list = rows.map(r => ({ ...mapSurvey(r),
      questionCount: qc[r.id] || 0, responseCount: rc[r.id] || 0 }));
    return json(list);
  }

  if (p === '/api/admin/survey' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const title = String(body.title || '').trim();
    if (!title) return json({ ok: false, message: '请填写问卷标题' }, 400);
    const id = uid();
    await env.DB.prepare(`
      INSERT INTO surveys (id, title, description, status, anonymous, startAt, endAt, notice, createdAt, deleted)
      VALUES (?,?,?,?,?,?,?,?,?,0)
    `).bind(id, title, String(body.description || ''), 'draft',
      body.anonymous ? 1 : 0, String(body.startAt || ''), String(body.endAt || ''),
      String(body.notice || ''), nowISO()).run();
    return json({ ok: true, id, message: '问卷已创建，请添加题目' });
  }

  if (p === '/api/admin/survey' && method === 'PUT') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    if (!body.id) return json({ ok: false, message: '缺少 id' }, 400);
    await env.DB.prepare(`
      UPDATE surveys SET title=?, description=?, status=?, anonymous=?, startAt=?, endAt=?, notice=? WHERE id=?
    `).bind(String(body.title || ''), String(body.description || ''), String(body.status || 'draft'),
      body.anonymous ? 1 : 0, String(body.startAt || ''), String(body.endAt || ''),
      String(body.notice || ''), body.id).run();
    return json({ ok: true, message: '已保存' });
  }

  if (p === '/api/admin/survey' && method === 'DELETE') {
    const id = url.searchParams.get('id');
    if (!id) return json({ ok: false, message: '缺少 id' }, 400);
    await env.DB.prepare('UPDATE surveys SET deleted=1 WHERE id=?').bind(id).run();
    return json({ ok: true, message: '已删除问卷' });
  }

  if (p === '/api/admin/questions' && method === 'GET') {
    const sid = url.searchParams.get('surveyId');
    if (!sid) return json({ ok: false, message: '缺少 surveyId' }, 400);
    const res = await env.DB.prepare('SELECT * FROM questions WHERE surveyId=? ORDER BY qIndex').bind(sid).all();
    return json((res.results || []).map(mapQuestion));
  }

  if (p === '/api/admin/questions' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    const sid = body.surveyId;
    if (!sid || !Array.isArray(body.questions)) return json({ ok: false, message: '缺少参数' }, 400);
    await env.DB.prepare('DELETE FROM questions WHERE surveyId=?').bind(sid).run();
    let n = 0;
    const pending = [];
    for (let i = 0; i < body.questions.length; i++) {
      const q = body.questions[i];
      if (!String(q.title || '').trim()) continue;
      pending.push(env.DB.prepare(`
        INSERT INTO questions (id, surveyId, qIndex, type, title, required, options, config)
        VALUES (?,?,?,?,?,?,?,?)
      `).bind(q.id || uid(), sid, i, String(q.type || 'single'), String(q.title),
        q.required === false ? 0 : 1, JSON.stringify(q.options || []),
        JSON.stringify(q.config || {})).run());
      n++;
    }
    await flushAll(pending);
    return json({ ok: true, saved: n, message: `已保存 ${n} 道题` });
  }

  if (p === '/api/admin/survey-responses' && method === 'GET') {
    const sid = url.searchParams.get('surveyId');
    if (!sid) return json({ ok: false, message: '缺少 surveyId' }, 400);
    const res = await env.DB.prepare(
      'SELECT * FROM survey_responses WHERE surveyId=? AND deleted=0 ORDER BY submittedAt DESC'
    ).bind(sid).all();
    return json((res.results || []).map(mapSurveyResponse));
  }

  if (p === '/api/admin/survey-stats' && method === 'GET') {
    const sid = url.searchParams.get('surveyId');
    if (!sid) return json({ ok: false, message: '缺少 surveyId' }, 400);
    const qs = await env.DB.prepare('SELECT * FROM questions WHERE surveyId=? ORDER BY qIndex').bind(sid).all();
    const questions = (qs.results || []).map(mapQuestion);
    const rs = await env.DB.prepare(
      'SELECT * FROM survey_responses WHERE surveyId=? AND deleted=0'
    ).bind(sid).all();
    const list = (rs.results || []).map(mapSurveyResponse);

    const stats = questions.map(q => {
      const vals = list.map(r => (r.answers || []).find(a => a && a.qid === q.id))
        .map(a => (a ? a.value : undefined)).filter(v => v !== undefined);
      const out = { id: q.id, title: q.title, type: q.type, count: vals.length };
      if (q.type === 'single' || q.type === 'scale') {
        const cnt = {};
        (q.options || []).forEach(o => { cnt[o] = 0; });
        vals.forEach(v => { cnt[String(v)] = (cnt[String(v)] || 0) + 1; });
        out.dist = Object.entries(cnt).map(([k, v]) => ({ label: k, n: v,
          pct: vals.length ? Math.round(v / vals.length * 100) : 0 }));
      } else if (q.type === 'multi') {
        const cnt = {};
        (q.options || []).forEach(o => { cnt[o] = 0; });
        vals.forEach(v => {
          (Array.isArray(v) ? v : [v]).forEach(x => { cnt[String(x)] = (cnt[String(x)] || 0) + 1; });
        });
        out.dist = Object.entries(cnt).map(([k, v]) => ({ label: k, n: v,
          pct: vals.length ? Math.round(v / vals.length * 100) : 0 }));
      } else if (q.type === 'rating' || q.type === 'number') {
        const nums = vals.map(Number).filter(x => !isNaN(x));
        const max = Number((q.config || {}).max) || 5;
        const cnt = {};
        for (let i = 1; i <= max; i++) cnt[i] = 0;
        nums.forEach(v => { const k = Math.round(v); cnt[k] = (cnt[k] || 0) + 1; });
        out.avg = nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length * 10) / 10 : 0;
        out.min = nums.length ? Math.min(...nums) : 0;
        out.maxV = nums.length ? Math.max(...nums) : 0;
        out.dist = Object.entries(cnt).map(([k, v]) => ({ label: k, n: v }));
      } else {
        out.texts = vals.map(String).filter(Boolean);
      }
      return out;
    });
    return json({ ok: true, surveyId: sid, total: list.length, stats });
  }

  if (p === '/api/admin/export/survey' && method === 'GET') {
    const sid = url.searchParams.get('surveyId');
    if (!sid) return json({ ok: false, message: '缺少 surveyId' }, 400);
    const qs = await env.DB.prepare('SELECT * FROM questions WHERE surveyId=? ORDER BY qIndex').bind(sid).all();
    const questions = (qs.results || []).map(mapQuestion);
    const rs = await env.DB.prepare(
      'SELECT * FROM survey_responses WHERE surveyId=? AND deleted=0 ORDER BY submittedAt'
    ).bind(sid).all();
    const list = (rs.results || []).map(mapSurveyResponse);

    const head = ['序号', '姓名', '年级', '班级', ...questions.map((q, i) => `第${i + 1}题：${q.title}`), '提交时间'];
    const lines = [head.map(csvEsc).join(',')];
    list.forEach((r, i) => {
      const row = [i + 1, r.name, r.grade, r.className];
      questions.forEach(q => {
        const a = (r.answers || []).find(x => x && x.qid === q.id);
        let v = a ? a.value : '';
        if (Array.isArray(v)) v = v.join('、');
        row.push(v);
      });
      row.push(String(r.submittedAt || '').slice(0, 16).replace('T', ' '));
      lines.push(row.map(csvEsc).join(','));
    });
    return csvResponse(BOM + lines.join('\r\n'), `问卷明细-${nowISO().slice(0, 10)}.csv`);
  }

  if (p === '/api/admin/clear-survey-responses' && method === 'POST') {
    let body = {};
    try { body = await request.json(); } catch (e) {}
    if (!body.surveyId) return json({ ok: false, message: '缺少 surveyId' }, 400);
    const r = await env.DB.prepare('DELETE FROM survey_responses WHERE surveyId=?').bind(body.surveyId).run();
    const n = r.meta ? (r.meta.changes ?? r.meta.rows_written ?? 0) : 0;
    return json({ ok: true, removed: n, message: `已清空 ${n} 份答卷` });
  }

  // 静态兜底
  if (method === 'GET' && env.ASSETS) {
    try { return await env.ASSETS.fetch(request); } catch (e) {}
  }
  return json({ ok: false, message: '接口不存在: ' + p }, 404);
}

function csvResponse(text, filename) {
  return new Response(text, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
      ...CORS,
    },
  });
}

function levelName(k) {
  return { normal: '正常', watch: '需关注', interview: '需访谈', retest: '需重测',
    daily: '日常关注', focus: '重点关注', crisis: '危机关注' }[k] || (k || '');
}
function confName(k) {
  return { confirmed: '确认需干预', excluded: '排除', observing: '持续观察', pending: '待访谈' }[k] || (k || '');
}
