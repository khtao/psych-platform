"""端到端：24 个量表在真实浏览器中的可用性
- 量表库列出 24 个
- 随机抽查其中 6 个：打开编辑器、题目数正确、选项渲染正确
- 用两个新量表发起普查并在学生端作答
"""
import json, urllib.request, random
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8792'

def api(p, data=None, token=None, method=None):
    h = {'Content-Type': 'application/json'}
    if token: h['Authorization'] = 'Bearer ' + token
    b = json.dumps(data).encode() if data is not None else None
    m = method or ('POST' if data is not None else 'GET')
    r = urllib.request.Request(BASE + p, data=b, headers=h, method=m)
    resp = urllib.request.urlopen(r, timeout=15)
    ct = resp.headers.get('content-type') or ''
    return json.loads(resp.read()) if 'json' in ct else resp.read().decode()

tok = api('/api/auth', {'password': 'gg26x'})['token']


def seed_all():
    for _ in range(200):
        d = api('/api/seed?limit=150', None, tok, 'GET')
        if d.get('done') or d.get('remaining') == 0:
            return


seed_all()
scales = [x for x in api('/api/admin/scales', token=tok) if x.get('builtin')]

pass_n = fail_n = 0
def check(name, ok, extra=''):
    global pass_n, fail_n
    print(f"  {'✅' if ok else '❌'} {name}{'  ' + extra if extra else ''}")
    if ok: pass_n += 1
    else: fail_n += 1

print(f'── 量表库：共 {len(scales)} 个 ──')
check('量表总数为 24', len(scales) == 24, f'{len(scales)} 个')
check('全部已载入题目', all(s['usable'] for s in scales),
      f"{sum(1 for s in scales if s['usable'])}/{len(scales)}")
total_items = sum(s['itemImported'] for s in scales)
check('题目总数 669', total_items == 669, f'{total_items} 题')

by_code = {s['code']: s for s in scales}
print('\n  各量表题数：')
for s in scales:
    print(f"    {s['code']:<9} {s['itemImported']:>3} 题  {s['shortName']}")

with sync_playwright() as p:
    br = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = br.new_context(viewport={'width': 1280, 'height': 950})
    errs = []
    ad = ctx.new_page()
    ad.on('pageerror', lambda e: errs.append('admin: ' + e.message))
    ad.on('console', lambda m: errs.append('console: ' + m.text) if m.type == 'error' else None)
    ad.goto(BASE + '/admin', wait_until='networkidle')
    ad.fill('#pwd', 'gg26x')
    ad.locator('button:has-text("登录")').click()
    ad.wait_for_timeout(2500)
    ad.locator('.flow-step:has-text("量表库")').click()
    ad.wait_for_timeout(1800)

    n_cards = ad.locator('#boxScales .item').count()
    check('量表库卡片不少于 24 张', n_cards >= 24, f'{n_cards} 张（含自建）')

    # 抽查 6 个新量表：编辑器回显
    print('\n── 抽查新量表编辑器回显 ──')
    samples = ['PHCSS', 'CTQ', 'DSRSC', 'PSSS', 'RSES', 'CHS']
    for code in samples:
        s = by_code.get(code)
        if not s:
            check(f'{code} 存在', False); continue
        ad.locator('#boxScales .item').filter(has_text=s['code']).first \
          .locator('button:has-text("编辑量表")').first.click()
        ad.wait_for_timeout(1500)
        cnt = ad.locator('#scItemCount').inner_text()
        ok = cnt == str(s['itemImported'])
        check(f"{code} 编辑器载入 {s['itemImported']} 题", ok, f'实际 {cnt} 题')
        if ok and ad.locator('#sIo_0').count():
            opts = (ad.locator('#sIo_0').input_value() or '').split('\n')
            n_opt = len([o for o in opts if o.strip()])
            exp = {'PHCSS': 2, 'CTQ': 5, 'DSRSC': 3, 'PSSS': 7, 'RSES': 4, 'CHS': 6}[code]
            check(f'{code} 选项数正确（{exp}）', n_opt == exp, f'{n_opt} 个')
        ad.evaluate('()=>closeModal()')
        ad.wait_for_timeout(500)

    # 用新量表发起普查 + 学生端作答
    print('\n── 新量表实测（PSSS 社会支持 · 七级）──')
    pid = api('/api/admin/plan', {'title': '社会支持调查', 'gradeScope': ['六年级'],
        'scaleIds': ['psss'], 'startAt': '2020-01-01', 'endAt': '2099-12-31'}, tok)['id']
    api('/api/admin/plan', {'id': pid, 'status': 'open', 'title': '社会支持调查',
        'gradeScope': ['六年级'], 'scaleIds': ['psss'],
        'startAt': '2020-01-01', 'endAt': '2099-12-31'}, tok, method='PUT')
    det = json.loads(urllib.request.urlopen(BASE + '/api/plan/detail?id=' + pid, timeout=10).read())
    check('PSSS 普查可取到 12 题', len(det['items']) == 12, f"{len(det['items'])} 题")

    st = ctx.new_page()
    st.on('pageerror', lambda e: errs.append('student: ' + e.message))
    st.goto(BASE + '/', wait_until='networkidle'); st.wait_for_timeout(1000)
    st.locator('.item:has-text("社会支持调查")').first.click()
    st.wait_for_timeout(1000)
    nq = st.locator('.q-block').count()
    check('学生端渲染 12 题', nq == 12, f'{nq} 题')
    n_opt = st.locator('.q-block').first.locator('.opt').count()
    check('七级选项全部渲染', n_opt == 7, f'{n_opt} 个选项')
    if n_opt:
        check('选项文字正确', '极不同意' in st.locator('.q-block').first.inner_text())

    # 作答并提交（选最低分 → 社会支持薄弱 → 应被判需关注）
    blocks = st.locator('.q-block')
    for i in range(min(12, nq)):
        blocks.nth(i).locator('.opt').nth(0).click()
        st.wait_for_timeout(60)
    st.fill('#sName', '测试同学')
    st.select_option('#sGrade', '六年级')
    st.fill('#sClass', '2班')
    st.wait_for_timeout(300)
    st.locator('#btnSub').click()
    st.wait_for_timeout(1800)
    done = st.inner_text('#doneBox')
    check('提交成功', '提交成功' in done)
    check('全选最低触发规律作答检测', '没有反映你的真实情况' in done or '规律' in done,
          '（12 题全选同一项，符合预期）')

    print('\n── JS 错误 ──')
    real = [e for e in errs if 'favicon' not in e.lower()]
    check('无 JS 错误', len(real) == 0, ' | '.join(real[:3]))
    br.close()

print('\n==========================================')
print(f'  通过 {pass_n} 项，失败 {fail_n} 项')
print('==========================================')
