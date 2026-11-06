/* Client-side display translation. Device values, raw dumps and form values
 * are never translated. The existing public login module carries this code
 * so the firmware needs no new web-server asset or authenticated route. */
const UI_LANGUAGE_KEY = 'odi-language';
const UI_RU = Object.assign(Object.create(null),{"Status":"Состояние","Language":"Язык","Username":"Имя пользователя","Password":"Пароль","Sign in":"Войти","Sign out":"Выйти","Sign in · ODI DFP-34X-2C2":"Вход · ODI DFP-34X-2C2","Signing in…":"Вход…","Enter the username and the password.":"Введите имя пользователя и пароль.","Invalid credentials.":"Неверное имя пользователя или пароль.","Session expired.":"Срок действия сеанса истёк.","Not authorized.":"Необходимо войти.","You have been signed out.":"Вы вышли из системы.","The stick answered {0}.":"Устройство ответило кодом {0}.","No answer from the stick. Check that it is still reachable, then try again.":"Нет ответа от модуля. Проверьте доступность и повторите попытку.","The password you set in System › Access. A stick that never had one, or that was reset, uses":"Пароль из раздела «Система → Доступ». Если он ещё не задан или был сброшен, используются"});
if (typeof document!=='undefined' && !document.querySelector('#signin')) {
  const parts=await Promise.all([import('./dom.js').then(module => module.UI_RU_PART_0),import('./state.js').then(module => module.UI_RU_PART_1),import('./l2.js').then(module => module.UI_RU_PART_2),import('./phone.js').then(module => module.UI_RU_PART_3),import('./tools.js').then(module => module.UI_RU_PART_4),import('./omci.js').then(module => module.UI_RU_PART_5)]);
  for (const part of parts) Object.assign(UI_RU,part);
}
let currentUiLanguage = 'ru';
let uiLanguageObserver = null;
let nativeUiConfirm = null;
const originalUiText = new WeakMap();
const originalUiAttributes = new WeakMap();
const uiSkip = 'script,style,code,pre,textarea,[translate="no"],.logline,.loglines,#kernel-log,#kernel-raw,.mib-sub,.me-src,.mib-pre,#me-attrs-body .me-kv,[data-no-translate]';
const uiPatterns = Object.entries(UI_RU).filter(([key]) => /\{\d+\}/.test(key))
  .sort((a,b) => b[0].replace(/\{\d+\}/g,'').length-a[0].replace(/\{\d+\}/g,'').length)
  .map(([source,target]) => ({parts:source.split(/(\{\d+\})/),target}));

function matchUiPattern(pattern,text) {
  const parts=pattern.parts;
  if (!text.startsWith(parts[0])) return null;
  let position=parts[0].length;
  const parameters={};
  for (let index=1;index<parts.length;index+=2) {
    const next=parts[index+1] || '';
    const end=next?text.indexOf(next,position):(index+2>=parts.length?text.length:position);
    if (end<0) return null;
    parameters[parts[index].slice(1,-1)]=text.slice(position,end);
    position=end+next.length;
  }
  return position===text.length?parameters:null;
}

function translateUi(value, language=currentUiLanguage) {
  if (language!=='ru' || typeof value!=='string') return value;
  const normalized=value.replace(/\s+/g,' ').trim();
  if (!normalized || !/[A-Za-z]{2}/.test(normalized)) return value;
  let result=UI_RU[normalized];
  if (result===undefined) {
    for (const pattern of uiPatterns) {
      const parameters=matchUiPattern(pattern,normalized);
      if (!parameters) continue;
      result=pattern.target.replace(/\{(\d+)\}/g,(_,id) => parameters[id] ?? '{'+id+'}');
      break;
    }
  }
  if (result===undefined) return value;
  return (value.match(/^\s*/)?.[0] || '')+result+(value.match(/\s*$/)?.[0] || '');
}

function uiLanguage() { return currentUiLanguage; }

function translateUiText(node) {
  const parent=node.parentElement;
  if (!parent || parent.closest(uiSkip)) return;
  const previous=originalUiText.get(node);
  const source=previous && node.nodeValue===previous.rendered ? previous.source : node.nodeValue;
  const rendered=translateUi(source);
  originalUiText.set(node,{source,rendered});
  if (node.nodeValue!==rendered) {
    // Preserve the submitted value of options that have no explicit value.
    if (parent.tagName==='OPTION' && !parent.hasAttribute('value')) parent.value=parent.value;
    node.nodeValue=rendered;
  }
}

function translateUiAttributes(element) {
  if (element.closest(uiSkip)) return;
  let previous=originalUiAttributes.get(element);
  if (!previous) { previous={}; originalUiAttributes.set(element,previous); }
  for (const name of ['title','placeholder','aria-label']) {
    if (!element.hasAttribute(name)) continue;
    const current=element.getAttribute(name);
    const old=previous[name];
    const source=old && current===old.rendered ? old.source : current;
    const rendered=translateUi(source);
    previous[name]={source,rendered};
    if (current!==rendered) element.setAttribute(name,rendered);
  }
}

function translateUiTree(root) {
  if (root.nodeType===3) { translateUiText(root); return; }
  if (root.nodeType!==1 && root.nodeType!==9 && root.nodeType!==11) return;
  if (root.nodeType===1) translateUiAttributes(root);
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  let node;
  while ((node=walker.nextNode())) translateUiText(node);
  if (root.querySelectorAll)
    for (const element of root.querySelectorAll('[title],[placeholder],[aria-label]')) translateUiAttributes(element);
}

function observeUiLanguage() {
  uiLanguageObserver.observe(document.body,{subtree:true,childList:true,characterData:true,
    attributes:true,attributeFilter:['title','placeholder','aria-label']});
}

function setUiLanguage(language, persist=true) {
  currentUiLanguage=language==='en' ? 'en' : 'ru';
  if (persist) { try { localStorage.setItem(UI_LANGUAGE_KEY,currentUiLanguage); } catch (_) {} }
  document.documentElement.lang=currentUiLanguage;
  if (uiLanguageObserver) uiLanguageObserver.disconnect();
  translateUiTree(document.body);
  if (document.querySelector('title')) translateUiTree(document.querySelector('title'));
  const control=document.querySelector('#language-select');
  if (control) control.value=currentUiLanguage;
  if (uiLanguageObserver) observeUiLanguage();
  document.dispatchEvent(new CustomEvent('odi-language-change',{detail:{language:currentUiLanguage}}));
}

function initUiLanguage() {
  if (typeof document==='undefined' || !document.body || uiLanguageObserver) return;
  let language='ru';
  try { if (localStorage.getItem(UI_LANGUAGE_KEY)==='en') language='en'; } catch (_) {}
  uiLanguageObserver=new MutationObserver(records => {
    uiLanguageObserver.disconnect();
    for (const record of records) {
      if (record.type==='characterData') translateUiText(record.target);
      else if (record.type==='attributes') translateUiAttributes(record.target);
      else for (const node of record.addedNodes) translateUiTree(node);
    }
    observeUiLanguage();
  });
  // Confirmation text is display-only; the result and submitted values are
  // unchanged. Keep the original function to avoid wrapping twice.
  if (!nativeUiConfirm) {
    nativeUiConfirm=window.confirm.bind(window);
    window.confirm=message => {
      const source=String(message),full=translateUi(source);
      // A whole-message pattern may capture an English title as {0}.
      // Prefer exact complete messages; otherwise localize each paragraph.
      const exact=UI_RU[source.replace(/\s+/g,' ').trim()];
      if (exact!==undefined) return nativeUiConfirm(full);
      return nativeUiConfirm(source.split(/\r?\n/).map(line => {
        const badge=/^([▮]+\s*)(.*)$/.exec(line);
        return badge?badge[1]+translateUi(badge[2]):translateUi(line);
      }).join('\n'));
    };
  }
  const control=document.querySelector('#language-select');
  if (control) control.addEventListener('change',() => setUiLanguage(control.value));
  window.addEventListener('storage',event => {
    if (event.key===UI_LANGUAGE_KEY) setUiLanguage(event.newValue,false);
  });
  setUiLanguage(language,false);
}

export { translateUi, uiLanguage, initUiLanguage, setUiLanguage };

/*
 * The sign-in page.
 *
 * The credential goes to /api/login once, which answers with a session cookie
 * the browser keeps until it closes or the session ends (sign out, a confd
 * restart, half an hour unused, a day in all). fetch() and not a plain form
 * post: confd sends `Referrer-Policy: no-referrer`, under which a form post
 * carries `Origin: null` and is refused as cross-site.
 *
 * On success the page goes where the browser was headed. A redirect keeps the
 * location hash, so /#config/vlan comes back to Config > VLAN.
 */

const $ = (s) => document.querySelector(s);

function say(cls, text) {
  const m = $('#signin-msg');
  m.className = cls;
  m.textContent = text;
}

/* What the page says for an answer from /api/login. Pure, for make check. */
export function loginOutcome(status, body) {
  if (status === 200 && body && body.ok) return { ok: true };
  if (body && body.error) return { ok: false, text: body.error[0].toUpperCase() + body.error.slice(1) + '.' };
  return { ok: false, text: `The stick answered ${status}.` };
}

export async function signIn(user, password, f = fetch) {
  const r = await f('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user, password }).toString(),
    cache: 'no-store',
  });
  let body = null;
  try { body = await r.json(); } catch (e) { /* not JSON: the status says it */ }
  return loginOutcome(r.status, body);
}

async function onSubmit(ev) {
  ev.preventDefault();
  const user = $('#user').value.trim();
  const pass = $('#pass');
  if (!user || !pass.value) { say('bad', 'Enter the username and the password.'); return; }
  const go = $('#signin-go');
  go.disabled = true;
  say('', 'Signing in…');
  try {
    const out = await signIn(user, pass.value);
    if (out.ok) { location.replace('/' + location.hash); return; }
    say('bad', out.text);
    pass.value = '';
    pass.focus();
  } catch (e) {
    say('bad', 'No answer from the stick. Check that it is still reachable, then try again.');
  }
  go.disabled = false;
}

if (typeof document !== 'undefined' && $('#signin')) {
  initUiLanguage();
  if (new URLSearchParams(location.search).has('out')) say('good', 'You have been signed out.');
  $('#signin').addEventListener('submit', onSubmit);
}
