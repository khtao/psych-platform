-- ============================================================
-- 学校心理健康筛查与干预管理平台 · D1 建表
-- 执行：npx wrangler d1 execute psych-db --file=./schema.sql
-- ============================================================

-- ========== 1. 量表库（存维度与规则档案，题目需授权后导入）==========
CREATE TABLE IF NOT EXISTS scales (
  id            TEXT PRIMARY KEY,
  code          TEXT,            -- MHT / SDQ / SCARED / CDI / LONELY / PEER / BULLY / AAT / CUSTOM
  name          TEXT NOT NULL,   -- 量表全称
  shortName     TEXT,            -- 简称
  itemCount     INTEGER,         -- 题目数
  responseType  TEXT,            -- binary(是否) / likert3 / likert5 / freq4
  gradeRange    TEXT,            -- 适用年级：如 "4-6"
  dimensionNote TEXT,            -- 维度说明
  scoringNote   TEXT,            -- 计分说明
  reliability   TEXT,            -- 信效度（公开数据）
  revision      TEXT,            -- 修订版本与年份
  copyright     TEXT,            -- free / need-auth / demo
  copyrightNote TEXT,            -- 版权说明
  normNote      TEXT,            -- 常模说明
  usable        INTEGER DEFAULT 0,  -- 0=需导入题目 1=可直接施测
  builtin       INTEGER DEFAULT 0,  -- 1=系统内置
  createdAt     TEXT,
  deleted       INTEGER DEFAULT 0
);

-- 量表维度（含分档临界值配置）
CREATE TABLE IF NOT EXISTS scale_dims (
  id          TEXT PRIMARY KEY,
  scaleId     TEXT NOT NULL,
  dimIndex    INTEGER NOT NULL,
  name        TEXT NOT NULL,      -- 维度名：如"学习焦虑"
  itemCount   INTEGER,            -- 该维度题目数
  direction   TEXT DEFAULT 'higher_worse',  -- higher_worse / higher_better
  maxScore    INTEGER,            -- 该维度满分
  cutNormal   INTEGER,            -- 正常/边缘分界
  cutBorder   INTEGER,            -- 边缘/异常分界
  note        TEXT
);

-- 量表题目（由学校取得授权后导入；内置示例量表可直接使用）
CREATE TABLE IF NOT EXISTS scale_items (
  id        TEXT PRIMARY KEY,
  scaleId   TEXT NOT NULL,
  dimId     TEXT,               -- 所属维度（效度题为NULL）
  itemIndex INTEGER NOT NULL,   -- 题号
  type      TEXT DEFAULT 'normal',  -- normal / validity（效度题）
  title     TEXT NOT NULL,
  options   TEXT,               -- JSON 数组
  reverse   INTEGER DEFAULT 0,  -- 是否反向计分
  scoreMap  TEXT                -- JSON：{ "不符合":0, "有点符合":1, "完全符合":2 }
);

-- ========== 2. 普查计划 ==========
CREATE TABLE IF NOT EXISTS plans (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,     -- 如"2026学年春季心理健康普查"
  term         TEXT,              -- 学期：2026春
  gradeScope   TEXT,              -- JSON 数组：["四年级","五年级"]
  classScope   TEXT,              -- JSON 数组或空（空=全部）
  scaleIds     TEXT,              -- JSON 数组：本计划使用的量表
  startAt      TEXT,              -- 作答窗口开始
  endAt        TEXT,              -- 作答窗口结束（限时）
  status       TEXT DEFAULT 'draft',  -- draft / open / closed
  anonymous    INTEGER DEFAULT 0, -- 是否匿名
  notice       TEXT,              -- 给学生看的说明（强调保密）
  createdAt    TEXT,
  deleted      INTEGER DEFAULT 0
);

-- ========== 3. 答卷（含效度标记）==========
CREATE TABLE IF NOT EXISTS responses (
  id           TEXT PRIMARY KEY,
  planId       TEXT NOT NULL,
  studentKey   TEXT,             -- 学生标识：姓名+班级（匿名时为空）
  name         TEXT,
  gender       TEXT,             -- 男/女（常模分性别）
  grade        TEXT,
  className    TEXT,
  answers      TEXT,             -- JSON 数组
  startedAt    TEXT,
  submittedAt  TEXT,
  durationSec  INTEGER,          -- 作答时长（秒）
  valid        INTEGER DEFAULT 1,-- 1=有效 0=无效需重测
  invalidReason TEXT,            -- 无效原因：效度题/时间过短/规律作答
  validityNote TEXT,             -- 详细说明
  scores       TEXT,             -- JSON：各维度原始分
  suggested    TEXT,             -- 系统建议档位：normal / watch / interview
  deleted      INTEGER DEFAULT 0,
  deletedAt    TEXT
);

-- ========== 4. 筛查结论（访谈后确认，含双轨分级）==========
CREATE TABLE IF NOT EXISTS screenings (
  id           TEXT PRIMARY KEY,
  responseId   TEXT NOT NULL,
  planId       TEXT NOT NULL,
  studentKey   TEXT,
  name         TEXT,
  grade        TEXT,
  className    TEXT,
  suggested    TEXT,             -- 系统建议：normal / watch / interview
  -- 操作分级（访谈前，量表驱动）
  opLevel      TEXT,             -- normal / watch / interview
  -- 响应分级（访谈后，双轨）
  respLevel    TEXT,             -- daily / focus / crisis（日常关注/重点关注/危机关注）
  -- 访谈确认结论（三选一）
  confirmed    TEXT,             -- confirmed / excluded / observing / pending
  confirmedBy  TEXT,
  confirmedAt  TEXT,
  riskFlag     INTEGER DEFAULT 0,-- 危机风险标记
  note         TEXT,
  updatedAt    TEXT
);

-- ========== 5. 访谈记录（结构化）==========
CREATE TABLE IF NOT EXISTS interviews (
  id           TEXT PRIMARY KEY,
  screeningId  TEXT NOT NULL,
  planId       TEXT,
  studentKey   TEXT,
  name         TEXT,
  grade        TEXT,
  className    TEXT,
  interviewedAt TEXT,
  teacher      TEXT,             -- 访谈心理老师
  chiefComplaint TEXT,           -- 主诉
  observation TEXT,              -- 观察
  riskAssessment TEXT,           -- 风险评估（含自伤自杀风险）
  conclusion   TEXT,             -- confirmed / excluded / observing
  conclusionNote TEXT,
  planText     TEXT,             -- 后续计划
  guardianNotify INTEGER DEFAULT 0,  -- 是否通知监护人
  createdAt    TEXT
);

-- ========== 6. 个案档案 ==========
CREATE TABLE IF NOT EXISTS cases (
  id           TEXT PRIMARY KEY,
  studentKey   TEXT NOT NULL,
  name         TEXT,
  grade        TEXT,
  className    TEXT,
  gender       TEXT,
  openedAt     TEXT,
  source       TEXT,             -- 来源：普查/教师转介/家长/自荐
  level        TEXT,             -- daily / focus / crisis
  mainIssues   TEXT,             -- 主要困扰维度（JSON数组）
  planText     TEXT,             -- 干预计划
  status       TEXT DEFAULT 'active',  -- active / closed / referred
  closedAt     TEXT,
  closeReason  TEXT,
  teacher      TEXT,
  updatedAt    TEXT
);

-- ========== 7. 干预记录 ==========
CREATE TABLE IF NOT EXISTS interventions (
  id         TEXT PRIMARY KEY,
  caseId     TEXT NOT NULL,
  date       TEXT,
  type       TEXT,              -- 个体辅导/团体辅导/家校沟通/环境调整
  content    TEXT,
  effect     TEXT,              -- 效果评估
  teacher    TEXT,
  createdAt  TEXT
);

-- ========== 8. 复测提醒 ==========
CREATE TABLE IF NOT EXISTS retests (
  id          TEXT PRIMARY KEY,
  caseId      TEXT NOT NULL,
  studentKey  TEXT,
  name        TEXT,
  grade       TEXT,
  className   TEXT,
  weeks       INTEGER DEFAULT 6,  -- 复测周期（4-8周）
  dueAt       TEXT,               -- 到期日
  status      TEXT DEFAULT 'pending',  -- pending / done / overdue
  baselinePlanId TEXT,            -- 前测计划
  doneAt      TEXT,
  donePlanId  TEXT,
  note        TEXT,
  createdAt   TEXT
);

-- ========== 9. 转介记录 ==========
CREATE TABLE IF NOT EXISTS referrals (
  id          TEXT PRIMARY KEY,
  caseId      TEXT NOT NULL,
  studentKey  TEXT,
  name        TEXT,
  grade       TEXT,
  className   TEXT,
  toOrg       TEXT,               -- 转介机构
  reason      TEXT,
  guardianConsent INTEGER DEFAULT 0,  -- 监护人同意
  referredAt  TEXT,
  feedback    TEXT,               -- 机构反馈
  feedbackAt  TEXT,
  teacher     TEXT,
  createdAt   TEXT
);

-- ========== 10. 结案记录 ==========
CREATE TABLE IF NOT EXISTS closures (
  id         TEXT PRIMARY KEY,
  caseId     TEXT NOT NULL,
  studentKey TEXT,
  name       TEXT,
  grade      TEXT,
  className  TEXT,
  reason     TEXT,                -- 结案原因分类
  reasonNote TEXT,
  summary    TEXT,
  closedAt   TEXT,
  teacher    TEXT,
  createdAt  TEXT
);

-- ========== 11. 系统设置（密码等）==========
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT,
  updatedAt TEXT
);

-- ========== 索引（D1 按扫描行数计费，必须有）==========
CREATE INDEX IF NOT EXISTS idx_dims_scale      ON scale_dims(scaleId, dimIndex);
CREATE INDEX IF NOT EXISTS idx_items_scale     ON scale_items(scaleId, itemIndex);
CREATE INDEX IF NOT EXISTS idx_plans_status    ON plans(status, deleted);
CREATE INDEX IF NOT EXISTS idx_resp_plan       ON responses(planId, deleted);
CREATE INDEX IF NOT EXISTS idx_resp_student    ON responses(studentKey);
CREATE INDEX IF NOT EXISTS idx_scr_plan        ON screenings(planId);
CREATE INDEX IF NOT EXISTS idx_scr_student     ON screenings(studentKey);
CREATE INDEX IF NOT EXISTS idx_scr_suggest     ON screenings(suggested);
CREATE INDEX IF NOT EXISTS idx_intv_scr        ON interviews(screeningId);
CREATE INDEX IF NOT EXISTS idx_cases_student   ON cases(studentKey);
CREATE INDEX IF NOT EXISTS idx_cases_status    ON cases(status);
CREATE INDEX IF NOT EXISTS idx_interv_case     ON interventions(caseId);
CREATE INDEX IF NOT EXISTS idx_retest_status   ON retests(status, dueAt);
CREATE INDEX IF NOT EXISTS idx_refer_case      ON referrals(caseId);
CREATE INDEX IF NOT EXISTS idx_close_case      ON closures(caseId);

-- ========== 12. 通用问卷调查 ==========
CREATE TABLE IF NOT EXISTS surveys (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  status TEXT DEFAULT 'draft', anonymous INTEGER DEFAULT 0,
  startAt TEXT, endAt TEXT, notice TEXT, createdAt TEXT, deleted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY, surveyId TEXT NOT NULL, qIndex INTEGER NOT NULL,
  type TEXT NOT NULL, title TEXT NOT NULL, required INTEGER DEFAULT 1,
  options TEXT, config TEXT
);

CREATE TABLE IF NOT EXISTS survey_responses (
  id TEXT PRIMARY KEY, surveyId TEXT NOT NULL, studentKey TEXT, name TEXT,
  grade TEXT, className TEXT, answers TEXT, startedAt TEXT, submittedAt TEXT,
  durationSec INTEGER, deleted INTEGER DEFAULT 0, deletedAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_surveys_status ON surveys(status, deleted);
CREATE INDEX IF NOT EXISTS idx_questions_survey ON questions(surveyId, qIndex);
CREATE INDEX IF NOT EXISTS idx_sresp_survey ON survey_responses(surveyId, deleted);
