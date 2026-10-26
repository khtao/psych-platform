#!/bin/bash
# 全量端到端回归：每个套件前重启服务，保证数据干净
cd /data/workspace/psych-platform

run_one () {
  f="$1"
  pkill -f "node serve.mjs" >/dev/null 2>&1
  sleep 1
  nohup node serve.mjs 8792 > "/tmp/srv_${f}.log" 2>&1 &
  sleep 5
  # 预热：触发量表播种 + 建表
  TOK=$(curl -s -m 30 -X POST http://127.0.0.1:8792/api/auth \
        -H 'Content-Type: application/json' -d '{"password":"gg26x"}' \
        | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' 2>/dev/null)
  curl -s -m 60 http://127.0.0.1:8792/api/admin/scales -H "Authorization: Bearer $TOK" -o /dev/null
  echo "=== $f ==="
  timeout 250 python3 "$f" 2>&1 | grep -E "通过 |❌" | tail -5
}

for f in e2e.py e2e-scales.py e2e-survey.py e2e-deep.py; do
  run_one "$f"
done
pkill -f "node serve.mjs" >/dev/null 2>&1
echo "全部完成"
