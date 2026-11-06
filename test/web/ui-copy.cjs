const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'../..'),stage=root,out=path.join(root,'test/web/results');
fs.mkdirSync(out,{recursive:true});
const assets=path.join(root,'web');
function tsv(name){const lines=fs.readFileSync(path.join(assets,name),'utf8').split(/\r?\n/).filter(x=>x&&!x.startsWith('#'));const header=lines.shift().split('\t');return lines.map(x=>Object.fromEntries(x.split('\t').map((v,i)=>[header[i],v])));}
const schema=tsv('keys.tsv'),meta=tsv('meta.tsv'),settings=tsv('settings.tsv');
const values=Object.fromEntries(schema.map(x=>[x.name,'']));
Object.assign(values,{GPON_SN:'ABCD01234567',LAN_IP_ADDR:'192.168.2.1',LAN_SUBNET:'255.255.255.0',VLAN_CFG_TYPE:'1',VLAN_MANU_MODE:'1',VLAN_MANU_TAG_VID:'40',VLAN_MANU_TAG_PRI:'0',OMCI_POTS_PORTS:'1',NTP_SERVER:'192.0.2.1',OMCI_VEIP:'1',OMCI_CUSTOM_ME:'320'});
const fw={env:{sw_active:'1',sw_commit:'0',sw_tryactive:'2',sw_version0:'V1.0-220304',sw_version1:'V1.0-220304'},slots:{0:{kernel:'Linux Kernel Image 6.18',built:1793577600},1:{kernel:'Linux Kernel Image 6.18',built:1793577600}},build:{image:'odi-calix-ui-r8-1-20261106',built:'2026-11-06T12:00Z',ui:'v1.12.0',exporter:'v1.8.0'},confd:'v1.12.0',exe:'/bin/confd',switches:{'omci-identity.on':true},defaultauth:false};
const status='RTK.0> pon get transceiver rx-power\nRx power: -23.9\nRTK.0> pon get transceiver tx-power\nTx power: 2.02\nRTK.0> gpon get onu-state\nOperation State(O5)\nRTK.0> gpon get alarm-status\nLOS Alarm : clear\nRTK.0> pon get transceiver temperature\nTemperature: 38.6\nRTK.0> pon get transceiver voltage\nVoltage: 3.26\n';
const log='<4>rcS: pon step gponact: ret 0\n<4>rcS: pon steps done\n<6>odi_gpon: event=onu_state from=O4 to=O5\n<3>error: warn info Password Status Config\n<6>odi_wdt: alive\n';
const phone='port 0x0201 (voice CTP 0x0201)\nsip user 0x0201: aor registered, display name Status\nsip user login 0x0201: username Password, password warning, realm Config\nproxy 192.0.2.56\nregistrar 192.0.2.56\nport 5060/udp\nexpiry 3600 s\nvoice vlan 44 priority 6 (IP host 0x1)\nline status config done (14)\n';
const {blocks}=require('./fixtures.cjs');
const calls=[],errors=[];
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){
  calls.push({method:req.method,path:url.pathname,query:Object.fromEntries(url.searchParams)});
  assert.equal(req.method,'GET','page review must not mutate even the fixture');
  let data;
  const routes={'/api/schema':schema,'/api/meta':meta,'/api/settings':settings,'/api/values':values,'/api/consumers':tsv('consumers.tsv'),'/api/defaults':{},'/api/baseline':[],'/api/features':tsv('features.tsv'),'/api/firmware':fw,'/api/status':{raw:status,chip_temp:{input:66000,max:105000,crit:115000}},'/api/hostlink':{supported:false},'/api/netaddr':{supported:false},'/api/ntp':{now:1793973600,ntp:null},'/api/sshkeys':{keys:[]},'/api/log':{raw:log,truncated:false},'/api/voip':{ok:true,raw:phone},'/api/voip/status':{ports:[]}};
  if(url.pathname==='/api/omci'){
   const cls=Number(url.searchParams.get('me'));const rows=blocks.filter(x=>x.cls===cls);
   let raw=rows.map(x=>x.lines.join('\n')).join('\n')+'\n'+rows.length+' rows\n';
   // The live "me" command has vendor-rendered forms for these two classes;
   // the all-table capture above contains only their raw attribute bytes.
   // Exercise the vendor format with synthetic service VLAN 40/44 examples.
   if(cls===84)raw='XXXXXXXX\nVlanTagFilterData\nXXXXXXXX\nEntityID: 0x2401\nFilterTbl[0]: PRI 0, VID 40, TPID 0\n================\nEntityID: 0x50aa\nFilterTbl[0]: PRI 0, VID 44, TPID 0\n2 rows\n';
   if(cls===171)raw='XXXXXXXX\nExtVlanTagOperCfgData\nXXXXXXXX\nEntityId: 0x0101\nINDEX 0\nFilter inner: PRI 15, VID 4096, TPID 0\nTreatment inner: PRI 0, VID 40, TPID 0\n================\nEntityId: 0x40aa\nINDEX 0\nFilter inner: PRI 15, VID 4096, TPID 0\nTreatment inner: PRI 6, VID 44, TPID 0\n2 rows\n';
   data={ok:true,raw,truncated:false};
  }else data=routes[url.pathname];
  if(data===undefined){res.writeHead(404);return res.end(JSON.stringify({error:'fixture missing '+url.pathname}));}
  res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(data));
 }
 const name=path.basename(url.pathname==='/'?'index.html':url.pathname);
 const changed=path.join(stage,'web',name);const file=fs.existsSync(changed)?changed:path.join(assets,name);
 if(!fs.existsSync(file)){res.writeHead(404);return res.end();}
 res.writeHead(200,{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'text/plain'});res.end(fs.readFileSync(file));
});
async function main(){
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 const browser=await chromium.launch({...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),headless:true});
 const checks=[],views={},untranslated={};
 try{
  const context=await browser.newContext({viewport:{width:1916,height:1000},colorScheme:'dark'});
  await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  const page=await context.newPage();global.reviewPage=page;page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/#omci/services');
  await page.waitForFunction(()=>document.querySelectorAll('#services-cards .reading').length===0&&document.querySelectorAll('#services-cards .me-card').length===7);
  await page.waitForFunction(()=>document.querySelector('#services-cards').textContent.includes('Назначено T-CONT:'));
  const services=await page.locator('#services-cards').innerText();
  for(const text of ['Сведения об OLT','Разрешённые VLAN','Преобразование VLAN','Порты моста','OLT разрешила VLAN: 40, 44.','любой VLAN','Контейнеры восходящего трафика (T-CONT)','Назначено T-CONT: 2. Alloc-ID: 264, 781.','Настроено GEM-портов: 2. GEM Port-ID: 170, 175.'])assert(services.includes(text),text);
  for(const bad of ['линия правильная','VLAN перевод','в этой строке','выше по потоку','GEM взаимодействие','assigned','provisioned'])assert(!services.includes(bad),bad);
  checks.push('real Services renderer: correct terminology, complete sentences and live T-CONT/GEM summaries');
  await page.screenshot({path:path.join(out,'services-desktop-ru.png'),fullPage:true});
  for(const view of ['status','config/line','config/vlan','config/identity','config/network','config/services','config/stock','omci/services','omci/phone','omci/mib','system/firmware','system/access','system/backup','system/logs']){
   await page.evaluate(view=>{location.hash=view;},view);await page.waitForTimeout(180);
   if(view==='config/identity'){await page.locator('#expert').evaluate(x=>x.open=true);}
   if(view.startsWith('config/')){await page.evaluate(()=>{document.documentElement.dataset.help='full';for(const d of document.querySelectorAll('.s-more'))d.open=true;});}
   const text=await page.locator('main').innerText();views[view]=text;
   // Review remaining English prose, ignoring technical identifiers and data.
   untranslated[view]=await page.evaluate(()=>{
    const out=[];const walker=document.createTreeWalker(document.querySelector('main'),NodeFilter.SHOW_TEXT);let n;
    while(n=walker.nextNode()){
     if(!n.parentElement.checkVisibility()||n.parentElement.closest('code,pre,input,textarea,.mib-sub,.me-src,.s-key,[translate="no"]'))continue;
     const t=n.nodeValue.trim();if(/[a-z]{3}[ ,][a-z]{3}/.test(t)&&!/[А-Яа-яЁё]/.test(t))out.push(t);
    }return [...new Set(out)];
   });
  }
  assert(views['omci/phone'].includes('Состояние линии: настройка завершена (14)'));
  for(const value of ['registered','Status','Password','warning','Config'])assert(views['omci/phone'].includes(value));
  checks.push('actual Phone view translates status and labels while provider-supplied credential/display values stay literal');
  await page.evaluate(()=>location.hash='system/logs');await page.waitForFunction(()=>document.querySelectorAll('.logline').length===4);
  const rows=await page.locator('.logline').allTextContents();
  assert.deepEqual(rows,['warnrcS: pon step gponact: ret 0','warnrcS: pon steps done','infoodi_gpon: event=onu_state from=O4 to=O5','errerror: warn info Password Status Config']);
  assert((await page.locator('#log-out').innerText()).includes('Скрыто служебных строк heartbeat: 1.'));
  await page.screenshot({path:path.join(out,'kernel-log-ru.png'),fullPage:true});
  await page.locator('#language-select').selectOption('en');await page.waitForFunction(()=>document.querySelector('#tab-status').textContent==='Status');
  assert.deepEqual(await page.locator('.logline').allTextContents(),rows);
  await page.locator('#language-select').selectOption('ru');assert.deepEqual(await page.locator('.logline').allTextContents(),rows);
  await page.locator('#log-heartbeat').check();await page.waitForFunction(()=>document.querySelectorAll('.logline').length===5);
  assert((await page.locator('.logline').last().textContent()).includes('odi_wdt: alive'));
  checks.push('warn/info/err and complete message bodies remain exact through RU/EN/RU, refresh and heartbeat toggle');
  await page.evaluate(()=>location.hash='config/vlan');await page.waitForTimeout(100);
  await page.locator('#f-VLAN_MANU_TAG_VID').fill('44');await page.locator('#f-VLAN_MANU_TAG_VID').dispatchEvent('input');
  await page.locator('#language-select').selectOption('en');await page.locator('#language-select').selectOption('ru');
  assert.equal(await page.locator('#f-VLAN_MANU_TAG_VID').inputValue(),'44');
  assert((await page.locator('#savebar').innerText()).includes('Сразу: 1'));
  checks.push('language toggle preserves unsaved configuration value; no API mutation');
  let confirm='';page.on('dialog',async dialog=>{confirm=dialog.message();await dialog.dismiss();});
  await page.evaluate(()=>window.confirm('The stick reboots and the fibre service drops for about two minutes.'));
  assert.equal(confirm,'Модуль перезагрузится. Оптическое соединение прервётся примерно на две минуты.');
  await page.evaluate(()=>window.confirm('▮▮ Interrupts internet\n\nThe stick reboots and the fibre service drops for about two minutes.'));
  assert.equal(confirm,'▮▮ Прерывает связь\n\nМодуль перезагрузится. Оптическое соединение прервётся примерно на две минуты.');
  const writeMessage='Write the uploaded image to partition 0?\n\nThis takes about eighty seconds and the stick must not lose power meanwhile. The partition you are running now is not touched, and nothing boots the new one until you try it.';
  await page.evaluate(message=>window.confirm(message),writeMessage);
  assert.equal(confirm,'Записать загруженный образ в раздел 0?\n\nЗапись займёт около 80 секунд. Не отключайте питание. Текущий раздел сохранится; новая прошивка запустится только после пробной загрузки.');
  checks.push('exact firmware-write dialog from screenshot: heading, partition number and complete warning are Russian');
  await page.evaluate(()=>window.confirm('Commit to partition 1?\n\nIt becomes the one the stick boots by default, instead of partition 0. If it later fails to come up, the stick keeps booting it: there is no trial to fall back from.'));
  assert.equal(confirm,'Закрепить раздел 1?\n\nЭтот раздел будет загружаться по умолчанию вместо раздела 0. При сбое модуль продолжит запускать его; автоматического отката больше не будет.');
  await page.evaluate(()=>window.confirm('Partition 0 will boot once, at the next reboot. If it fails, the stick returns to partition 1, the committed one, on its own. Continue?'));
  assert(confirm.startsWith('При следующей перезагрузке раздел 0 будет запущен один раз.'));
  checks.push('related commit and trial-boot confirmations preserve partition numbers and translate complete assembled messages');
  await page.locator('#language-select').selectOption('en');
  await page.evaluate(message=>window.confirm(message),writeMessage);
  assert.equal(confirm,writeMessage);
  await page.locator('#language-select').selectOption('ru');
  const dialogCases=require('./dialog-cases.cjs').cases();
  const dialogResults=[];
  for(const item of dialogCases.cases){
    await page.evaluate(message=>window.confirm(message),item.source);
    dialogResults.push({...item,ru:confirm});
    assert.notEqual(confirm,item.source,item.id);
    const prose=confirm.replace(/\/\S+|\b(?:ssh|root|omcid|SerDes|HiSGMII|Fiber)\b/g,'');
    assert(!/\b[a-z]{2,}\b/.test(prose),'Untranslated confirmation: '+item.id+' '+confirm);
  }
  fs.writeFileSync(path.join(out,'confirmation-translations.json'),JSON.stringify({sites:dialogCases.sites,cases:dialogResults},null,2));
  checks.push('every native confirmation call site exercised with text extracted from original JS: '+dialogResults.length+' branch cases');
  const modalMessages=await page.evaluate(async()=>{
    const fw=await import('./firmware.js'),net=await import('./netaddr.js');
    const values=[];
    for(const [phase,seconds] of [['back',60],['stopped',900],['stopping',0],['stopping',45],['starting',40],['starting',150],['starting',360]])values.push({id:'reboot-'+phase+'-'+seconds,source:fw.rebootView(phase,seconds).text});
    const state={prev_ip:'192.168.2.1',new_LAN_IP_ADDR:'192.168.3.1'};
    for(const h of [{via:'192.168.2.1',state:{...state,new_LAN_IP_ADDR:'192.168.2.1'}},{via:'192.168.3.1',state},{via:'192.168.2.1',state}])values.push({id:'address-'+h.via+'-'+values.length,source:net.dialogView(h).text});
    for(const kind of ['looking','stuck','found'])values.push({id:'address-follow-'+kind,source:net.followText(kind,['http://192.168.3.1/'])});
    const host=document.createElement('section');host.id='modal-language-fixture';document.body.append(host);
    for(const [index,item] of values.entries()){const p=document.createElement('p');p.dataset.message=String(index);p.textContent=item.source;host.append(p);}
    await new Promise(r=>setTimeout(r,0));
    return values.map((item,index)=>({...item,ru:host.querySelector('[data-message="'+index+'"]').textContent}));
  });
  fs.writeFileSync(path.join(out,'modal-message-translations.json'),JSON.stringify(modalMessages,null,2));
  for(const item of modalMessages)assert(!/\b[a-z]{2,}\b/.test(item.ru),'Untranslated modal body: '+item.id+' '+item.ru);
  checks.push('HTML modal runtime text captured from actual rebootView, dialogView and followText helpers');
  await page.evaluate(()=>document.querySelector('#modal-language-fixture').remove());
  const modalStatic=[];
  for(const id of ['hostlink-dialog','netaddr-dialog','reboot-dialog','update-dialog']){
    const text=await page.evaluate(id=>{const d=document.getElementById(id);d.showModal();const text=d.innerText;d.close();return text;},id);
    assert(!/\b(?:Keep|Revert|Rebooting|Reload|Close|Nothing|Firmware|Newer)\b/.test(text),id+' '+text);
    modalStatic.push({id,text});
  }
  await page.evaluate(async()=>{const wizard=await import('./wizard.js');wizard.openWizard(false);});
  const wizardSteps=[];
  for(let i=0;i<4;i++){
    await page.waitForTimeout(30);
    const text=await page.locator('#wizard').innerText();wizardSteps.push(text);
    assert(!/\b(?:Your|Review|Apply|Step|Choose|Nothing|Next|Back|Skip|Username|password)\b/.test(text),text);
    if(i<3)await page.locator('#wizard-next').click();
  }
  await page.evaluate(async()=>{const wizard=await import('./wizard.js');wizard.W.open=false;document.querySelector('#wizard').close();});
  fs.writeFileSync(path.join(out,'html-dialog-translations.json'),JSON.stringify({modalStatic,wizardSteps},null,2));
  checks.push('all five HTML dialog shells and all four setup steps use Russian labels, with no apply/keep/reset actions');
  checks.push('confirmation dialogs use Russian without accepting or executing the action');
  await page.locator('#discard').click();
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>location.hash='omci/services');await page.waitForTimeout(100);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(out,'services-mobile-ru.png'),fullPage:true});
  checks.push('Russian Services layout fits 390 px');
  assert.deepEqual(errors,[]);assert(calls.every(x=>x.method==='GET'));
  fs.writeFileSync(path.join(out,'ui-visible-copy.private.json'),JSON.stringify({views,untranslated},null,2));
  fs.writeFileSync(path.join(out,'ui-copy-verification.json'),JSON.stringify({passed:true,checks,live_device_access:false,api_writes:0,javascript_errors:errors,remaining_english:untranslated},null,2));
  console.log(JSON.stringify({passed:true,checks:checks.length,remaining_english:untranslated},null,2));
 }catch(e){
  console.error(JSON.stringify({errors,calls:calls.slice(-12),error:e.message}));
  if(global.reviewPage){fs.writeFileSync(path.join(out,'ui-debug.txt'),await global.reviewPage.locator('body').innerText());await global.reviewPage.screenshot({path:path.join(out,'ui-debug.png'),fullPage:true});}
  throw e;
 }finally{await browser.close();server.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;server.close();});
