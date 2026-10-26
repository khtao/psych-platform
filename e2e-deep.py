"""深度端到端：
1. 回归「新建问卷 → 点编辑题目」（用户报的 bug）
2. 自建量表完整流程
3. 修改内置量表（改临界值 + 改题目）
4. 用自建量表发起普查并计分验证
5. 全流程巡检：每个标签页、每个按钮
"""
import json, urllib.request, datetime
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8792'

def api(p, data=None, token=None, method=None):
    h = {'Content-Type': 'application/json'}
    if token: h['Authorization'] = 'Bearer ' + token
    b = json.dumps(data).encode() if data is not None else None
    m = method or ('POST' if data is not None else 'GET')
    r = urllib.request.Request(BASE + p, data=b, headers=h, method=m)
    resp = urllib.request.urlopen(r, timeout=12)
    ct = resp.headers.get('content-type') or ''
    return json.loads(resp.read()) if 'json' in ct else resp.read().decode()

tok = api('/api/auth', {'password': 'gg26x'})['token']
today = datetime.date.today()

pass_n = fail_n = 0
def check(name, ok, extra=''):
    global pass_n, fail_n
    print(f"  {'✅' if ok else '❌'} {name}{'  ' + extra if extra else ''}")
    if ok: pass_n += 1
    else: fail_n += 1

with sync_playwright() as p:
    br = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = br.new_context(viewport={'width': 1300, 'height': 950})
    errs = []
    def hook(tag):
        def f(e): errs.append(f'{tag}: {e.message}')
        return f

    ad = ctx.new_page()
    ad.on('pageerror', hook('admin'))
    ad.on('console', lambda m: errs.append('admin-console: ' + m.text) if m.type == 'error' else None)
    ad.goto(BASE + '/admin', wait_until='networkidle')
    ad.fill('#pwd', 'gg26x')
    ad.locator('button:has-text("登录")').click()
    ad.wait_for_timeout(2200)
    check('教师登录', ad.locator('#panel').is_visible())

    # ==================== 1. 回归：新建问卷 → 编辑题目 ====================
    print('\n── 回归：新建问卷后点「编辑题目」──')
    ad.locator('.flow-step:has-text("问卷调查")').click()
    ad.wait_for_timeout(1200)

    DQ = []
    def on_dlg(d):
        try:
            if DQ: d.accept(DQ.pop(0))
            else: d.dismiss()
        except Exception: pass
    ad.on('dialog', on_dlg)
    DQ.append('作业负担调查')
    ad.locator('button:has-text("新建问卷")').click()
    ad.wait_for_timeout(2400)
    check('新建后编辑器自动打开', ad.locator('#svTitle').count() > 0)
    # 关闭弹窗，回到列表
    ad.evaluate('closeModal()'); ad.wait_for_timeout(800)

    # 关键：从列表点「编辑题目」
    n_before = ad.locator('#boxSurveys .item').count()
    check('列表里已有新建的问卷', n_before >= 1, f'{n_before} 份')
    ad.locator('#boxSurveys .item button:has-text("编辑题目")').first.click()
    ad.wait_for_timeout(1600)
    opened = ad.locator('#svTitle').count() > 0
    check('★ 点「编辑题目」能打开编辑器', opened,
          '' if opened else '仍然无效 —— 说明 editSurvey 未修复')

    if opened:
        # 加题并保存，验证功能连贯
        ad.locator('.addq button:has-text("单选题")').click(); ad.wait_for_timeout(300)
        ad.locator('.addq button:has-text("多行问答")').click(); ad.wait_for_timeout(300)
        ad.fill('#qt_0', '你觉得作业多吗？')
        ad.fill('#qo_0', '很多\n比较多\n一般\n不多')
        ad.fill('#qt_1', '你想对老师说些什么？')
        check('编辑器可加题改题', ad.locator('#qCount').inner_text() == '2')
        ad.locator('.modal button:has-text("保存")').click()
        ad.wait_for_timeout(1800)
        check('保存成功', '已保存' in ad.locator('#toast').inner_text(),
              ad.locator('#toast').inner_text())
        ad.locator('#boxSurveys .item button:has-text("编辑题目")').first.click()
        ad.wait_for_timeout(1500)
        check('再次打开题目还在', ad.locator('#qt_0').count() > 0
              and ad.locator('#qt_0').input_value() == '你觉得作业多吗？',
              ad.locator('#qt_0').input_value() if ad.locator('#qt_0').count() else 'none')
        check('题目数量保持', ad.locator('#qCount').inner_text() == '2')
        ad.evaluate('closeModal()'); ad.wait_for_timeout(600)
    else:
        check('编辑器可加题改题', False, '跳过')
        check('保存成功', False, '跳过')
        check('再次打开题目还在', False, '跳过')
        check('题目数量保持', False, '跳过')

    # 开放作业负担调查，让学生端能看到
    surveys = api('/api/admin/surveys', token=tok)
    zy = next((x for x in surveys if '作业负担' in x['title']), None)
    if zy:
        api('/api/admin/survey', {'id': zy['id'], 'status': 'open', 'title': zy['title'],
            'description': zy.get('description', '')}, tok, method='PUT')
        check('问卷可开放', True)

    # ==================== 2. 自建量表 ====================
    print('\n── 自建量表 ──')
    ad.locator('.flow-step:has-text("量表库")').click()
    ad.wait_for_timeout(1500)
    check('量表库有「自建量表」按钮', ad.locator('button:has-text("自建量表")').count() > 0)
    n_edit = ad.locator('#boxScales button:has-text("编辑量表")').count()
    check('每个量表有「编辑量表」', n_edit >= 8, f'{n_edit} 个')

    DQ.extend(['校园归属感问卷', 'BELONG'])
    ad.locator('button:has-text("自建量表")').click()
    ad.wait_for_timeout(2800)
    check('自建量表编辑器打开', ad.locator('#scName').count() > 0)
    check('默认 1 个维度', ad.locator('#scDimCount').inner_text() == '1')

    # 填维度
    ad.fill('#sDn_0', '归属感')
    ad.fill('#sDm_0', '15')
    ad.select_option('#sDd_0', 'higher_better')
    ad.fill('#sDcn_0', '8')
    ad.fill('#sDcb_0', '6')
    # 加第二个维度
    ad.locator('button:has-text("加维度")').click(); ad.wait_for_timeout(400)
    ad.fill('#sDn_1', '疏离感')
    ad.fill('#sDm_1', '10')
    ad.fill('#sDcn_1', '6')
    ad.fill('#sDcb_1', '8')
    check('可加到 2 个维度', ad.locator('#scDimCount').inner_text() == '2')

    # 加题：3 普通 + 1 效度
    for _ in range(3):
        ad.locator('button:has-text("普通题")').click(); ad.wait_for_timeout(250)
    ad.locator('button:has-text("效度题")').click(); ad.wait_for_timeout(400)
    check('可加 4 道题', ad.locator('#scItemCount').inner_text() == '4')

    titles = ['我觉得自己是班级的一份子', '同学会叫上我一起玩', '我喜欢我的学校', '我从来没有撒过谎']
    for i, t in enumerate(titles):
        ad.fill(f'#sIt_{i}', t)
    # 第 4 题（效度题）不挂维度
    ad.select_option('#sId_3', '')
    ad.wait_for_timeout(300)
    check('选项自动生成', '完全不符合' in (ad.locator('#sIo_0').input_value() or ''),
          (ad.locator('#sIo_0').input_value() or '').split('\n')[0])
    check('分值默认已填', (ad.locator('#sIs_0').input_value() or '') == '1,2,3,4,5',
          ad.locator('#sIs_0').input_value())

    ad.locator('.modal button:has-text("保存")').click()
    ad.wait_for_timeout(2400)
    tmsg = ad.locator('#toast').inner_text()
    check('量表保存成功', '已保存' in tmsg, tmsg)

    scales = api('/api/admin/scales', token=tok)
    cs = next((x for x in scales if x['code'] == 'BELONG'), None)
    check('后端已创建自建量表', cs is not None)
    if cs:
        check('2 个维度写入', cs['dims'] and len(cs['dims']) == 2,
              '/'.join(d['name'] for d in cs['dims']))
        check('临界值写入', cs['dims'][0]['cutNormal'] == 8 and cs['dims'][0]['cutBorder'] == 6,
              f"{cs['dims'][0]['cutNormal']}/{cs['dims'][0]['cutBorder']}")
        check('方向为越高越好', cs['dims'][0]['direction'] == 'higher_better')
        check('4 道题写入', cs['itemImported'] == 4, f"{cs['itemImported']} 题")
        check('自建量表可用', cs['usable'] is True)
    items = api('/api/admin/scale-items?scaleId=' + cs['id'], token=tok) if cs else []
    check('分值串解析正确', items and items[0]['scoreMap'].get('完全符合') == 5,
          json.dumps(items[0]['scoreMap'], ensure_ascii=False) if items else '')
    check('效度题不挂维度', items and items[3]['type'] == 'validity' and items[3]['dimId'] is None)

    # 重开编辑器验证回显
    ad.locator('#boxScales .item:has-text("校园归属感问卷") button:has-text("编辑量表")').first.click()
    ad.wait_for_timeout(2000)
    check('重开编辑器维度回显', ad.locator('#sDn_0').count() > 0
          and ad.locator('#sDn_0').input_value() == '归属感',
          ad.locator('#sDn_0').input_value() if ad.locator('#sDn_0').count() else '')
    check('重开编辑器题目回显', ad.locator('#sIt_0').count() > 0
          and ad.locator('#sIt_0').input_value() == '我觉得自己是班级的一份子')
    check('重开维度数正确', ad.locator('#scDimCount').inner_text() == '2')
    check('重开题目数正确', ad.locator('#scItemCount').inner_text() == '4')
    ad.evaluate('closeModal()'); ad.wait_for_timeout(600)

    # ==================== 3. 修改内置量表 ====================
    print('\n── 修改内置量表（MHT）──')
    ad.locator('#boxScales .item:has-text("心理健康诊断测验") button:has-text("编辑量表")').first.click()
    ad.wait_for_timeout(2600)
    check('内置量表编辑器可打开', ad.locator('#scName').count() > 0)
    check('内置量表载入 100 题', ad.locator('#scItemCount').inner_text() == '100',
          ad.locator('#scItemCount').inner_text())
    check('内置量表载入 8 维度', ad.locator('#scDimCount').inner_text() == '8',
          ad.locator('#scDimCount').inner_text())
    if ad.locator('#sIt_0').count():
        check('题目内容回显', '考试' in ad.locator('#sIt_0').input_value(),
              ad.locator('#sIt_0').input_value()[:16])
        check('选项回显为 是/否',
              (ad.locator('#sIo_0').input_value() or '').replace('\n', '/') == '是/否',
              (ad.locator('#sIo_0').input_value() or '').replace('\n', '/'))
        check('分值回显 1,0', (ad.locator('#sIs_0').input_value() or '') == '1,0',
              ad.locator('#sIs_0').input_value())
    # 改临界值
    ad.fill('#sDcn_0', '7'); ad.fill('#sDcb_0', '9')
    ad.locator('.modal button:has-text("保存")').click()
    ad.wait_for_timeout(2600)
    check('内置量表可保存', '已保存' in ad.locator('#toast').inner_text(),
          ad.locator('#toast').inner_text())
    scales = api('/api/admin/scales', token=tok)
    mht = next(x for x in scales if x['code'] == 'MHT')
    check('临界值已改', mht['dims'][0]['cutNormal'] == 7 and mht['dims'][0]['cutBorder'] == 9,
          f"{mht['dims'][0]['cutNormal']}/{mht['dims'][0]['cutBorder']}")
    check('改维度后题目数不变', mht['itemImported'] == 100, f"{mht['itemImported']} 题")

    # 内置量表删除按钮不存在
    trash_sel = '#boxScales .item button:has-text("\U0001F5D1")'
    n_builtin_trash = ad.locator('#boxScales .item').filter(has_text='心理健康诊断测验').locator('button:has-text("\U0001F5D1")').count()
    n_custom_trash = ad.locator('#boxScales .item').filter(has_text='校园归属感问卷').locator('button:has-text("\U0001F5D1")').count()
    check('内置量表无删除按钮', n_builtin_trash == 0, f'{n_builtin_trash} 个')
    check('自建量表有删除按钮', n_custom_trash > 0, f'{n_custom_trash} 个')

    # ==================== 4. 用自建量表发起普查 ====================
    print('\n── 自建量表实测：发起普查并计分 ──')
    pid = api('/api/admin/plan', {
        'title': '校园归属感普查', 'term': '2026春', 'gradeScope': ['四年级'],
        'scaleIds': [cs['id']],
        'startAt': str(today - datetime.timedelta(days=1)),
        'endAt': str(today + datetime.timedelta(days=7))}, tok)['id']
    api('/api/admin/plan', {'id': pid, 'status': 'open', 'title': '校园归属感普查',
        'term': '2026春', 'gradeScope': ['四年级'], 'scaleIds': [cs['id']],
        'startAt': str(today - datetime.timedelta(days=1)),
        'endAt': str(today + datetime.timedelta(days=7))}, tok, method='PUT')
    det = json.loads(urllib.request.urlopen(BASE + '/api/plan/detail?id=' + pid, timeout=10).read())
    check('自建量表可用于普查', det.get('ok') is not False and len(det['items']) == 4,
          f"{len(det.get('items', []))} 题")

    # 高分学生（归属感低 → 疏离感高）
    ans = []
    for it in det['items']:
        if it['type'] == 'validity':
            ans.append({'itemId': it['id'], 'value': '完全不符合'})
        elif '多余' in it['title'] or '换个班级' in it['title']:
            ans.append({'itemId': it['id'], 'value': '完全符合'})
        else:
            ans.append({'itemId': it['id'], 'value': '完全不符合'})
    r = api('/api/submit', {'planId': pid, 'name': '测试同学', 'grade': '四年级',
        'className': '3班', 'gender': '男', 'startedAt': datetime.datetime.now().isoformat(),
        'durationSec': 200, 'answers': ans})
    check('自建量表可提交', r.get('ok') is True, r.get('invalidReason', ''))
    check('计分生效（判为需关注/访谈）', r.get('suggested') in ('watch', 'interview'),
          r.get('suggested'))
    scr = api('/api/admin/screenings?planId=' + pid, token=tok)
    check('生成筛查记录', len(scr) == 1)

    # ==================== 5. 全流程巡检 ====================
    print('\n── 全流程巡检 ──')
    steps = ['普查计划', '筛查名单', '访谈复核', '建档干预', '复测提醒', '转介/结案',
             '量表库', '报告', '问卷调查']
    for st in steps:
        loc = ad.locator(f'.flow-step:has-text("{st}")')
        if loc.count() == 0:
            check(f'标签 {st} 存在', False); continue
        loc.first.click(); ad.wait_for_timeout(900)
        box_id = {'普查计划':'boxPlans','筛查名单':'boxScreen','访谈复核':'boxInterview',
                  '建档干预':'boxCases','复测提醒':'boxRetest','转介/结案':'boxClosure',
                  '量表库':'boxScales','报告':'boxReport','问卷调查':'boxSurveys'}[st]
        vis = ad.locator('#' + box_id).is_visible()
        txt = ad.locator('#' + box_id).inner_text()[:40].replace('\n', ' ')
        check(f'「{st}」可打开且内容正常', vis, txt)

    # 学生端巡检
    print('\n── 学生端巡检 ──')
    stp = ctx.new_page()
    stp.on('pageerror', hook('student'))
    stp.goto(BASE + '/', wait_until='networkidle'); stp.wait_for_timeout(1000)
    b = stp.inner_text('body')
    check('首页显示保密承诺', '只有心理老师能看到' in b)
    check('显示心理普查区', '心理普查' in b)
    check('显示问卷调查区', '问卷调查' in b)
    check('列出归属感和作业负担两项',
          '校园归属感普查' in b and '作业负担调查' in b)

    # 打开自建量表普查
    stp.locator('.item:has-text("校园归属感普查")').first.click()
    stp.wait_for_timeout(1000)
    check('自建量表普查可作答', stp.locator('.q-block').count() == 4,
          f"{stp.locator('.q-block').count()} 题")
    check('选项渲染正确', '完全符合' in stp.inner_text('body'))

    print('\n── JS 错误 ──')
    real = [e for e in errs if 'favicon' not in e.lower()]
    check('无 JS 错误', len(real) == 0, ' | '.join(real[:3]))
    br.close()

print('\n==========================================')
print(f'  通过 {pass_n} 项，失败 {fail_n} 项')
print('==========================================')
