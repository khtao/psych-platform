"""生成 24 个量表库的截图"""
import json, urllib.request
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8792'

def api(p, d=None, t=None, method=None):
    h = {'Content-Type': 'application/json'}
    if t: h['Authorization'] = 'Bearer ' + t
    b = json.dumps(d).encode() if d is not None else None
    r = urllib.request.Request(BASE + p, data=b, headers=h, method=method or ('POST' if d is not None else 'GET'))
    resp = urllib.request.urlopen(r, timeout=60)
    ct = resp.headers.get('content-type') or ''
    return json.loads(resp.read()) if 'json' in ct else resp.read().decode()

tok = api('/api/auth', {'password': 'gg26x'})['token']
scales = [s for s in api('/api/admin/scales', None, tok, 'GET') if s.get('builtin')]
print(f'内置量表 {len(scales)} 个，共 {sum(s["itemImported"] for s in scales)} 题')

with sync_playwright() as p:
    br = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    pg = br.new_page(viewport={'width': 1200, 'height': 1000}, device_scale_factor=1.5)
    pg.goto(BASE + '/admin', wait_until='networkidle')
    pg.fill('#pwd', 'gg26x')
    pg.locator('button:has-text("登录")').click()
    pg.wait_for_timeout(2500)
    pg.locator('.flow-step:has-text("量表库")').click()
    pg.wait_for_timeout(2500)
    # 展开全部（滚动一点，露出更多卡片）
    pg.screenshot(path='/tmp/s_all.png', full_page=False)
    pg.evaluate("()=>window.scrollTo(0, 420)")
    pg.wait_for_timeout(400)
    pg.screenshot(path='/tmp/s_all2.png')
    br.close()
print('截图完成')
