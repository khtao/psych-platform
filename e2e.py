"""端到端：真实 Chromium 走一遍「教师建普查 → 学生作答 → 筛查 → 访谈 → 建档 → 报告」"""
import json, urllib.request, datetime, time
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8792'

def api(p, data=None, token=None, method=None):
    h = {'Content-Type': 'application/json'}
    if token: h['Authorization'] = 'Bearer ' + token
    b = json.dumps(data).encode() if data is not None else None
    m = method or ('POST' if data is not None else 'GET')
    r = urllib.request.Request(BASE + p, data=b, headers=h, method=m)
    resp = urllib.request.urlopen(r, timeout=10)
    ct = resp.headers.get('content-type') or ''
    return json.loads(resp.read()) if 'json' in ct else resp.read().decode()

# ---------- 准备：导入题目 ----------
tok = api('/api/auth', {'password': 'gg26x'})['token']
items = []
for i in range(12):
    items.append({'title': f'第{i+1}题：最近我常常有这种感觉',
                  'dimId': 'k0',
                  'options': ['不符合', '有点符合', '完全符合'],
                  'scoreMap': {'不符合': 0, '有点符合': 1, '完全符合': 2}})
items.append({'title': '[V]我从来没有说过谎', 'type': 'validity',
              'options': ['不符合', '有点符合', '完全符合'],
              'scoreMap': {'不符合': 0, '有点符合': 0, '完全符合': 1}})
# 用自建量表施测，避免覆盖内置 MHT 题库（会影响其它测试套件）
# 代号带时间戳，保证同一服务实例上可重复运行
_TEST_CODE = 'E2E' + str(int(time.time()))[-6:]
SCALE_ID = api('/api/admin/scale', {'name': '测试用量表', 'code': _TEST_CODE}, tok)['id']
api('/api/admin/scale', {'id': SCALE_ID, 'name': '测试用量表', 'code': _TEST_CODE,
    'responseType': 'binary', 'gradeRange': '4-6',
    'dims': [{'key': 'k0', 'id': 'e2e_d0', 'name': '焦虑', 'itemCount': 12,
              'direction': 'higher_worse', 'maxScore': 12, 'cutNormal': 5, 'cutBorder': 8}],
    'items': items}, tok, method='PUT')

today = datetime.date.today()
pid = api('/api/admin/plan', {
    'title': '2026学年春季心理健康普查', 'term': '2026春',
    'gradeScope': ['四年级'], 'scaleIds': [SCALE_ID],
    'startAt': str(today - datetime.timedelta(days=1)),
    'endAt': str(today + datetime.timedelta(days=7)),
    'notice': '同学你好，请按真实想法作答',
}, tok)['id']
api('/api/admin/plan', {'id': pid, 'status': 'open', 'title': '2026学年春季心理健康普查',
    'gradeScope': ['四年级'], 'scaleIds': [SCALE_ID],
    'startAt': str(today - datetime.timedelta(days=1)),
    'endAt': str(today + datetime.timedelta(days=7))}, tok, method='PUT')
print('已准备：13 道题（含 1 道效度题）+ 1 份开放中的普查\n')

pass_n = fail_n = 0
def check(name, ok, extra=''):
    global pass_n, fail_n
    print(f"  {'✅' if ok else '❌'} {name}{'  ' + extra if extra else ''}")
    if ok: pass_n += 1
    else: fail_n += 1

with sync_playwright() as p:
    br = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = br.new_context(viewport={'width': 1280, 'height': 900})
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(e.message))

    # ==================== 学生端 ====================
    print('── 学生端 ──')
    page.goto(BASE + '/', wait_until='networkidle')
    page.wait_for_timeout(700)
    body = page.inner_text('body')
    check('首页顶部显示保密承诺', '只有心理老师能看到' in body)
    check('列出普查', '2026学年春季心理健康普查' in body)

    # 精确定位本套件创建的普查，避免点到服务里残留的其它条目
    page.locator('.item:has-text("2026学年春季心理健康普查")').first.click()
    page.wait_for_timeout(1000)
    check('进入作答页', page.locator('#sName').count() > 0)

    page.fill('#sName', '张小明')
    page.select_option('#sGrade', '四年级')
    page.fill('#sClass', '3班')

    # 内容题：多数"完全符合"（高分），效度题（最后一道）选"不符合"
    blocks = page.locator('.q-block')
    n = blocks.count()
    check('渲染 13 道题', n == 13, f'{n} 道')
    for i in range(n):
        b = blocks.nth(i)
        opts = b.locator('.opt')
        # 最后一道是效度题 → 选"不符合"（诚实作答）
        want = '不符合' if i == n - 1 else ('有点符合' if i % 4 == 0 else '完全符合')
        # 找到含该文字的选项
        found = False
        for j in range(opts.count()):
            if want in opts.nth(j).inner_text():
                opts.nth(j).click(); found = True; break
        if not found:
            opts.nth(0).click()
        page.wait_for_timeout(60)

    prog = page.locator('.ptext').inner_text()
    check('进度条满', '13 / 13' in prog, prog)

    page.locator('#btnSub').click()
    page.wait_for_timeout(1600)
    done = page.locator('#doneBox').inner_text()
    check('提交成功', '提交成功' in done, done.split('\n')[1] if '\n' in done else done[:24])

    # ==================== 教师端 ====================
    print('\n── 教师端 ──')
    p2 = ctx.new_page()
    errs2 = []
    p2.on('pageerror', lambda e: errs2.append(e.message))
    p2.goto(BASE + '/admin', wait_until='networkidle')
    p2.fill('#pwd', 'gg26x')
    p2.locator('button:has-text("登录")').click()
    p2.wait_for_timeout(1800)
    check('教师登录成功', p2.locator('#panel').is_visible())

    # 工作流导航条
    flow = p2.inner_text('.flow')
    for step in ['普查计划', '筛查名单', '访谈复核', '建档干预', '复测提醒', '转介']:
        if step not in flow:
            check(f'工作流含「{step}」', False); break
    else:
        check('工作流六步齐全', True)

    # 登录持久化：存入 localStorage
    ls = p2.evaluate("() => localStorage.getItem('psych_token')")
    check('token 已持久化到 localStorage', bool(ls))

    # 刷新后保持登录
    p2.reload(wait_until='networkidle')
    p2.wait_for_timeout(1800)
    check('刷新后仍保持登录（登录持久化）', p2.locator('#panel').is_visible())

    # 筛查名单
    p2.locator('.flow-step:has-text("筛查名单")').click()
    p2.wait_for_timeout(1500)
    scr = p2.locator('#boxScreen').inner_text()
    check('筛查名单显示学生', '张小明' in scr)
    check('显示分档概览', '需访谈' in scr or '正常' in scr)

    # 访谈
    p2.locator('#boxScreen button:has-text("访谈")').first.click()
    p2.wait_for_timeout(900)
    check('访谈弹窗打开', p2.locator('#ivConcl').count() > 0)
    check('含主诉/观察/风险评估字段',
          p2.locator('#ivChief').count() > 0 and p2.locator('#ivObs').count() > 0
          and p2.locator('#ivRisk').count() > 0)
    p2.fill('#ivTeacher', '李老师')
    p2.fill('#ivChief', '最近睡不好，担心考试')
    p2.fill('#ivObs', '情绪低落')
    p2.fill('#ivRisk', '无自伤意念')
    p2.select_option('#ivConcl', 'confirmed')
    p2.locator('button:has-text("确定")').click()
    p2.wait_for_timeout(1800)
    toast_txt = p2.locator('#toast').inner_text()
    check('访谈保存并自动建档', '自动建档' in toast_txt, toast_txt)

    # 个案档案
    p2.locator('.flow-step:has-text("建档干预")').click()
    p2.wait_for_timeout(1200)
    cases = p2.locator('#boxCases').inner_text()
    check('个案已建立', '张小明' in cases)

    # 复测提醒
    p2.locator('.flow-step:has-text("复测提醒")').click()
    p2.wait_for_timeout(1200)
    rt = p2.locator('#boxRetest').inner_text()
    check('复测提醒已生成', '张小明' in rt and '周' in rt)

    # 团体报告
    p2.locator('.flow-step:has-text("报告")').click()
    p2.wait_for_timeout(2000)
    rep = p2.locator('#boxReport').inner_text()
    check('团体报告有总体统计', '参与' in rep)
    check('团体报告有维度排序或班级', ('维度' in rep) or ('班' in rep))

    # 量表库
    p2.locator('.flow-step:has-text("量表库")').click()
    p2.wait_for_timeout(1200)
    sc = p2.locator('#boxScales').inner_text()
    check('量表库列出 MHT/SDQ', 'MHT' in sc and 'SDQ' in sc)
    check('量表库标注资质要求', '资质要求' in sc and '实名认证' in sc)

    # 改密码弹窗
    p2.locator('button:has-text("改密码")').click()
    p2.wait_for_timeout(700)
    check('改密码弹窗可打开', p2.locator('#op').count() > 0)
    p2.locator('button:has-text("取消")').click()

    print('\n── JS 错误 ──')
    check('学生端无 JS 错误', len(errs) == 0, ' | '.join(errs[:2]))
    check('教师端无 JS 错误', len(errs2) == 0, ' | '.join(errs2[:2]))

    br.close()

print('\n==========================================')
print(f'  通过 {pass_n} 项，失败 {fail_n} 项')
print('==========================================')
