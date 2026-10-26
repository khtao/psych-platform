/** 本地预览：挂载 Worker 逻辑 + 内存 D1 + 真实页面。node serve.mjs [端口] */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import worker from './worker.js';
import { makeDB, makeAssets } from './mock.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const files = {
  'index.html': fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8'),
  'admin.html': fs.readFileSync(path.join(ROOT, 'public/admin.html'), 'utf8'),
  'setup.html': fs.readFileSync(path.join(ROOT, 'public/setup.html'), 'utf8'),
};
const env = { DB: makeDB(), ASSETS: makeAssets(files), TEACHER_PASSWORD: 'gg26x' };
const PORT = Number(process.argv[2]) || 8792;

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request('http://127.0.0.1:' + PORT + req.url, {
    method: req.method, headers: req.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
  try {
    const out = await worker.fetch(request, env, {});
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) { console.error('[错误]', e); res.writeHead(500); res.end('server error'); }
}).listen(PORT, '127.0.0.1', () => {
  console.log('==========================================');
  console.log('  心理健康平台 · 本地预览');
  console.log('==========================================');
  console.log(`  学生端:   http://127.0.0.1:${PORT}/`);
  console.log(`  教师后台: http://127.0.0.1:${PORT}/admin`);
  console.log(`  初始化:   http://127.0.0.1:${PORT}/setup`);
  console.log(`  默认密码: gg26x`);
  console.log('  ⚠️ 数据存内存，重启清空（仅供预览/测试）\n');
});
