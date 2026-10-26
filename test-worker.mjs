/**
 * 心理健康平台 · Worker 逻辑验证
 * 覆盖完整工作流：登录持久化/改密码 → 普查计划(限时) → 作答(效度校验) → 筛查分档
 *   → 访谈复核(自动建档) → 干预 → 复测 → 转介/结案 → 报告与导出
 */
import worker from './worker.js';
import fs from 'fs';
import { makeDB, makeAssets } from './mock.mjs';

const files = {
  'index.html': fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8'),
  'admin.html': fs.readFileSync(new URL('./public/admin.html', import.meta.url), 'utf8'),
  'setup.html': fs.readFileSync(new URL('./public/setup.html', import.meta.url), 'utf8'),
};
const env = { DB: makeDB(), ASSETS: makeAssets(files), TEACHER_PASSWORD: 'gg26x' };

let pass = 0, fail = 0;
function check(n, ok, extra = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${n}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
}
async function call(path, opts = {}) {
  const res = await worker.fetch(new Request('https://p.test.dev' + path, opts), env, {});
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text(), headers: res.headers };
}
const J = (m, d, t) => ({
  method: m,
  headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
  body: d === undefined ? undefined : JSON.stringify(d),
});
const G = t => ({ headers: { Authorization: 'Bearer ' + t } });

console.log('==========================================');
console.log('  心理健康平台 · Worker 逻辑验证');
console.log('==========================================\n');

// ---------- 1. 基础 ----------
let r = await call('/api/health');
check('健康检查（自动建 14 张表）', r.body.ok === true && r.body.dbReady === true, JSON.stringify(r.body));
r = await call('/');
check('学生首页可访问', r.status === 200 && r.body.includes('心理小调查'), `${r.body.length} 字节`);
r = await call('/admin');
check('管理后台可访问', r.status === 200 && r.body.includes('心理健康工作平台'), `${r.body.length} 字节`);

// ---------- 2. 登录持久化（30天）----------
r = await call('/api/auth', J('POST', { password: 'gg26x', remember: true }));
const T = r.body.token;
check('登录返回 30 天 token', r.body.ok === true && r.body.ttl === '30天', JSON.stringify(r.body));
r = await call('/api/auth', J('POST', { password: 'gg26x', remember: false }));
check('不记住我时 12 小时', r.body.ttl === '12小时');
r = await call('/api/verify?token=' + encodeURIComponent(T));
check('token 可被静默校验（登录持久化）', r.body.ok === true);
r = await call('/api/verify?token=bogus');
check('无效 token 被拒绝', r.body.ok === false);

// ---------- 3. 修改密码 ----------
r = await call('/api/admin/password', J('POST', { oldPassword: 'wrong', newPassword: 'newpass123' }, T));
check('改密码：原密码错误被拒', r.status === 400);
r = await call('/api/admin/password', J('POST', { oldPassword: 'gg26x', newPassword: '12' }, T));
check('改密码：过短被拒', r.status === 400);
r = await call('/api/admin/password', J('POST', { oldPassword: 'gg26x', newPassword: 'newpass123' }, T));
const T2 = r.body.token;
check('改密码成功并返回新 token', r.body.ok === true && !!T2);
r = await call('/api/auth', J('POST', { password: 'gg26x' }));
check('旧密码失效', r.status === 401);
r = await call('/api/auth', J('POST', { password: 'newpass123' }));
const T3 = r.body.token;
check('新密码可登录', r.body.ok === true);
// 改回
await call('/api/admin/password', J('POST', { oldPassword: 'newpass123', newPassword: 'gg26x' }, T3));
const TOK = (await call('/api/auth', J('POST', { password: 'gg26x' }))).body.token;
check('密码改回 gg26x', !!TOK);

// ---------- 4. 内置量表库 ----------
// 部署时题库是分批载入的（/api/seed 循环），测试也要走同样的路径
async function seedAll(maxRounds = 200) {
  let rounds = 0;
  for (let i = 0; i < maxRounds; i++) {
    const sr = await call('/api/seed?limit=150', G(TOK));
    rounds++;
    if (sr.body && (sr.body.done || sr.body.remaining === 0)) break;
  }
  return rounds;
}
const SEED_ROUNDS = await seedAll();
r = await call('/api/admin/scales', G(TOK));
const SCALES = r.body;
check('★ 分批载入题库可达完整（24 量表/669 题）',
  Array.isArray(SCALES) && SCALES.length === 24
  && SCALES.reduce((a, s) => a + (s.itemImported || 0), 0) === 669,
  `${SEED_ROUNDS} 轮完成，${SCALES.length} 个量表 / ${SCALES.reduce((a, s) => a + (s.itemImported || 0), 0)} 题`);
check('载入 24 个内置量表', Array.isArray(SCALES) && SCALES.length === 24, `${SCALES.length} 个`);
const mht = SCALES.find(s => s.code === 'MHT');
check('MHT 含 8 个维度', mht && mht.dims.length === 8, mht ? mht.dims.map(d => d.name).join('、') : '');
const sdq = SCALES.find(s => s.code === 'SDQ');
check('SDQ 含 5 维度含亲社会反向', sdq && sdq.dims.length === 5
  && sdq.dims.some(d => d.direction === 'higher_better'), '');
check('量表标注版权状态', SCALES.every(s => s.copyright), (SCALES[0] && SCALES[0].copyrightNote ? SCALES[0].copyrightNote.slice(0, 24) : '') + '…');
// 防回归：曾经因为只传 {id, code} 导致写进去的量表只有代号，名称/说明/临界值全空
check('★ 每个量表元数据字段完整', SCALES.every(s => s.name && s.shortName && s.scoringNote && s.gradeRange),
  SCALES.filter(s => !s.name || !s.shortName || !s.scoringNote).map(s => s.code).join(',') || '全部完整');
check('★ 维度含临界值配置', SCALES.every(s => s.dims.length > 0 && s.dims.every(d => d.name && d.maxScore > 0)),
  SCALES.filter(s => !s.dims.length).map(s => s.code).join(',') || '全部完整');
check('内置题目已自动载入（完整量表）', SCALES.every(s => s.usable && s.itemImported > 0),
  SCALES.map(s => s.code + ':' + s.itemImported).join(' '));
const mht2 = SCALES.find(s => s.code === 'MHT');
check('MHT 内置 100 题', mht2.itemImported === 100, mht2.itemImported + ' 题');
const sdq2 = SCALES.find(s => s.code === 'SDQ');
check('SDQ 内置 25 题', sdq2.itemImported === 25, sdq2.itemImported + ' 题');

// ---------- 5. 内置题目（直接可用，无需手动导入）----------
r = await call('/api/admin/scale-items?scaleId=mht', G(TOK));
const its = r.body;
check('MHT 题目可直接读取', its.length === 100, its.length + ' 题');
check('含 10 道效度题', its.filter(i => i.type === 'validity').length === 10);
r = await call('/api/admin/scale-items?scaleId=cdi', G(TOK));
check('CDI 风险题已标记', r.body.some(i => i.type === 'risk'));
r = await call('/api/admin/scale-items?scaleId=lonely', G(TOK));
check('孤独感含 8 道插入题', r.body.filter(i => i.type === 'filler').length === 8);

// ---------- 6. 普查计划 + 限时 ----------
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
r = await call('/api/admin/plan', J('POST', {
  title: '2026学年春季心理健康普查', term: '2026春',
  gradeScope: ['四年级', '五年级'], scaleIds: ['mht'],
  startAt: yesterday, endAt: tomorrow, anonymous: false,
  notice: '同学你好，请按真实想法作答',
}, TOK));
const PID = r.body.id;
check('创建普查计划（含作答窗口）', r.body.ok === true && !!PID);

r = await call('/api/admin/plan', J('PUT', { id: PID, status: 'open',
  title: '2026学年春季心理健康普查', gradeScope: ['四年级'], scaleIds: ['mht'],
  startAt: yesterday, endAt: tomorrow }, TOK));
check('开放普查', r.body.ok === true);

r = await call('/api/plans/open');
check('学生端可见已开放普查', r.body.length === 1 && r.body[0].windowOpen === true, JSON.stringify(r.body[0] && r.body[0].windowOpen));

// 限时：截止后不可提交
r = await call('/api/admin/plan', J('PUT', { id: PID, status: 'open',
  title: '2026学年春季心理健康普查', gradeScope: ['四年级'], scaleIds: ['mht'],
  startAt: yesterday, endAt: yesterday }, TOK));
r = await call('/api/plan/detail?id=' + PID);
check('超过截止日期被拦截', r.status === 403 && /截止/.test(r.body.message || ''), r.body.message);
// 恢复窗口
await call('/api/admin/plan', J('PUT', { id: PID, status: 'open',
  title: '2026学年春季心理健康普查', gradeScope: ['四年级'], scaleIds: ['mht'],
  startAt: yesterday, endAt: tomorrow }, TOK));

r = await call('/api/plan/detail?id=' + PID);
check('学生可获取题目', r.body.ok !== false && (r.body.items || []).length === 100, `${(r.body.items || []).length} 题`);

// ---------- 7. 学生提交（四种场景，按选项计分值自动选）----------
// 取该题目中计分最低 / 中间 / 最高的选项，适配任意量表（MHT 为是/否，SDQ 为不符合/完全符合）
const optOf = (it, want) => {
  const e = Object.entries(it.scoreMap || {});
  if (!e.length) return (it.options || [])[0];
  e.sort((a, b) => Number(a[1]) - Number(b[1]));
  return want === 'min' ? e[0][0] : want === 'max' ? e[e.length - 1][0] : e[Math.floor(e.length / 2)][0];
};
const mkA = fn => its.map((it, i) => ({ itemId: it.id, value: fn(it, i) }));

// 7a 正常：多数选最低分，少量选最高分 → 正常档
r = await call('/api/submit', J('POST', {
  planId: PID, name: '张小明', grade: '四年级', className: '3班', gender: '男',
  startedAt: new Date(Date.now() - 300000).toISOString(), durationSec: 300,
  answers: mkA((it, i) => it.type === 'validity' ? optOf(it, 'min') : (i % 5 === 0 ? optOf(it, 'max') : optOf(it, 'min'))),
}));
check('正常提交且判为正常', r.body.ok === true && r.body.valid === true
  && r.body.suggested === 'normal', JSON.stringify(r.body));

// 7b 规律性作答：内容题全部同一选项
r = await call('/api/submit', J('POST', {
  planId: PID, name: '李小红', grade: '四年级', className: '3班', gender: '女',
  startedAt: new Date(Date.now() - 200000).toISOString(), durationSec: 200,
  answers: mkA(it => it.type === 'validity' ? optOf(it, 'min') : optOf(it, 'min')),
}));
check('规律性作答被标记无效', r.body.valid === false && r.body.invalidReason === '规律性作答', JSON.stringify(r.body));

// 7c 作答过快：100 题只用了 20 秒
r = await call('/api/submit', J('POST', {
  planId: PID, name: '王小刚', grade: '四年级', className: '3班', gender: '男',
  startedAt: new Date(Date.now() - 20000).toISOString(), durationSec: 20,
  answers: mkA((it, i) => it.type === 'validity' ? optOf(it, 'min') : (i % 3 === 0 ? optOf(it, 'max') : optOf(it, 'min'))),
}));
check('作答过快被标记无效', r.body.valid === false && r.body.invalidReason === '作答过快', JSON.stringify(r.body));

// 7d 效度题异常：效度题全选"社会赞许"方向
r = await call('/api/submit', J('POST', {
  planId: PID, name: '赵小雨', grade: '四年级', className: '3班', gender: '女',
  startedAt: new Date(Date.now() - 400000).toISOString(), durationSec: 400,
  answers: mkA((it, i) => it.type === 'validity' ? optOf(it, 'max') : (i % 4 === 0 ? optOf(it, 'max') : optOf(it, 'min'))),
}));
check('效度题异常被标记无效', r.body.valid === false && r.body.invalidReason === '效度题异常', JSON.stringify(r.body));

// 7e 高分：多数选最高分 → 需访谈
r = await call('/api/submit', J('POST', {
  planId: PID, name: '孙小雷', grade: '四年级', className: '3班', gender: '男',
  startedAt: new Date(Date.now() - 350000).toISOString(), durationSec: 350,
  answers: mkA((it, i) => it.type === 'validity' ? optOf(it, 'min') : (i % 4 === 0 ? optOf(it, 'min') : optOf(it, 'max'))),
}));
check('高分答卷建议"需访谈"', r.body.ok === true && r.body.valid === true
  && r.body.suggested === 'interview', JSON.stringify(r.body));

// ---------- 8. 筛查名单 ----------
r = await call('/api/admin/screenings?planId=' + PID, G(TOK));
const SCR = r.body;
check('筛查名单生成', Array.isArray(SCR) && SCR.length === 5, `${SCR.length} 条`);
check('分出三档', SCR.some(s => s.suggested === 'interview')
  && SCR.some(s => s.suggested === 'normal' || s.suggested === 'watch'),
  SCR.map(s => s.suggested).join(','));
const talk = SCR.filter(s => s.suggested === 'interview' || s.suggested === 'watch');
check('可筛出待谈名单', talk.length >= 1, `${talk.length} 人待谈`);

r = await call('/api/admin/export/talklist?planId=' + PID + '&token=' + TOK);
check('导出待谈名单 CSV', r.body.includes('姓名') && r.body.includes('建议档位'),
  `${r.body.split('\r\n').length} 行`);

// ---------- 9. 访谈复核 → 自动建档 + 复测提醒 ----------
const target = SCR.find(s => s.suggested === 'interview');
r = await call('/api/admin/interview', J('POST', {
  screeningId: target.id, planId: PID, studentKey: target.studentKey,
  name: target.name, grade: target.grade, className: target.className,
  interviewedAt: new Date().toISOString().slice(0, 10), teacher: '李老师',
  chiefComplaint: '最近睡不好，担心考试',
  observation: '情绪低落，说话声音小',
  riskAssessment: '无自伤意念',
  conclusion: 'confirmed', conclusionNote: '学习焦虑明显',
  respLevel: 'focus', retestWeeks: 6, planText: '每周一次个体辅导',
  guardianNotify: true,
}, TOK));
const CASE_ID = r.body.caseId;
check('访谈记录已保存', r.body.ok === true);
check('确认阳性自动建档', !!CASE_ID, CASE_ID || '');
check('自动创建复测提醒', /自动建档/.test(r.body.message || ''), r.body.message);

r = await call('/api/admin/screenings?planId=' + PID, G(TOK));
check('筛查结论回填', r.body.find(s => s.id === target.id).confirmed === 'confirmed');

r = await call('/api/admin/interviews?screeningId=' + target.id, G(TOK));
check('访谈记录含结构化要素', r.body.length === 1
  && r.body[0].chiefComplaint && r.body[0].riskAssessment, '');

// ---------- 10. 干预记录 ----------
r = await call('/api/admin/cases', G(TOK));
check('个案列表含新建档案', r.body.length === 1 && r.body[0].id === CASE_ID);
r = await call('/api/admin/intervention', J('POST', {
  caseId: CASE_ID, date: new Date().toISOString().slice(0, 10),
  type: '个体辅导', content: '第一次辅导：建立关系，缓解考试焦虑',
  effect: '情绪有所放松', teacher: '李老师',
}, TOK));
check('干预记录已保存', r.body.ok === true);
r = await call('/api/admin/interventions?caseId=' + CASE_ID, G(TOK));
check('可读取干预记录', r.body.length === 1);

// ---------- 11. 复测提醒 + 前后测对比 ----------
r = await call('/api/admin/retests', G(TOK));
check('复测提醒已生成', r.body.length === 1 && r.body[0].weeks === 6,
  JSON.stringify(r.body[0] && { weeks: r.body[0].weeks, dueAt: r.body[0].dueAt }));
const RT = r.body[0];

// 再提交一次作为复测数据（分数下降 = 好转）
await call('/api/submit', J('POST', {
  planId: PID, name: '孙小雷', grade: '四年级', className: '3班', gender: '男',
  startedAt: new Date(Date.now() - 300000).toISOString(), durationSec: 300,
  answers: mkA((it, i) => it.type === 'validity' ? optOf(it, 'min') : (i % 3 === 0 ? optOf(it, 'max') : optOf(it, 'min'))),
}));
r = await call('/api/admin/compare?studentKey=' + encodeURIComponent(target.studentKey), G(TOK));
check('前后测对比有 2 次记录', r.body.ok === true && r.body.count === 2, JSON.stringify(r.body.count));
check('对比含维度得分序列', Array.isArray(r.body.series) && r.body.series.length === 2);

r = await call('/api/admin/retest', J('PUT', { id: RT.id, status: 'done', donePlanId: PID }, TOK));
check('标记复测完成', r.body.ok === true);

// ---------- 12. 转介 ----------
r = await call('/api/admin/referral', J('POST', {
  caseId: CASE_ID, studentKey: target.studentKey, name: target.name,
  grade: target.grade, className: target.className,
  toOrg: '市精神卫生中心儿少科', reason: '焦虑明显，需专业评估',
  guardianConsent: true, teacher: '李老师',
}, TOK));
check('转介记录已留痕', r.body.ok === true, r.body.message);
r = await call('/api/admin/referral', J('PUT', { id: r.body.id, feedback: '已就诊，建议继续校内支持', guardianConsent: true }, TOK));
check('转介反馈可回填', r.body.ok === true);
r = await call('/api/admin/cases', G(TOK));
check('个案状态变为已转介', r.body[0].status === 'referred');

// ---------- 13. 结案 ----------
r = await call('/api/admin/closure', J('POST', {
  caseId: CASE_ID, studentKey: target.studentKey, name: target.name,
  grade: target.grade, className: target.className,
  reason: '干预目标达成', reasonNote: '焦虑缓解，睡眠改善',
  summary: '经 8 次个体辅导，考试焦虑明显缓解', teacher: '李老师',
}, TOK));
check('结案已记录', r.body.ok === true);
r = await call('/api/admin/cases', G(TOK));
check('个案状态变为已结案', r.body[0].status === 'closed');
r = await call('/api/admin/closures', G(TOK));
check('结案记录含原因', r.body.length === 1 && r.body[0].reason === '干预目标达成');

// ---------- 14. 报告与导出 ----------
r = await call('/api/admin/report/group?planId=' + PID, G(TOK));
check('团体报告：总体统计', r.body.ok === true && r.body.total === 6, JSON.stringify({ total: r.body.total, valid: r.body.validCount }));
check('团体报告：班级聚合', Array.isArray(r.body.byClass) && r.body.byClass.length >= 1);
check('团体报告：维度排序', Array.isArray(r.body.dimRank));

r = await call('/api/admin/report/student?studentKey=' + encodeURIComponent(target.studentKey), G(TOK));
check('个体报告：含维度剖面', r.body.ok === true && Array.isArray(r.body.latest.dims));
check('个体报告：含访谈结论', Array.isArray(r.body.interviews) && r.body.interviews.length === 1);
check('个体报告：含干预建议', Array.isArray(r.body.interventions) && r.body.interventions.length === 1);

r = await call('/api/admin/export/report?planId=' + PID + '&token=' + TOK);
const rep = r.body;
check('上报报表已脱敏（不含姓名）', !rep.includes('张小明') && !rep.includes('孙小雷'),
  rep.split('\r\n').slice(0, 6).join(' / ').slice(0, 60) + '…');
check('上报报表含汇总行', rep.includes('合计'));

r = await call('/api/admin/export/responses?planId=' + PID + '&token=' + TOK);
check('导出答卷明细（含维度得分）', r.body.includes('维度得分') && r.body.includes('是否有效'));

// ---------- 15. 权限 ----------
r = await call('/api/admin/scales');
check('未登录无法访问量表库', r.status === 401);
r = await call('/api/admin/cases', G('bogus.token'));
check('无效 token 被拒绝', r.status === 401);

// ---------- 16. 通用问卷调查 ----------
console.log('\n── 通用问卷调查 ──');
r = await call('/api/admin/survey', J('POST', {
  title: '课后服务满意度调查', description: '了解同学对课后服务的看法', anonymous: false,
}, TOK));
const SID = r.body.id;
check('创建问卷', r.body.ok === true && !!SID);

const QS = [
  { type: 'single', title: '你最喜欢哪类课后服务？', options: ['作业辅导', '体育活动', '艺术课程', '科普活动'], required: true },
  { type: 'multi', title: '你参加过哪些课后服务？（可多选）', options: ['作业辅导', '体育活动', '艺术课程', '科普活动'], required: true },
  { type: 'rating', title: '总体满意度打分', required: true, config: { max: 5 } },
  { type: 'scale', title: '我觉得课后服务很有帮助', options: ['非常不同意', '不同意', '一般', '同意', '非常同意'], required: true },
  { type: 'text', title: '你最喜欢的老师是？', required: false },
  { type: 'textarea', title: '你对课后服务有什么建议？', required: false },
  { type: 'number', title: '你每周参加几次？', required: false },
  { type: 'date', title: '你希望活动安排在什么时候？', required: false },
];
r = await call('/api/admin/questions', J('POST', { surveyId: SID, questions: QS }, TOK));
check('保存 8 种题型', r.body.ok === true && r.body.saved === 8, JSON.stringify(r.body));
r = await call('/api/admin/questions?surveyId=' + SID, G(TOK));
const QLIST = r.body;
check('题型完整（8 类）', new Set(QLIST.map(q => q.type)).size === 8,
  QLIST.map(q => q.type).join(','));

await call('/api/admin/survey', J('PUT', { id: SID, status: 'open',
  title: '课后服务满意度调查', description: '了解同学对课后服务的看法' }, TOK));
r = await call('/api/surveys/open');
check('学生端可见问卷', r.body.length === 1 && r.body[0].windowOpen === true);
r = await call('/api/survey/detail?id=' + SID);
check('学生可获取题目', (r.body.questions || []).length === 8);

// 必填校验
r = await call('/api/survey/submit', J('POST', { surveyId: SID,
  name: '张小明', grade: '四年级', className: '3班', answers: [] }));
check('必填题未填被拒绝', r.status === 400 && /必填/.test(r.body.message || ''), r.body.message);

// 正常提交
const ans = QLIST.map(q => {
  if (q.type === 'single') return { qid: q.id, value: q.options[0] };
  if (q.type === 'multi') return { qid: q.id, value: [q.options[0], q.options[1]] };
  if (q.type === 'rating') return { qid: q.id, value: 5 };
  if (q.type === 'scale') return { qid: q.id, value: q.options[4] };
  if (q.type === 'text') return { qid: q.id, value: '李老师' };
  if (q.type === 'textarea') return { qid: q.id, value: '希望多些体育活动' };
  if (q.type === 'number') return { qid: q.id, value: 3 };
  return { qid: q.id, value: '2026-11-01' };
});
r = await call('/api/survey/submit', J('POST', { surveyId: SID,
  name: '张小明', grade: '四年级', className: '3班',
  startedAt: new Date(Date.now() - 120000).toISOString(), durationSec: 120, answers: ans }));
check('问卷提交成功', r.body.ok === true, JSON.stringify(r.body));

r = await call('/api/survey/submit', J('POST', { surveyId: SID,
  name: '李小红', grade: '四年级', className: '3班', answers: QLIST.map(q => {
    if (q.type === 'single') return { qid: q.id, value: q.options[2] };
    if (q.type === 'multi') return { qid: q.id, value: [q.options[2]] };
    if (q.type === 'rating') return { qid: q.id, value: 3 };
    if (q.type === 'scale') return { qid: q.id, value: q.options[3] };
    if (q.type === 'text') return { qid: q.id, value: '王老师' };
    if (q.type === 'number') return { qid: q.id, value: 3 };
    return { qid: q.id, value: '2026-12-01' };
  }) }));
check('第二份提交成功', r.body.ok === true);

r = await call('/api/admin/survey-responses?surveyId=' + SID, G(TOK));
check('可读取答卷', r.body.length === 2);

r = await call('/api/admin/survey-stats?surveyId=' + SID, G(TOK));
const ST = r.body.stats;
check('统计：单选题有分布', ST[0].dist && ST[0].dist.length === 4,
  ST[0].dist.map(d => d.label + ':' + d.n).join(' '));
check('统计：多选题按选项计数', ST[1].dist && ST[1].dist.reduce((a, d) => a + d.n, 0) === 3,
  ST[1].dist.map(d => d.label + ':' + d.n).join(' '));
check('统计：评分题有平均分', ST[2].avg === 4, 'avg=' + ST[2].avg);
check('统计：量表题有分布', ST[3].dist && ST[3].dist.length === 5);
check('统计：填空汇总原文', ST[4].texts && ST[4].texts.includes('李老师'));
check('统计：多行问答汇总原文', ST[5].texts && ST[5].texts.includes('希望多些体育活动'),
  JSON.stringify(ST[5].texts));
check('统计：数字题有均值', ST[6].avg === 3);

r = await call('/api/admin/export/survey?surveyId=' + SID + '&token=' + TOK);
check('导出问卷明细（一题一列）', r.body.includes('第1题：你最喜欢哪类课后服务？')
  && r.body.includes('张小明'), r.body.split('\r\n').length + ' 行');

r = await call('/api/admin/surveys', G(TOK));
check('问卷列表含题数与份数', r.body[0].questionCount === 8 && r.body[0].responseCount === 2);

// ---------- 17. 自建量表与修改已有量表 ----------
console.log('\n── 自建量表 / 修改量表 ──');
r = await call('/api/admin/scale', J('POST', {
  name: '校园归属感问卷', code: 'BELONG', responseType: 'likert5',
  gradeRange: '3-6', dims: [{ name: '归属感', itemCount: 3, direction: 'higher_better', maxScore: 15, cutNormal: 8, cutBorder: 6 },
                            { name: '疏离感', itemCount: 2, direction: 'higher_worse', maxScore: 10, cutNormal: 6, cutBorder: 8 }],
}, TOK));
const CSID = r.body.id;
check('自建量表创建成功', r.body.ok === true && !!CSID, r.body.message || '');

r = await call('/api/admin/scales', G(TOK));
const CS = r.body.find(x => x.code === 'BELONG');
check('自建量表出现在库里', !!CS && CS.builtin !== 1);
check('创建时带 2 个维度', CS && CS.dims.length === 2, CS ? CS.dims.map(d => d.name).join('/') : '');
check('新建量表未导题时为不可用', CS && CS.usable === false, 'usable=' + (CS && CS.usable));

// 加题目并保存（含分值串）
r = await call('/api/admin/scale', J('PUT', {
  id: CSID, name: '校园归属感问卷', code: 'BELONG', responseType: 'likert5', gradeRange: '3-6',
  dims: [{ key: 'k0', id: CS.dims[0].id, name: '归属感', itemCount: 3, direction: 'higher_better', maxScore: 15, cutNormal: 8, cutBorder: 6 },
         { key: 'k1', id: CS.dims[1].id, name: '疏离感', itemCount: 2, direction: 'higher_worse', maxScore: 10, cutNormal: 6, cutBorder: 8 }],
  items: [
    { dimId: 'k0', type: 'normal', title: '我觉得自己是班级的一份子', options: ['完全不符合','不太符合','一般','比较符合','完全符合'], scoreText: '1,2,3,4,5' },
    { dimId: 'k0', type: 'normal', title: '同学会叫上我一起玩', options: ['完全不符合','不太符合','一般','比较符合','完全符合'], scoreText: '1,2,3,4,5' },
    { dimId: 'k0', type: 'normal', title: '我喜欢我的学校', options: ['完全不符合','不太符合','一般','比较符合','完全符合'], scoreText: '1,2,3,4,5' },
    { dimId: 'k1', type: 'normal', title: '我觉得自己在班里是多余的', options: ['完全不符合','不太符合','一般','比较符合','完全符合'], scoreText: '1,2,3,4,5' },
    { dimId: 'k1', type: 'normal', title: '我常常想换个班级', options: ['完全不符合','不太符合','一般','比较符合','完全符合'], scoreText: '1,2,3,4,5' },
    { dimId: '', type: 'validity', title: '我从来没有撒过谎', options: ['完全不符合','不太符合','一般','比较符合','完全符合'], scoreText: '1,2,3,4,5' },
  ],
}, TOK));
check('保存维度与题目', r.body.ok === true && r.body.items === 6, JSON.stringify(r.body));

r = await call('/api/admin/scale-items?scaleId=' + CSID, G(TOK));
const CITEMS = r.body;
check('题目可读回', CITEMS.length === 6);
check('分值串映射正确', CITEMS[0].scoreMap && CITEMS[0].scoreMap['完全符合'] === 5,
  JSON.stringify(CITEMS[0].scoreMap));
check('维度归属正确', CITEMS.filter(i => i.dimId === CS.dims[0].id).length === 3);
check('效度题不挂维度', CITEMS.filter(i => i.type === 'validity')[0].dimId === null);

r = await call('/api/admin/scales', G(TOK));
const CS2 = r.body.find(x => x.code === 'BELONG');
check('有题后变为可用', CS2.usable === true && CS2.itemImported === 6, 'usable=' + CS2.usable + ' 题数=' + CS2.itemImported);

// 修改内置量表（改临界值 + 改题）
const mhtId = SCALES.find(s => s.code === 'MHT').id;
const mhtDims = SCALES.find(s => s.code === 'MHT').dims;
r = await call('/api/admin/scale', J('PUT', {
  id: mhtId, name: '心理健康诊断测验（MHT·校订）', code: 'MHT',
  responseType: 'binary', gradeRange: '4-6', scoringNote: '本校临界值',
  dims: mhtDims.map((d, i) => ({ key: 'k' + i, id: d.id, name: d.name,
    itemCount: d.itemCount, direction: d.direction, maxScore: d.maxScore,
    cutNormal: 7, cutBorder: 9 })),
}, TOK));
check('可修改内置量表临界值', r.body.ok === true, r.body.message || '');
r = await call('/api/admin/scales', G(TOK));
const M2 = r.body.find(x => x.code === 'MHT');
check('临界值已生效', M2.dims.every(d => d.cutNormal === 7 && d.cutBorder === 9),
  M2.dims[0].cutNormal + '/' + M2.dims[0].cutBorder);
check('改名生效', M2.name.includes('校订'));
check('内置量表题目未被清空', M2.itemImported === 100, M2.itemImported + ' 题');

// 内置量表不允许删除
r = await call('/api/admin/scale?id=' + mhtId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + TOK } });
check('内置量表禁止删除', r.body.ok === false, r.body.message || '');

// 自建量表可删除
r = await call('/api/admin/scale?id=' + CSID, { method: 'DELETE', headers: { Authorization: 'Bearer ' + TOK } });
check('自建量表可删除', r.body.ok === true, r.body.message || '');
r = await call('/api/admin/scales', G(TOK));
check('删除后从库里消失', !r.body.find(x => x.code === 'BELONG'));

// 代号重复校验
await call('/api/admin/scale', J('POST', { name: '测试', code: 'TEST1' }, TOK));
r = await call('/api/admin/scale', J('POST', { name: '测试2', code: 'TEST1' }, TOK));
check('代号重复被拒绝', r.body.ok === false, r.body.message || '');

// ---------- 18. 第二批量表（16 个）----------
console.log('\n── 第二批量表 ──');
r = await call('/api/admin/scales', G(TOK));
const ALL = r.body;
const BY = {}; ALL.forEach(x => { BY[x.code] = x; });
const EXPECT = {
  PHCSS: 80, TAS: 27, RSCA: 30, CTQ: 28, ASLEC: 27, SLSS: 25, SCSQ: 20,
  DSRSC: 18, PSSM: 18, PSSS: 12, 'BULLY-D': 12, MPU: 12, SASC: 10,
  RSES: 10, GSES: 10, CHS: 6,
};
let allOk = true, detail = [];
for (const [code, n] of Object.entries(EXPECT)) {
  const sc = BY[code];
  const ok = sc && sc.itemImported === n && sc.usable === true;
  if (!ok) { allOk = false; detail.push(`${code}:${sc ? sc.itemImported : '缺失'}/${n}`); }
}
check('16 个新量表全部载入完整题目', allOk, detail.length ? detail.join(' ') : '全部正确');
check('第二批题数合计 345', Object.entries(EXPECT).reduce((a, [c]) => a + BY[c].itemImported, 0) === 345,
  Object.entries(EXPECT).reduce((a, [c]) => a + BY[c].itemImported, 0) + ' 题');

// 反向题
check('PHCSS 含 47 道反向题',
  (await call('/api/admin/scale-items?scaleId=phcss', G(TOK))).body.filter(i => i.reverse).length === 47);
check('RSES 含 5 道反向题',
  (await call('/api/admin/scale-items?scaleId=rses', G(TOK))).body.filter(i => i.reverse).length === 5);
check('DSRSC 含 7 道反向题',
  (await call('/api/admin/scale-items?scaleId=dsrsc', G(TOK))).body.filter(i => i.reverse).length === 7);

// 风险题（字符串 ! 前缀，本轮新增的通用机制）
r = await call('/api/admin/scale-items?scaleId=ctq', G(TOK));
check('CTQ 标出 4 道风险题', r.body.filter(i => i.type === 'risk').length === 4,
  r.body.filter(i => i.type === 'risk').length + ' 道');
check('CTQ 含 3 道掩饰效度题', r.body.filter(i => i.type === 'validity').length === 3);
r = await call('/api/admin/scale-items?scaleId=dsrsc', G(TOK));
check('DSRSC 标出 1 道自伤风险题', r.body.filter(i => i.type === 'risk').length === 1);

// 方向：越高越好
check('RSES 维度方向为越高越好',
  BY.RSES.dims.every(d => d.direction === 'higher_better'));
check('GSES 维度方向为越高越好',
  BY.GSES.dims.every(d => d.direction === 'higher_better'));
check('PHCSS 6 个维度', BY.PHCSS.dims.length === 6,
  BY.PHCSS.dims.map(d => d.name).join('/'));
check('PSSS 采用七级计分',
  (await call('/api/admin/scale-items?scaleId=psss', G(TOK))).body[0].options.length === 7);

// ---- 实测量表：RSES 低分（自尊低）应被判为需关注 ----
console.log('\n── 越高越好量表实测（RSES）──');
const rsesPid = (await call('/api/admin/plan', J('POST', {
  title: '自尊水平普查', term: '2026春', gradeScope: ['五年级'], scaleIds: ['rses'],
  startAt: '2020-01-01', endAt: '2099-12-31', anonymous: false,
}, TOK))).body.id;
await call('/api/admin/plan', J('PUT', { id: rsesPid, status: 'open', title: '自尊水平普查',
  gradeScope: ['五年级'], scaleIds: ['rses'], startAt: '2020-01-01', endAt: '2099-12-31' }, TOK));
const rDet = await call('/api/plan/detail?id=' + rsesPid);
check('RSES 普查可取到 10 题', rDet.body.items.length === 10, rDet.body.items.length + ' 题');

// 真实低自尊作答：正向题选最低、反向题选最高（反转后贡献低分）
// 不能全选同一选项——那样会被规律作答检测判为无效卷
const pickByContribution = (items, wantLow) => items.map(it => {
  const opts = it.options, sm = it.scoreMap || {};
  const nums = opts.map(o => Number(sm[o])).filter(n => !isNaN(n));
  const hi = Math.max(...nums), lo = Math.min(...nums);
  const target = it.reverse ? (wantLow ? hi : lo) : (wantLow ? lo : hi);
  let best = opts[0];
  for (const o of opts) if (Number(sm[o]) === target) best = o;
  return { itemId: it.id, value: best };
});
const lowAns = pickByContribution(rDet.body.items, true);
check('低自尊作答选项有变化（非规律作答）',
  new Set(lowAns.map(a => a.value)).size >= 2,
  [...new Set(lowAns.map(a => a.value))].join('/'));
r = await call('/api/submit', J('POST', { planId: rsesPid, name: '低自尊同学',
  grade: '五年级', className: '1班', startedAt: new Date(Date.now() - 200000).toISOString(),
  durationSec: 200, answers: lowAns }));
check('低自尊被判为需关注/需访谈', r.body.valid === true
  && ['watch', 'interview'].includes(r.body.suggested), r.body.suggested);

// 高自尊：正向题选最高、反向题选最低
const highAns = pickByContribution(rDet.body.items, false);
r = await call('/api/submit', J('POST', { planId: rsesPid, name: '高自尊同学',
  grade: '五年级', className: '1班', startedAt: new Date(Date.now() - 200000).toISOString(),
  durationSec: 200, answers: highAns }));
check('高自尊判为正常', r.body.valid === true && r.body.suggested === 'normal', r.body.suggested);

// ---- 实测量表：CTQ 风险题触发危机预警 ----
console.log('\n── 风险题危机预警（CTQ）──');
const ctqPid = (await call('/api/admin/plan', J('POST', {
  title: '创伤筛查', term: '2026春', gradeScope: ['六年级'], scaleIds: ['ctq'],
  startAt: '2020-01-01', endAt: '2099-12-31', anonymous: true,
}, TOK))).body.id;
await call('/api/admin/plan', J('PUT', { id: ctqPid, status: 'open', title: '创伤筛查',
  gradeScope: ['六年级'], scaleIds: ['ctq'], startAt: '2020-01-01', endAt: '2099-12-31',
  anonymous: true }, TOK));
const cDet = await call('/api/plan/detail?id=' + ctqPid);
check('CTQ 普查可取到 28 题', cDet.body.items.length === 28, cDet.body.items.length + ' 题');
// 风险题选最高分，其他选最低
const rkAns = cDet.body.items.map(it => {
  const opts = it.options, sm = it.scoreMap || {};
  let mx = opts[0], mn = opts[0];
  for (const o of opts) {
    if (Number(sm[o]) > Number(sm[mx])) mx = o;
    if (Number(sm[o]) < Number(sm[mn])) mn = o;
  }
  return { itemId: it.id, value: it.type === 'risk' ? mx : mn };
});
r = await call('/api/submit', J('POST', { planId: ctqPid, name: '', grade: '', className: '',
  startedAt: new Date(Date.now() - 300000).toISOString(), durationSec: 300, answers: rkAns }));
check('CTQ 可提交', r.body.ok === true, JSON.stringify(r.body).slice(0, 80));
r = await call('/api/admin/screenings?planId=' + ctqPid, G(TOK));
check('风险题触发危机标记', r.body.some(x => x.riskFlag === true),
  JSON.stringify(r.body.map(x => ({ n: x.name, f: x.riskFlag }))));

// ---------- 19. 性能：缓存一致性与查询次数 ----------
console.log('\n── 性能优化：缓存一致性 ──');

// ① 改量表后必须立刻能在列表里看到（缓存不能返回旧数据）
r = await call('/api/admin/scales', G(TOK));
const before = (r.body.find(x => x.code === 'MHT') || {}).name;
r = await call('/api/admin/scale', J('PUT', {
  id: 'mht', name: 'MHT-改名验证' + Date.now(), code: 'MHT',
  responseType: 'binary', gradeRange: '4-6',
  dims: SCALES.find(x => x.code === 'MHT').dims.map((d, i) => ({
    key: 'k' + i, id: d.id, name: d.name, itemCount: d.itemCount,
    direction: d.direction, maxScore: d.maxScore, cutNormal: d.cutNormal, cutBorder: d.cutBorder })),
}, TOK));
check('修改内置量表成功', r.body.ok === true);
r = await call('/api/admin/scales', G(TOK));
const after = (r.body.find(x => x.code === 'MHT') || {}).name;
check('★ 改完立刻能看到新数据（缓存已失效）', after !== before && /改名验证/.test(after),
  after || '(空)');

// ② 新建量表后立刻出现在列表
const nc = 'NEW' + String(Date.now()).slice(-5);
r = await call('/api/admin/scale', J('POST', { name: '新建验证量表', code: nc }, TOK));
const newId = r.body.id;
r = await call('/api/admin/scales', G(TOK));
check('★ 新建量表立刻可见', !!r.body.find(x => x.code === nc),
  r.body.filter(x => x.code === nc).length + ' 个');

// ③ 删除后立刻消失
await call('/api/admin/scale?id=' + newId, { method: 'DELETE', headers: { Authorization: 'Bearer ' + TOK } });
r = await call('/api/admin/scales', G(TOK));
check('★ 删除后立刻消失', !r.body.find(x => x.code === nc));

// ④ 改普查状态后，学生端立刻能看到（题目缓存失效）
const cPid = (await call('/api/admin/plan', J('POST', {
  title: '缓存验证普查', gradeScope: ['四年级'], scaleIds: ['rses'],
  startAt: '2020-01-01', endAt: '2099-12-31' }, TOK))).body.id;
await call('/api/admin/plan', J('PUT', { id: cPid, status: 'open', title: '缓存验证普查',
  gradeScope: ['四年级'], scaleIds: ['rses'],
  startAt: '2020-01-01', endAt: '2099-12-31' }, TOK));
r = await call('/api/plan/detail?id=' + cPid);
check('开放后学生端可取到题目', r.body.items && r.body.items.length === 10,
  (r.body.items || []).length + ' 题');
// 改成草稿 → 学生端应立刻拒绝
await call('/api/admin/plan', J('PUT', { id: cPid, status: 'draft', title: '缓存验证普查',
  gradeScope: ['四年级'], scaleIds: ['rses'],
  startAt: '2020-01-01', endAt: '2099-12-31' }, TOK));
r = await call('/api/plan/detail?id=' + cPid);
check('★ 关闭后学生端立刻被拒（缓存已失效）',
  r.body.ok === false && /未开放/.test(r.body.message || ''), r.body.message || '');

// ⑤ 学生提交后教师端立刻可见（筛查名单不缓存）
await call('/api/admin/plan', J('PUT', { id: cPid, status: 'open', title: '缓存验证普查',
  gradeScope: ['四年级'], scaleIds: ['rses'],
  startAt: '2020-01-01', endAt: '2099-12-31' }, TOK));
const cd = await call('/api/plan/detail?id=' + cPid);
const cAns = cd.body.items.map(it => ({ itemId: it.id, value: it.options[it.options.length - 1] }));
await call('/api/submit', J('POST', { planId: cPid, name: '缓存测试', grade: '四年级',
  className: '9班', startedAt: new Date(Date.now() - 200000).toISOString(),
  durationSec: 200, answers: cAns }));
r = await call('/api/admin/screenings?planId=' + cPid, G(TOK));
check('★ 提交后教师端立刻可见', r.body.length === 1, r.body.length + ' 条');

console.log('\n==========================================');
console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
console.log('==========================================');
process.exit(fail ? 1 : 0);
