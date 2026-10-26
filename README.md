# 学校心理健康筛查与干预管理平台

面向武汉市光谷第二十六小学的校内心理健康工作平台，部署于 Cloudflare Workers + D1。

## 一句话概览

- **24 个内置量表、669 道题**，开箱即用
- **六步工作流**：普查计划 → 阳性筛查 → 访谈复核 → 建档干预 → 定期复测 → 转介/结案
- **通用问卷调查**：八种题型 + 图形化编辑器
- **自建量表**：可创建、可修改，内置量表也能改

## 目录

```
├── worker.js            服务端（Cloudflare Worker）
├── scale-items.js       内置题库第一批（8 个量表）
├── scale-items2.js      内置题库第二批（16 个量表）
├── schema.sql           D1 建表（14 张表）
├── wrangler.toml        部署配置（需填 database_id）
├── public/
│   ├── index.html       学生端
│   ├── admin.html       教师管理端
│   └── setup.html       数据库初始化页
├── serve.mjs            本地预览服务（内存数据库）
├── test-worker.mjs      逻辑测试（122 项）
├── e2e*.py              浏览器端到端测试（135 项）
├── 部署指南.md          完整部署与使用说明
└── 预览截图/
```

## 四步上线

```bash
npm install
npx wrangler login
npm run db:create    # 复制 database_id 填进 wrangler.toml
npm run db:init
npm run deploy
```

## 本地预览（不用部署）

```bash
node serve.mjs
# 学生端 http://127.0.0.1:8792/
# 教师端 http://127.0.0.1:8792/admin   密码 gg26x
```

## 测试

```bash
npm test              # 122 项逻辑测试
bash run-e2e-all.sh   # 135 项浏览器测试
```

## 重要提示

1. **默认密码 gg26x 必须改**：`npx wrangler secret put TEACHER_PASSWORD`
2. **必须用 D1，不能用 KV**：KV 免费层每天仅 1000 次写入，1449 名学生提交会超限
3. **量表题目需核对**：题目按公开维度结构整理，正式施测前建议与正版手册校对
4. **CTQ 属敏感量表**：建议仅在访谈发现线索后单独施测，不宜纳入全员普查

详见《部署指南.md》。
