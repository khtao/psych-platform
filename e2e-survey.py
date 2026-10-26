"""端到端：问卷图形化编辑器 + 学生作答 + 统计"""
import json, urllib.request, datetime
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

tok = api('/api/auth', {'password': 'gg26x'})['token']
today = datetime.date.today()
pid = api('/api/admin/plan', {
    'title': '2026学年春季心理健康普查', 'term': '2026春',
    'gradeScope': ['四年级'], 'scaleIds': ['mht'],
    'startAt': str(today - datetime.timedelta(days=1)),
    'endAt': str(today + datetime.timedelta(days=7)),
}, tok)['id']
api('/api/admin/plan', {'id': pid, 'status': 'open', 'title': '2026学年春季心理健康普查',
    'gradeScope': ['四年级'], 'scaleIds': ['mht'],
    'startAt': str(today - datetime.timedelta(days=1)),
    'endAt': str(today + datetime.timedelta(days=7))}, tok, method='PUT')

pass_n = fail_n = 0
def check(name, ok, extra=''):
    global pass_n, fail_n
    print(f"  {'✅' if ok else '❌'} {name}{'  ' + extra if extra else ''}")
    if ok: pass_n += 1
    else: fail_n += 1

with sync_playwright() as p:
    br = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = br.new_context(viewport={'width': 1280, 'height': 950})
    errs = []

    # ==================== 教师端：问卷编辑器 ====================
    print('── 教师端 · 问卷编辑器 ──')
    ad = ctx.new_page()
    ad.on('pageerror', lambda e: errs.append('admin: ' + e.message))
    ad.goto(BASE + '/admin', wait_until='networkidle')
    ad.fill('#pwd', 'gg26x')
    ad.locator('button:has-text("登录")').click()
    ad.wait_for_timeout(2200)
    check('教师登录', ad.locator('#panel').is_visible())

    ad.locator('.flow-step:has-text("问卷调查")').click()
    ad.wait_for_timeout(1200)
    check('问卷标签可切换', ad.locator('#boxSurveys').is_visible())

    ad.on('dialog', lambda d: d.accept('课后服务满意度调查'))
    ad.locator('button:has-text("新建问卷")').click()
    ad.wait_for_timeout(2000)
    if ad.locator('#svTitle').count() == 0:
        sid = api('/api/admin/survey', {'title': '课后服务满意度调查'}, tok)['id']
        ad.evaluate("async id => { await loadAll(); await openEditor(id); }", sid)
        ad.wait_for_timeout(1600)
    check('编辑器打开', ad.locator('#svTitle').count() > 0)

    ad.fill('#svTitle', '课后服务满意度调查')
    ad.fill('#svDesc', '了解同学对课后服务的真实想法')

    # 添加 8 种题型
    for t, label in [('single','单选题'),('multi','多选题'),('scale','量表题'),
                     ('rating','评分题'),('text','单行填空'),('textarea','多行问答'),
                     ('number','数字题'),('date','日期题')]:
        ad.locator(f'.addq button:has-text("{label}")').click()
        ad.wait_for_timeout(200)
    n_q = ad.locator('#qCount').inner_text()
    check('添加 8 种题型', n_q == '8', n_q + ' 题')
    check('题型徽标齐全', all(ad.locator('.qe-type').nth(i).count() > 0 for i in range(8)))

    # 填写题目
    titles = ['你最喜欢哪类课后服务？', '你参加过哪些？（可多选）', '我觉得课后服务很有帮助',
              '总体满意度', '你最喜欢的老师', '你的建议', '每周参加几次', '希望活动时间']
    for i, t in enumerate(titles):
        ad.fill(f'#qt_{i}', t)
    # 单选题选项
    ad.fill('#qo_0', '作业辅导\n体育活动\n艺术课程\n科普活动')
    ad.fill('#qo_1', '作业辅导\n体育活动\n艺术课程\n科普活动')
    ad.wait_for_timeout(300)
    check('选项可编辑', ad.locator('#qo_0').input_value().count('\n') == 3)

    # 上移 / 删除
    ad.locator('.qedit').nth(1).locator('button:has-text("↑")').click()
    ad.wait_for_timeout(400)
    check('题目可上移', ad.locator('#qt_0').input_value() == '你参加过哪些？（可多选）',
          ad.locator('#qt_0').input_value()[:12])
    ad.locator('.qedit').nth(7).locator('button:has-text("✕")').click()
    ad.wait_for_timeout(400)
    check('题目可删除', ad.locator('#qCount').inner_text() == '7')

    ad.locator('.modal button:has-text("保存")').click()
    ad.wait_for_timeout(1800)
    check('保存成功', '已保存' in ad.locator('#toast').inner_text(),
          ad.locator('#toast').inner_text())

    # 开放
    ad.locator('#boxSurveys .item button:has-text("开放")').first.click()
    ad.wait_for_timeout(1500)
    check('问卷开放', ad.locator('#boxSurveys').inner_text().count('进行中') >= 1)
    sv_txt = ad.locator('#boxSurveys').inner_text()
    check('列表显示题数', '❓ 7 题' in sv_txt, (ad.locator('#boxSurveys .imeta').first.inner_text() or '')[:30])

    # ==================== 学生端：填写问卷 ====================
    print('\n── 学生端 · 填写问卷 ──')
    st = ctx.new_page()
    st.on('pageerror', lambda e: errs.append('student: ' + e.message))
    st.goto(BASE + '/', wait_until='networkidle')
    st.wait_for_timeout(1000)
    body = st.inner_text('body')
    check('同时显示心理普查', '心理普查' in body)
    check('同时显示问卷调查', '问卷调查' in body)

    st.locator('.item:has-text("课后服务满意度调查")').first.click()
    st.wait_for_timeout(900)
    check('进入问卷填写', st.locator('#sName').count() > 0)
    st.fill('#sName', '张小明')
    st.select_option('#sGrade', '四年级')
    st.fill('#sClass', '3班')

    blocks = st.locator('.q-block')
    n = blocks.count()
    check('渲染 7 题', n == 7, f'{n} 题')

    # 第 0 题是多选题（上移后），选两个
    blocks.nth(0).locator('.opt').nth(0).click(); st.wait_for_timeout(150)
    blocks.nth(0).locator('.opt').nth(1).click(); st.wait_for_timeout(150)
    check('多选题可多选', '已选 2 项' in blocks.nth(0).inner_text(),
          blocks.nth(0).inner_text().split('\n')[-1])
    # 第 1 题是单选题
    blocks.nth(1).locator('.opt').nth(0).click(); st.wait_for_timeout(150)
    # 量表题
    blocks.nth(2).locator('.opt').nth(4).click(); st.wait_for_timeout(150)
    # 评分题
    blocks.nth(3).locator('.star').nth(4).click(); st.wait_for_timeout(150)
    check('评分题可选', '你选了 5 分' in blocks.nth(3).inner_text())
    # 填空 / 问答 / 数字
    blocks.nth(4).locator('.qinput').fill('李老师')
    blocks.nth(5).locator('.qinput').fill('希望多些体育活动')
    blocks.nth(6).locator('.qinput').fill('3')
    st.wait_for_timeout(300)

    prog = st.locator('.ptext').first.inner_text()
    check('进度更新', '7 / 7' in prog, prog)

    st.locator('#btnSub').click()
    st.wait_for_timeout(1800)
    check('问卷提交成功', '提交成功' in st.locator('#doneBox').inner_text())

    # 心理普查仍可作答
    st.goto(BASE + '/', wait_until='networkidle'); st.wait_for_timeout(900)
    st.locator('.item:has-text("2026学年春季心理健康普查")').first.click()
    st.wait_for_timeout(1200)
    check('普查独立可用', st.locator('.q-block').count() == 100,
          f'{st.locator(".q-block").count()} 题')

    # ==================== 统计 ====================
    print('\n── 教师端 · 统计 ──')
    ad.reload(wait_until='networkidle'); ad.wait_for_timeout(2200)
    ad.locator('.flow-step:has-text("问卷调查")').click(); ad.wait_for_timeout(1200)
    ad.locator('#boxSurveys button:has-text("统计")').first.click()
    ad.wait_for_timeout(1500)
    stat = ad.locator('.modal').inner_text()
    check('统计弹窗打开', '份答卷' in stat, stat.split('\n')[0][:40])
    check('单选分布已出图', '作业辅导' in stat)
    check('多选题计数', '体育活动' in stat)
    check('评分平均分', '平均分' in stat)
    check('填空原文汇总', '李老师' in stat)
    check('问答原文汇总', '希望多些体育活动' in stat)

    print('\n── JS 错误 ──')
    check('无 JS 错误', len(errs) == 0, ' | '.join(errs[:3]))

    ad.locator('.modal button:has-text("保存")').click() if ad.locator('.modal button:has-text("保存")').count() else None
    br.close()

print('\n==========================================')
print(f'  通过 {pass_n} 项，失败 {fail_n} 项')
print('==========================================')
