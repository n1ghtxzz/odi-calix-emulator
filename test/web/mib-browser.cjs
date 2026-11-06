const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const stage = root;
const out = path.join(root, 'test/web/results');
fs.mkdirSync(out,{recursive:true});
const assets = path.join(root,'web');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'localization/mib-catalog.json')));
const { blocks } = require('./fixtures.cjs');
const requests = [];
const failures = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/login') {
    let body='';req.on('data',chunk => body+=chunk);req.on('end',() => {
      const form=new URLSearchParams(body);
      global.loginPayloadVerified=form.get('user')==='example-admin'&&form.get('password')==='example-password';
      res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'invalid credentials'}));
    });return;
  }
  if (url.pathname === '/api/omci') {
    requests.push({ method: req.method, params: Object.fromEntries(url.searchParams) });
    assert.equal(url.searchParams.get('cmd'), 'me');
    const cls = Number(url.searchParams.get('me'));
    const entity = url.searchParams.get('entity');
    const rows = blocks.filter(x => x.cls === cls && (!entity || x.id === parseInt(entity.replace(/^0x/i, ''), 16)));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, raw: rows.map(x => x.lines.join('\n')).join('\n')+'\n'+rows.length+' rows\n', truncated: false }));
  }
  const mode = url.pathname.startsWith('/before/') ? 'before' : 'after';
  const name = path.basename(url.pathname);
  if (name === 'test.html') {
    let html = fs.readFileSync(mode==='after'?path.join(stage,'web/index.html'):path.join(__dirname,'fixtures/index-before.html'), 'utf8');
    html = html.replace('<script type="module" src="/app.js"></script>', `<script type="module">
      const panel = document.getElementById('o-mib');
      document.body.replaceChildren(document.querySelector('header.top'),panel); panel.hidden = false;
      ${mode==='after'?"const { initUiLanguage } = await import('./login.js'); initUiLanguage();":''}
      const { renderMeBrowser, CATALOG } = await import('./mebrowser.js');
      window.testCatalog = CATALOG;
      await renderMeBrowser(); window.testReady = true;
    </script>`);
    assert(html.includes('window.testReady = true'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  const replacement=path.join(stage,'web',name);
  const file = mode==='before'&&name==='mebrowser.js'?path.join(__dirname,'fixtures/mebrowser-before.js'):fs.existsSync(replacement)?replacement:path.join(assets,name);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html')?'text/html':'text/plain' });
  res.end(fs.readFileSync(file));
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:'+server.address().port;
  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),
    headless: true, args: ['--disable-background-networking', '--no-first-run'],
  });
  const checks = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => localStorage.setItem('odi-language','en'));
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => failures.push(error.message));
    await page.goto(origin+'/before/test.html');
    await page.waitForFunction(() => window.testReady === true);
    const before = await page.evaluate(() => window.testCatalog.map(x => ({ id: x.classId, name: x.name })));
    assert.equal(before.length, 82);
    assert(!before.some(x => x.id === 65311));
    assert.equal(before.find(x => x.id === 65282).name, 'PrivateMcastTag');
    checks.push('negative control reproduces missing 65311 and wrong 65282 label in R6');

    await page.goto(origin+'/after/test.html');
    await page.waitForFunction(() => window.testReady === true);
    const catalog = await page.evaluate(() => window.testCatalog);
    assert.equal(catalog.length, 106);
    assert.equal(new Set(catalog.map(x => x.classId)).size, 106);
    assert.deepEqual(catalog.map(x => x.classId), catalog.map(x => x.classId).sort((a,b) => a-b));
    for (const cls of new Set(blocks.map(x => x.cls))) assert(catalog.some(x => x.classId === cls), 'active MIB class missing: '+cls);
    checks.push('106 unique sorted classes cover all synthetic MIB fixture classes');
    assert.equal(await page.locator('#me-tables-list > button').count(), 106);

    await page.locator('#me-filter').fill('Calix');
    assert.equal(await page.locator('#me-tables-list > button').count(), 10);
    checks.push('search Calix shows all ten added or corrected profile models');
    for (const [id, name] of Object.entries(manifest.calix_models)) {
      await page.locator('#me-filter').fill(id);
      const table = page.locator('#me-tables-list > button');
      assert.equal(await table.count(), 1);
      assert((await table.innerText()).includes(name), 'wrong label for '+id);
      await table.click();
      await page.waitForFunction(() => document.querySelector('#me-entities-list > button') !== null);
      assert((await page.locator('#me-entities-src').innerText()).startsWith('omcicli mib get '+id));
      assert(!(await page.locator('#me-entities-src').innerText()).includes('which the device calls'), 'catalog/backend mismatch '+id);
      assert((await page.locator('#me-attrs-body').innerText()).length > 0);
      checks.push('read '+id+' '+name+' renders synthetic attributes through numeric API');
    }

    await page.locator('#me-filter').fill('');
    await page.locator('#me-classid').fill('65311');
    await page.locator('#me-entity').fill('0101');
    await page.locator('#me-go').click();
    await page.waitForFunction(() => document.querySelector('#me-entities-src').textContent === 'omcicli mib get 65311 0101');
    await page.waitForFunction(() => document.querySelector('#me-attrs-body').textContent.includes('IfHCInOctets'));
    assert.equal(await page.locator('#me-entities-list > button').count(), 1);
    await page.locator('#me-view-raw').click();
    assert((await page.locator('#me-attrs-body').innerText()).includes('65311 EthernetUniHCExt 257'));
    await page.locator('#me-view-parsed').click();
    checks.push('manual lookup uses hex entity 0101; parsed/raw modes retain the correct 257 instance');

    await page.locator('#me-classid').fill('EthernetUniHCExt');
    await page.locator('#me-entity').fill('');
    await page.locator('#me-go').click();
    await page.waitForFunction(() => document.querySelectorAll('#me-entities-list > button').length === 5);
    checks.push('lookup by new daemon name resolves to numeric 65311 and all five logical instances');

    await page.locator('#me-count').click();
    await page.waitForFunction(() => document.querySelector('#me-status').textContent === 'Counted all 106 tables.', { timeout: 30000 });
    checks.push('Count entities visits all 106 classes without stopping on valid empty tables');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#me-filter').fill('Calix');
    await page.evaluate(() => { document.querySelector('#me-browser').dataset.pane = 'tables'; });
    assert.equal(await page.locator('#me-tables-list > button').count(), 10);
    await page.evaluate(() => scrollTo(0,0));
    await page.screenshot({ path: path.join(out, 'mib-browser-mobile.png'), fullPage: true });
    checks.push('mobile viewport renders ten Calix rows');

    const ruContext=await browser.newContext({viewport:{width:390,height:844}});
    await ruContext.route('**/*',route => route.request().url().startsWith(origin)?route.continue():route.abort());
    const ruPage=await ruContext.newPage();
    ruPage.on('pageerror',error => failures.push(error.message));
    await ruPage.goto(origin+'/after/test.html');await ruPage.waitForFunction(() => window.testReady===true);
    await ruPage.waitForFunction(() => document.querySelector('#tab-status').textContent==='Состояние');
    assert.equal(await ruPage.locator('#language-select').inputValue(),'ru');
    assert.equal(await ruPage.locator('#me-go').innerText(),'Прочитать');
    assert.equal(await ruPage.locator('html').getAttribute('lang'),'ru');
    checks.push('Russian defaults on first visit; top selector and static/dynamic labels translate');
    await ruPage.locator('#me-classid').fill('65311');await ruPage.locator('#me-entity').fill('0101');
    const requestCount=requests.length;
    await ruPage.locator('#language-select').selectOption('en');
    await ruPage.waitForFunction(() => document.querySelector('#tab-status').textContent==='Status');
    assert.equal(await ruPage.locator('#me-classid').inputValue(),'65311');
    assert.equal(await ruPage.locator('#me-entity').inputValue(),'0101');
    assert.equal(requests.length,requestCount);
    await ruPage.reload();await ruPage.waitForFunction(() => window.testReady===true);
    assert.equal(await ruPage.locator('#language-select').inputValue(),'en');
    assert.equal(await ruPage.locator('#me-go').innerText(),'Read');
    checks.push('language choice persists after reload; switching preserves entered values and issues no device API writes');
    await ruPage.locator('#language-select').selectOption('ru');
    await ruPage.locator('#me-filter').fill('счётчики');
    assert((await ruPage.locator('#me-tables-list > button').count())>=1);
    await ruPage.locator('#me-tables-list > button').filter({hasText:'EthernetUniHCExt'}).click();
    await ruPage.waitForFunction(() => document.querySelector('#me-attrs-body').textContent.includes('IfHCInOctets'));
    assert((await ruPage.locator('#me-tables-list .mib-sub').allTextContents()).includes('EthernetUniHCExt'));
    await ruPage.locator('#me-entities-list > button').first().click();
    await ruPage.locator('#me-view-raw').click();
    assert((await ruPage.locator('#me-attrs-body').innerText()).includes('65311 EthernetUniHCExt 257'));
    checks.push('Russian search finds counters; daemon names, schema keys and raw MIB data remain exact');
    await ruPage.locator('#me-filter').fill('');
    await ruPage.locator('#me-classid').fill('7');await ruPage.locator('#me-entity').fill('0000');
    await ruPage.locator('#me-go').click();
    await ruPage.locator('#me-entities-list > button').filter({hasText:'0000'}).click();
    await ruPage.locator('#me-view-parsed').click();
    await ruPage.waitForFunction(()=>document.querySelector('#me-attrs-body').textContent.includes('Version'));
    assert((await ruPage.locator('#me-attrs-body .me-kv dt').allTextContents()).includes('Version'));
    assert(!(await ruPage.locator('#me-attrs-body .me-kv dt').allTextContents()).includes('Версия'));
    checks.push('parsed MIB attribute identifiers stay English, including Version which is localized only as a UI label');
    await ruPage.evaluate(() => {
      const fixture=document.createElement('div');fixture.id='language-test-fixture';
      fixture.innerHTML='<input id="test-unsaved" value="192.168.2.1"><select id="test-enum"><option>Enabled</option><option value="0">Disabled</option></select><pre id="test-raw">Status</pre><code id="test-code">Password</code><span id="test-dynamic"></span>';
      document.body.append(fixture);document.querySelector('#test-dynamic').textContent='Counting entities: 7 of 106 tables read…';
    });
    await ruPage.waitForFunction(() => document.querySelector('#test-dynamic').textContent==='Подсчёт экземпляров: прочитано таблиц 7 из 106…');
    assert.equal(await ruPage.locator('#test-enum').inputValue(),'Enabled');
    assert.equal(await ruPage.locator('#test-enum option').first().innerText(),'Включено');
    assert.equal(await ruPage.locator('#test-raw').innerText(),'Status');
    assert.equal(await ruPage.locator('#test-code').innerText(),'Password');
    await ruPage.locator('#language-select').selectOption('en');
    await ruPage.waitForFunction(() => document.querySelector('#test-dynamic').textContent==='Counting entities: 7 of 106 tables read…');
    assert.equal(await ruPage.locator('#test-enum').inputValue(),'Enabled');
    assert.equal(await ruPage.locator('#test-unsaved').inputValue(),'192.168.2.1');
    checks.push('dynamic messages translate both ways; implicit option values, inputs and raw/code blocks stay unchanged');
    await ruPage.locator('#language-select').selectOption('ru');
    await ruPage.locator('#me-filter').fill('Calix');
    await ruPage.evaluate(() => {document.querySelector('#me-browser').dataset.pane='tables';document.querySelector('#language-test-fixture').remove();});
    assert(await ruPage.evaluate(() => document.documentElement.scrollWidth<=innerWidth));
    await ruPage.evaluate(() => scrollTo(0,0));
    await ruPage.screenshot({path:path.join(out,'mib-browser-mobile-ru.png'),fullPage:true});
    checks.push('Russian mobile layout fits 390px without horizontal page overflow');
    await ruPage.goto(origin+'/after/login.html');
    await ruPage.waitForFunction(() => document.querySelector('#signin-go').textContent==='Войти');
    await ruPage.locator('#user').fill('example-admin');await ruPage.locator('#pass').fill('example-password');
    await ruPage.locator('#language-select').selectOption('en');
    await ruPage.waitForFunction(() => document.querySelector('#signin-go').textContent==='Sign in');
    assert.equal(await ruPage.locator('#pass').inputValue(),'example-password');
    await ruPage.locator('#language-select').selectOption('ru');
    await ruPage.locator('#signin-go').click();
    await ruPage.waitForFunction(() => document.querySelector('#signin-msg').textContent==='Неверное имя пользователя или пароль.');
    assert.equal(global.loginPayloadVerified,true);
    await ruPage.screenshot({path:path.join(out,'login-mobile-ru.png'),fullPage:true});
    checks.push('unauthenticated login selector, translated errors and original form POST payload work');
    await ruContext.close();
    assert.equal(failures.length, 0, failures.join('\n'));
    assert(requests.every(x => x.method === 'GET' && /^\d+$/.test(x.params.me)));
    checks.push('all API requests are read-only numeric GET; no table enumeration or settings writes');
    fs.writeFileSync(path.join(out, 'browser-verification.json'), JSON.stringify({
      passed: true, engine: 'headless Chromium 1243', sources: 'release UI modules plus pre-catalog negative control',
      data: 'synthetic MIB fixture, no owner data; API fixture, no live device access',
      catalog_count: 106, languages:['ru','en'], default_language:'ru', checks, api_requests: requests.length, javascript_errors: failures,
      hardware_tested: false,
    }, null, 2)+'\n');
    console.log(JSON.stringify({ passed: true, checks: checks.length, catalog_count: 106, api_requests: requests.length }));
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
}
main().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
