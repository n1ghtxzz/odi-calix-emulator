/*
 * The data the page renders from, and the three questions asked of it: where a
 * value came from, what applying it costs, and whether the firmware is
 * currently ignoring it.
 *
 * One module because every other one reads it and the bootstrap fills it once.
 * Held behind an object rather than exported as bare `let`s: the bootstrap
 * REPLACES these (SCHEMA is reassigned, not appended to), and a destructured
 * import would capture the old empty array.
 */

import { el } from './dom.js';

const S = {
  SCHEMA: [], VALUES: {}, META: {}, CONS: {}, DEFAULTS: {}, BASELINE: {},
  /* mask name -> [{ bit, feature, module }], from /api/features. */
  FEATURES: {},
  /* name -> { apply, action, pair, reader, note }, from /api/settings: what
     THIS image does with the key. Empty on an image without the table, and
     then every key is offered as before. */
  SETTINGS: {},
  /* /api/firmware, for the switch files and the lan-ip override. */
  FW: {},
  /* Set once a reboot is asked for: the page follows it, and polls nothing else. */
  REBOOTING: false,
};

/*
 * The four apply classes, as the page labels them. The names are the ones
 * docs/SETTINGS.md in odi-oss uses (LIVE, SERVICE RESTART, ...), in sentence
 * case, so the doc and the page say the same words.
 *
 * They are ordered by what they cost, and the page draws that order: one to
 * four bars on every badge, in the save bar and in the confirmations alike,
 * so the price of a change reads the same wherever it is shown.
 */
const CLASS_LABEL = {
  live: 'Live',
  restart: 'Service restart',
  internet: 'Interrupts internet',
  reboot: 'Reboot',
};
const CLASS_RANK = { live: 1, restart: 2, internet: 3, reboot: 4 };
/* What each one means, in the words the legend and the tooltips use. */
const CLASS_MEANS = {
  live: 'takes effect at once',
  restart: 'a daemon restarts, the fibre service stays up',
  internet: 'the fibre service drops while the ONU ranges again',
  reboot: 'read only at boot',
};
/* The ones that ask before they act. */
const CLASS_CONFIRMS = new Set(['reboot', 'internet']);

/* The badge, one markup for every place a cost is shown. */
function costBadge(cls, text) {
  const b = el('span', 'cost cost-' + cls);
  /* The words in their own span, so a row can show the bars alone. */
  b.append(el('i', 'bars'), el('span', 'cost-text', text || CLASS_LABEL[cls] || cls));
  if (CLASS_MEANS[cls]) b.title = CLASS_LABEL[cls] + ': ' + CLASS_MEANS[cls];
  return b;
}

/* Whether this image says which keys it reads. */
function imageAware() {
  return Object.keys(S.SETTINGS).length > 0;
}

/* The settings row for a key, or null: a key this image does not read. */
function settingOf(name) {
  return S.SETTINGS[name] || null;
}

/* The ONU identity keys, which omcid reports only while its switch is on. */
const IDENTITY_SWITCH = 'omci-identity.on';
function identitySwitchOn() {
  return Boolean((S.FW.switches || {})[IDENTITY_SWITCH]);
}

/* Pending edits, keyed by name. Kept out of the DOM so switching tabs or
   re-filtering cannot silently drop a change the user has typed -- and read
   back by renderValue, so a re-render shows the edit rather than the stored
   value. */
const EDITS = new Map();

/*
 * Where a value came from.
 *
 * The image ships only ten defaults in /etc/config_default*.xml; the rest are
 * built into the MIB with no read-only way to read them out. So a key is judged
 * against the image default where one exists, and otherwise against a baseline
 * captured from a stick considered correct. Anything with neither reference is
 * left unlabelled rather than guessed at.
 */
function provenance(row, raw) {
  const name = row.name;
  if (name in S.DEFAULTS) {
    return raw === S.DEFAULTS[name]
      ? { cls: 'default', label: 'image default' }
      : { cls: 'changed', label: 'changed', was: S.DEFAULTS[name], from: 'image default' };
  }
  if (name in S.BASELINE) {
    return raw === S.BASELINE[name]
      ? null
      : { cls: 'changed', label: 'changed', was: S.BASELINE[name], from: 'baseline' };
  }
  return null;
}

/* The apply class, preferring the derived one over the schema's. */
function applyOf(row) {
  return (S.CONS[row.name] || {}).apply || row.apply || 'unknown';
}

/*
 * Whether a key's `depends` condition holds. The firmware ignores some keys
 * unless others are set a particular way — VLAN_MANU_TAG_VID is applied only
 * when VLAN_CFG_TYPE=1 and VLAN_MANU_MODE=1, by omcid here as by omci_app on
 * the stock firmware. Saying so is more useful than showing a value that
 * looks live and is not.
 *
 * Judged on the values a Save would leave, pending edits included, so
 * choosing VLAN config mode 1 unlocks the VLAN ID before anything is saved.
 */
function dependsUnmet(row) {
  const m = S.META[row.name];
  if (!m || !m.depends) return null;
  const unmet = m.depends.split('&').filter((c) => {
    const [k, v] = c.split('=');
    return (EDITS.has(k) ? EDITS.get(k) : S.VALUES[k]) !== v;
  });
  return unmet.length ? unmet : null;
}

/* Whether another key's `depends` names this one. */
function gatesOthers(name) {
  return Object.values(S.META).some((m) => m.depends
    && m.depends.split('&').some((c) => c.split('=')[0] === name));
}

/*
 * Drop the pending edits of keys the firmware would ignore. A key turns
 * ignored when the one gating it is changed back (VLAN ID typed, then config
 * mode set to 0), and an edit to it would be saved for nothing.
 */
function dropIgnoredEdits() {
  for (const k of [...EDITS.keys()]) {
    const row = S.SCHEMA.find((r) => r.name === k);
    if (row && dependsUnmet(row)) EDITS.delete(k);
  }
}


/*
 * The VLAN the stick tags upstream with, or null when it adds no tag: omcid
 * builds the manual tag only with VLAN_CFG_TYPE=1, VLAN_MANU_MODE=1 and both a
 * VLAN ID and a priority, as omci_app does on the stock firmware.
 */
function vlanTag(v) {
  const set = (k) => v[k] !== undefined && v[k] !== '';
  return v.VLAN_CFG_TYPE === '1' && v.VLAN_MANU_MODE === '1'
    && set('VLAN_MANU_TAG_VID') && set('VLAN_MANU_TAG_PRI') ? v.VLAN_MANU_TAG_VID : null;
}

/*
 * What a VLAN change can do to the service, or null when it cannot cut it.
 * These keys are LIVE: saving applies them at once and the ONU stays in O5,
 * so a tag the OLT does not accept stops the traffic with every light still
 * green. `before` is what the stick holds, `after` the same with the edits.
 */
function vlanRisk(before, after) {
  const was = vlanTag(before);
  const now = vlanTag(after);
  if (was === now) return null;
  if (now === null) {
    return `The stick stops tagging VLAN ${was}: upstream frames reach the OLT as the `
      + 'router sends them. On a line whose OLT accepts only tagged frames the service '
      + `stops at once, while the ONU stays in O5, unless the router tags VLAN ${was} itself.`;
  }
  if (was === null) {
    return `The stick starts tagging untagged frames with VLAN ${now}. If the OLT does not `
      + 'carry that VLAN the service stops at once, while the ONU stays in O5.';
  }
  return `The stick tags with VLAN ${now} instead of ${was}. If the OLT does not carry `
    + `VLAN ${now} the service stops at once, while the ONU stays in O5.`;
}

/*
 * Decode an OMCI_CUSTOM_* value against the plugins the image actually ships.
 *
 * These four masks are the least documented settings on the device -- the stick
 * arrives with OMCI_CUSTOM_RDP=4 and upstream has an open issue from 2022
 * asking what that means. It is not a mystery: each bit loads one plugin from
 * lib/features, the plugin's filename IS the bit, and the function it defines
 * is the feature. schema/features.tsv is generated from the image's own ELF
 * symbol tables, so this decode is read off the firmware rather than asserted.
 *
 * The value is DECIMAL. `flash set` accepts nothing else, which is worth
 * knowing before you type 0x102 and watch it store 0.
 *
 * Bits with no plugin are reported rather than dropped: a bit set here that
 * this image cannot load does nothing, and that is the useful thing to see.
 */
function decodeMask(name, value) {
  const rows = S.FEATURES[name];
  if (!rows || !rows.length) return null;

  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const n = /^0[xX]/.test(raw) ? Number(raw) : Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;

  const known = [];
  const unknown = [];
  let covered = 0;

  for (let b = 0; b < 31; b++) {
    const bit = 1 << b;
    if (!(n & bit)) continue;
    const hit = rows.filter((r) => Number(r.bit) === bit);
    if (hit.length) {
      known.push({ bit, names: hit.map((r) => r.feature) });
      covered |= bit;
    } else {
      unknown.push(bit);
    }
  }
  return { n, known, unknown, covered };
}

export {
  S, EDITS, provenance, applyOf, dependsUnmet, gatesOthers, dropIgnoredEdits, decodeMask, vlanTag, vlanRisk,
  CLASS_LABEL, CLASS_RANK, CLASS_MEANS, CLASS_CONFIRMS, costBadge, imageAware, settingOf, IDENTITY_SWITCH, identitySwitchOn,
};

export const UI_RU_PART_1 = {"Private SNTP":"Проприетарные настройки SNTP","Extended ONU-G":"Расширенные данные ONU-G","OLT location config data":"Сведения о размещении OLT","CTC loop detection":"Обнаружение петель CTC","ONU capability":"Возможности ONU","LOID authentication":"Аутентификация LOID","Extended multicast operations profile":"Расширенный профиль multicast","Private T-CONT queue configuration":"Проприетарные настройки очередей T-CONT","Private VLAN configuration":"Проприетарные настройки VLAN","Reading":"Чтение","{0} of {1}":"{0} из {1}","{0}, which the device calls {1}":"{0}; имя в выводе устройства: {1}",", which the device calls":"; имя в выводе устройства:","Truncated: this table is longer than the daemon will hold, so the last entities are missing. Look up one entity id to read it in full.":"Вывод обрезан: таблица не поместилась в буфер службы, последние экземпляры не показаны. Укажите ID отдельного экземпляра, чтобы прочитать его целиком.","Truncated: this table is longer than the daemon will hold,":"Вывод обрезан: таблица не поместилась в буфер службы,","so the last entities are missing. Look up one entity id to read it in full.":"последние экземпляры не показаны. Укажите ID отдельного экземпляра, чтобы прочитать его целиком.","entity {0}":"экземпляр {0}","entity":"экземпляр","This entity printed no attributes beyond its id.":"У этого экземпляра выведен только ID, без атрибутов.","omcid cut this row short: the attributes above are not all of it.":"omcid обрезал строку: показаны не все атрибуты.","Look up needs {0}.":"Для поиска требуется {0}.","Look up needs":"Для поиска требуется","Truncated: this dump is longer than the daemon will hold.":"Вывод обрезан: данные не поместились в буфер службы.","Enter":"Ввести","Only the netmask changes, so there is no new address to open and this page stays. Keep it from a computer that is on the new netmask: the stick checks where the request came from, and refuses a Keep from any other. If it is not kept, the stick goes back by itself.":"Меняется только маска; IP-адрес остаётся прежним. Подтвердите настройку с компьютера в новой подсети: запросы из других подсетей модуль отклонит. Без подтверждения будет автоматический откат.","Only the netmask changes, so there is no new address to open and this page stays. Keep":"Меняется только маска; IP-адрес остаётся прежним. Подтвердите настройку","it from a computer that is on the new netmask: the stick checks where the request came":"с компьютера в новой подсети: запросы из других подсетей модуль","from, and refuses a Keep from any other. If it is not kept, the stick goes back by itself.":"отклонит. Без подтверждения будет автоматический откат.","{0}answer, goes back to the address before.":"{0}подтверждения вернёт прежний адрес.","This page is on the new address ({0}), so it works. Keep stores it; Revert, or no":"Страница открыта по новому адресу ({0}); соединение работает. Нажмите «Сохранить адрес». Откат или отсутствие","answer, goes back to the address before.":"подтверждения вернёт прежний адрес.","{0}meanwhile. It opens the new address by itself as soon as that answers; press Keep there. If it never answers, do nothing: the stick goes back by itself. Revert works from here.":"{0}без перерыва. Новый адрес откроется автоматически, как только станет доступен; подтвердите его там. Если ответа нет, ничего не делайте: будет автоматический откат. Отменить изменение можно и здесь.","This page is on {0}, which the stick already had, and it stays up":"Страница открыта по прежнему адресу {0} и остаётся доступна","the old address":"прежний адрес","meanwhile. It opens the new address by itself as soon as that answers; press Keep there.":"без перерыва. Новый адрес откроется автоматически, как только станет доступен; подтвердите его там.","If it never answers, do nothing: the stick goes back by itself. Revert works from here.":"Если ответа нет, ничего не делайте: будет автоматический откат. Отменить изменение можно и здесь.","or":"или","Looking for the new address ({0}). This page opens it as soon as it answers.":"Проверка нового адреса ({0}). Он откроется автоматически, как только станет доступен.","{0}If this computer has no route to it, or it is the wrong address, press Revert, or do nothing: the stick goes back by itself and this address keeps working.":"{0}Если на компьютере нет маршрута к нему или адрес неверен, отмените изменение либо дождитесь автоматического отката. Прежний адрес продолжит работать.","{0} does not answer from this computer yet, and this page keeps trying until the countdown ends.":"{0} пока недоступен с этого компьютера. Проверка продолжится до конца отсчёта.","If this computer has no route to it, or it is the wrong address, press Revert, or do nothing: the":"Если на компьютере нет маршрута к нему или адрес неверен, отмените изменение либо дождитесь","stick goes back by itself and this address keeps working.":"автоматического отката. Прежний адрес продолжит работать.","{0}the password per address. The countdown and Keep are on that page. If you cancel the prompt, go Back to this page.":"{0}данные входа отдельно для каждого адреса. Обратный отсчёт и подтверждение будут на новой странице. Если отмените вход, вернитесь сюда кнопкой «Назад».","{0} answers. Opening it now: the browser asks for the password again there, because it keeps":"Адрес {0} доступен. Открываем его; потребуется повторный вход, поскольку браузер хранит","the password per address. The countdown and Keep are on that page. If you cancel the prompt, go":"данные входа отдельно для каждого адреса. Обратный отсчёт и подтверждение будут на новой странице. Если отмените вход,","Back to this page.":"вернитесь сюда кнопкой «Назад».","This page already opened the new address once for this trial and does not do it again. Use the link to open it.":"Новый адрес уже открывался во время этой проверки. Для повторного открытия используйте ссылку.","This page already opened the new address once for this trial and does not":"Новый адрес уже открывался во время этой проверки.","do it again. Use the link to open it.":"Для повторного открытия используйте ссылку.","Not tried: {0}. Nothing changed.":"Проверка не началась: {0}. Ничего не изменено.","Not tried:":"Проверка не началась:","see above":"см. выше","No answer from this address. If you kept the change on the new address this one is gone: continue there. If you were on the new one and it may be wrong, the stick goes back by itself when the countdown ends, and the old address works again.":"Адрес не отвечает. Если изменение подтверждено на новом адресе, продолжайте работу там. Если новый адрес неверен, по окончании отсчёта модуль вернётся к прежнему адресу.","No answer from this address. If you kept the change on the new":"Адрес не отвечает. Если изменение подтверждено на новом","address this one is gone: continue there. If you were on the new one and it may be wrong, the":"адресе, продолжайте работу там. Если новый адрес неверен,","stick goes back by itself when the countdown ends, and the old address works again.":"по окончании отсчёта модуль вернётся к прежнему адресу.","Continue on {0}":"Продолжить на {0}","Kept: the management address is stored. The stick answers at {0} now.":"Адрес управления сохранён. Теперь модуль доступен по адресу {0}.","Not kept in time: back to the address before. Nothing was stored.":"Нет подтверждения: восстановлен прежний адрес. Настройка не сохранена.","Reverted: back to the address before. Nothing was stored.":"Выполнен откат к прежнему адресу. Настройка не сохранена.","The new address could not be applied: back to the address before. Nothing was stored.":"Не удалось применить новый адрес. Восстановлен прежний адрес; настройка не сохранена.","the MIB could not be read":"Не удалось прочитать MIB","omcicli returned nothing: the OMCI daemon is not answering. Check that omcid is running (ps); starting it again is described in the image docs (TOOLS.md, Restarting a daemon).":"omcicli не вернул данные: служба OMCI не отвечает. Проверьте, запущен ли omcid (команда ps). Перезапуск описан в TOOLS.md, раздел Restarting a daemon.","omcicli returned nothing: the OMCI daemon is not answering.":"omcicli не вернул данные: служба OMCI не отвечает.","Check that omcid is running (ps); starting it again is described":"Проверьте, запущен ли omcid (команда ps). Перезапуск описан","in the image docs (TOOLS.md, Restarting a daemon).":"в TOOLS.md, раздел Restarting a daemon.","omcid does not know this table: {0}":"omcid не поддерживает эту таблицу: {0}","omcid does not know this table:":"omcid не поддерживает эту таблицу:","omcicli listed its tables instead of reading the one asked for, which is how the stock omci_app fails when it has stopped servicing its request queue.":"Вместо запрошенных данных omcicli вывел список таблиц. Так ведёт себя штатный omci_app, когда перестаёт обрабатывать очередь запросов.","omcicli listed its tables instead of reading the one asked for,":"Вместо запрошенных данных omcicli вывел список таблиц.","which is how the stock omci_app fails when it has stopped":"Так ведёт себя штатный omci_app, когда перестаёт","servicing its request queue.":"обрабатывать очередь запросов.","no voice provisioned":"телефония не настроена","Phone port {0}":"Телефонный порт {0}","Phone port":"Телефонный порт","no port":"нет порта","SIP user not on a phone port":"SIP-учётная запись без привязки к телефонному порту","none provisioned":"не настроено","Realm":"Домен авторизации (Realm)","SIP port":"Порт SIP","RTP ports":"Порты RTP","Other":"Прочее","No voice provisioned":"Телефония не настроена","Phone ports are on, but the OLT has not provisioned a SIP line on them. Many OLTs offer no voice at all; nothing is wrong with the stick.":"Телефонные порты включены, но OLT не назначила им SIP-учётную запись. Провайдер может не предоставлять телефонию; это не означает неисправность модуля.","Phone ports are on, but the OLT has not provisioned a SIP line on them.":"Телефонные порты включены, но OLT не назначила им SIP-учётную запись.","Many OLTs offer no voice at all; nothing is wrong with the stick.":"Провайдер может не предоставлять телефонию; это не означает неисправность модуля.","Line status: {0}":"Состояние линии: {0}","Line status:":"Состояние линии:","Line status: not reported":"Состояние линии: нет данных","Could not reach the stick.":"Не удалось связаться с модулем.","Refused (HTTP {0}).":"Запрос отклонён (HTTP {0}).","Refused (HTTP":"Запрос отклонён (HTTP","omcicli did not answer.":"omcicli не ответил.","not registered":"нет регистрации","in session":"идёт разговор","registration failed (ICMP error)":"ошибка регистрации (ICMP)","registration failed (TCP error)":"ошибка регистрации (TCP)","registration failed (authentication)":"ошибка регистрации (авторизация)","registration failed (timeout)":"ошибка регистрации (тайм-аут)","registration failed (server fail code)":"ошибка регистрации (код отказа сервера)","invite failed (ICMP error)":"ошибка вызова (ICMP)","invite failed (TCP error)":"ошибка вызова (TCP)","invite failed (authentication)":"ошибка вызова (авторизация)","invite failed (timeout)":"ошибка вызова (тайм-аут)","invite failed (server fail code)":"ошибка вызова (код отказа сервера)","Port {0}: {1}, {2} s ago{3}":"Порт {0}: {1}, {2} с назад{3}","s ago":"с назад","(too old, ignored)":"(устарело, не используется)","The OLT reads the router's state as the line status while a report is under {0} s old; otherwise \"config done\".":"OLT получает состояние от роутера, пока отчёт не старше {0} с. Затем передаётся «настройка завершена».","The OLT reads the router's state as the line status while a report is under":"OLT получает состояние от роутера, пока отчёт не старше","s old; otherwise \"config done\".":"с. Затем передаётся «настройка завершена».","The OLT is told \"config done\". To let the router's state through, set the router-reported line status key to 1 in Config, ONU identity, Expert settings, and have the router post its state (docs/API.md, POST /api/voip/status).":"В OLT передаётся «настройка завершена». Для передачи реального состояния включите параметр отчёта роутера в «Настройки → Идентификация ONU → Дополнительные настройки» и настройте отправку состояния с роутера (docs/API.md, POST /api/voip/status).","Could not read":"Не удалось прочитать","{0}. This image may predate the phone view.":"{0}. Возможно, эта прошивка выпущена до появления раздела телефонии.","omcicli failed":"Ошибка omcicli","Nothing in this backup can be restored: every difference is a value the stick would refuse.":"Восстановление невозможно: все отличающиеся значения будут отклонены устройством.","This backup matches what the stick already holds. Nothing to restore.":"Резервная копия совпадает с текущими настройками. Восстанавливать нечего.","{0} = {1} is skipped: {2}.":"Параметр {0} = {1} пропущен: {2}.","{0} setting{1} differ":"Отличающихся настроек: {0}{1}",", plus {0} identity key{1}":", параметров идентификации: {0}{1}","Setting":"Параметр","On the stick":"На модуле","In the backup":"В резервной копии","Not restorable, and skipped: {0}. A wrong SerDes mode costs every management path at once, so this daemon refuses those keys however they arrive.":"Восстановление запрещено; пропущено: {0}. Неверный режим SerDes может лишить всех способов доступа, поэтому служба не принимает эти параметры.","Not restorable, and skipped:":"Восстановление запрещено; пропущено:","daemon refuses those keys however they arrive.":"служба не принимает эти параметры независимо от способа записи.","{0} key(s) in the file are not in this image's schema and will be skipped.":"Неизвестных этой прошивке параметров в файле: {0}. Они будут пропущены.","key(s) in the file are not in":"Параметры файла, отсутствующие","this image's schema and will be skipped.":"в схеме этой прошивки, будут пропущены.","No settings found in that file. A backup looks like <Value Name=\"...\" Value=\"...\"/> — it is what the Download button above produces.":"В файле нет настроек. Резервная копия содержит строки <Value Name=\"...\" Value=\"...\"/>. Такой файл скачивается кнопкой выше.","No settings found in that file. A backup looks":"В файле нет настроек. Резервная копия содержит строки","like <Value Name=\"...\" Value=\"...\"/> — it is what the Download":"<Value Name=\"...\" Value=\"...\"/>. Такой файл скачивается","button above produces.":"кнопкой выше.","Write {0} identity key(s) ({1})? Only do this onto the stick the backup came from: on another stick the OLT would see the same serial number twice. Continue?":"Записать параметры идентификации: {0} ({1})? Делайте это только на модуле, с которого снята копия. Иначе OLT увидит два устройства с одинаковым серийным номером. Продолжить?","identity key(s) (":"параметры идентификации (",")? Only do this onto the stick the backup came from: on another stick the OLT would see":")? Делайте это только на модуле, с которого снята копия. Иначе OLT увидит","the same serial number twice. Continue?":"два устройства с одинаковым серийным номером. Продолжить?","Writing {0} setting(s)…":"Запись настроек: {0}…","{0} written, {1} refused.":"Записано: {0}; отклонено: {1}.","{0} identity key(s) were left alone. Tick the box above to include them — only do that when restoring onto the stick the backup came from.":"Параметры идентификации сохранены без изменений: {0}. Чтобы восстановить их, отметьте флажок выше. Делайте это только на исходном модуле.","identity key(s) were left":"параметры идентификации сохранены","alone. Tick the box above to include them — only do that when":"без изменений. Для их восстановления отметьте флажок выше. Делайте это только","restoring onto the stick the backup came from.":"на исходном модуле.","The management address keys are tried, not written: the stick moves to them and goes back by itself unless you keep them on the new address.":"Адрес управления будет проверен временно. Подтвердите его на новой странице; без подтверждения модуль вернётся к прежнему адресу.","The management address keys are tried, not written: the stick moves":"Адрес управления будет проверен временно. Подтвердите его на новой странице;","to them and goes back by itself unless you keep them on the new address.":"без подтверждения модуль вернётся к прежнему адресу.","Written, not applied. Each restored key takes effect the way its class on the Config tab says: the addresses are tried when the image has the trial and applied when you save them again there when it does not, the OMCI keys with Apply now, the rest at the next reboot. Keys only the stock firmware reads change nothing here, except OMCI_CUSTOM_ME, whose bit 256 decides whether the VEIP slot applies.":"Записано, но ещё не применено. Порядок применения указан в разделе «Настройки»: адреса проходят временную проверку, OMCI применяется кнопкой «Применить сейчас», остальное — после перезагрузки. Параметры штатной прошивки здесь не действуют, кроме бита 256 в OMCI_CUSTOM_ME, который разрешает выбор слота VEIP.","Written, not applied. Each restored key takes effect":"Записано, но ещё не применено. Порядок применения указан","the way its class on the Config tab says: the addresses are tried when":"в разделе «Настройки»: адреса проходят временную проверку,","the image has the trial and applied when you save them again there when it does not,":"а если она не поддерживается — применяются при повторном сохранении в настройках;","the OMCI keys with Apply now, the rest at":"OMCI применяется кнопкой «Применить сейчас», остальное — после","the next reboot. Keys only the stock firmware reads change nothing here, except OMCI_CUSTOM_ME, whose bit 256 decides whether the VEIP slot applies.":"перезагрузки. Параметры штатной прошивки здесь не действуют, кроме бита 256 в OMCI_CUSTOM_ME, который разрешает выбор слота VEIP.","1 change":"1 изменение","{0} changes":"Изменений: {0}","changes":"изменений","Identity keys need the confirmation ticked.":"Для записи параметров идентификации отметьте флажок подтверждения.","{0} Continue?":"{0} Продолжить?","Not saved.":"Не сохранено.","The management address is tried now{0}. The address it has now keeps working beside it, and this page opens the new one by itself when it answers (the browser asks for the password again there). The stick goes back to the old address after 90 seconds unless you press Keep on the new one. Nothing is stored until you do. Continue?":"Начать временную проверку адреса управления{0}? Прежний адрес останется доступен. Новый адрес откроется автоматически; войдите заново и подтвердите его. Без подтверждения через 90 секунд будет откат. До подтверждения настройка не сохраняется. Продолжить?","The management address is tried now":"Начать временную проверку адреса управления",": the stick moves to {0}":": модуль будет доступен по адресу {0}","itself when it answers (the browser asks for the password again there). The stick goes":"автоматически, когда он станет доступен; потребуется повторный вход. Модуль","back to the old address after 90 seconds unless you press Keep on the new one.":"вернётся к прежнему адресу через 90 секунд, если не подтвердить новый адрес.","Nothing is stored until you do. Continue?":"До подтверждения настройка не сохраняется. Продолжить?","Apply now: restarts OMCI, about 6 s, no reboot":"Применить сейчас: перезапуск OMCI, около 6 с, без перезагрузки модуля","Nothing in the image was seen reading these keys, so assume a reboot is needed. Nothing here reboots the stick for you.":"Не установлено, какой компонент читает эти параметры. Для применения может потребоваться перезагрузка; автоматически она не выполняется.","Nothing in the image was seen reading these keys, so assume a":"Не установлено, какой компонент читает эти параметры. Для применения может потребоваться","reboot is needed. Nothing here reboots the stick for you.":"перезагрузка; автоматически она не выполняется.","These keys are read at boot, so a reboot is needed for them to take effect. Nothing here reboots the stick for you.":"Эти параметры читаются при загрузке. Чтобы применить их, перезагрузите модуль вручную.","These keys are read at boot, so a reboot is needed for them to":"Эти параметры читаются при загрузке. Чтобы применить их,","take effect. Nothing here reboots the stick for you.":"перезагрузите модуль вручную.","Some of these keys are read only by the stock firmware in the other slot; nothing on this image changes.":"Некоторые параметры использует только штатная прошивка в другом разделе. В текущей прошивке они не действуют.","Some of these keys are read only by the stock":"Некоторые параметры использует только штатная","firmware in the other slot; nothing on this image changes.":"прошивка в другом разделе. В текущей прошивке они не действуют.","The management address changes now, and this {0}":"Адрес управления изменится сейчас, страница {0}","The management address changes now, and this":"Адрес управления изменится сейчас, страница","page with it, to {0}. Continue?":"откроется по адресу {0}. Продолжить?","Saved, not applied: the address changes at the next reboot, or when you apply it.":"Сохранено, но ещё не применено. Адрес изменится после перезагрузки или применения настроек.","Saved, not applied: the address changes at the next":"Сохранено, но ещё не применено. Адрес изменится после","reboot, or when you apply it.":"перезагрузки или применения настроек.","Apply the addresses now":"Применить адреса сейчас","Saved. Not reported to the OLT while the identity switch is off, so nothing changes on the line and there is nothing to apply.":"Сохранено. Подмена идентификации отключена: значения не передаются в OLT, параметры линии не изменились. Применение не требуется.","Saved. Not reported to the OLT while the identity switch":"Сохранено. Подмена идентификации отключена:","is off, so nothing changes on the line and there is nothing to apply.":"значения не передаются в OLT, параметры линии не изменились. Применение не требуется.","Saved. These keys take effect when omcid re-registers the ONU and the OLT provisions it again.":"Сохранено. Параметры вступят в силу после повторной регистрации ONU и настройки со стороны OLT.","Saved. These keys take effect when omcid":"Сохранено. Параметры вступят в силу после","re-registers the ONU and the OLT provisions it again.":"повторной регистрации ONU и настройки со стороны OLT.","Saved. These keys are read only at boot.":"Сохранено. Эти параметры читаются только при загрузке.","This takes the fibre service down: the ONU is deactivated, omcid clears its MIB, and the ONU ranges again and waits for the OLT to provision it. About ten seconds, then however long the OLT takes (typically under a minute). Continue?":"Оптическое соединение прервётся: ONU будет деактивирована, omcid очистит MIB, затем ONU повторно зарегистрируется и получит настройки от OLT. Подготовка займёт около 10 секунд, далее — настройка со стороны OLT (обычно меньше минуты). Продолжить?","This takes the fibre service down: the":"Оптическое соединение прервётся:","ONU is deactivated, omcid clears its MIB, and the ONU ranges again and":"ONU будет деактивирована, omcid очистит MIB, затем ONU повторно зарегистрируется и","waits for the OLT to provision it. About ten seconds, then however long":"получит настройки от OLT. Подготовка займёт около 10 секунд, далее — настройка со стороны","the OLT takes (typically under a minute). Continue?":"OLT (обычно меньше минуты). Продолжить?","The stick reboots and the fibre service drops for about two minutes.{0} Continue?":"Модуль перезагрузится. Оптическое соединение прервётся примерно на две минуты.{0} Продолжить?","This is a trial of partition {0}: the reboot comes":"Сейчас выполняется пробная загрузка раздела {0}. После перезагрузки запустится","back on partition {0}, the committed one, not on this image.":"закреплённый раздел {0}, а не текущая прошивка.","Addresses applied.":"Адреса применены.","Not applied: {0}":"Не применено: {0}","Not applied:":"Не применено:","No answer: if the address changed, the page {0}":"Нет ответа: если адрес изменился, страница {0}","No answer: if the address changed, the page":"Нет ответа: если адрес изменился, страница","is now at {0}.":"теперь доступна по адресу {0}.","{0} restarted with the new setting.":"{0}: служба перезапущена с новой настройкой.","Saved, but {0} was not restarted:":"Сохранено, но службу {0} не удалось перезапустить:","Re-registering the ONU…":"Повторная регистрация ONU…","Rebuilding the connections in place…":"Перестроение соединений…","Applied. The Status tab shows O5 and the Services tab the provisioned services once the OLT is done.":"Применено. После завершения настройки OLT на вкладке «Состояние» появится O5, а в «OMCI → Сервисы» — назначенные сервисы.","Applied. The Status tab shows O5 and the Services tab the":"Применено. После завершения настройки OLT на вкладке «Состояние» появится O5, а в «OMCI → Сервисы» —","provisioned services once the OLT is done.":"назначенные сервисы.","Applied. The ONU stayed in O5.":"Применено. ONU осталась в состоянии O5.","Apply failed: {0}":"Ошибка применения: {0}","Apply failed:":"Ошибка применения:","The reboot was refused.":"Перезагрузка отклонена.","Restarting OMCI…":"Перезапуск OMCI…","Applied: the OMCI daemon restarted and the ONU is re-registering.":"Применено: служба OMCI перезапущена, ONU регистрируется заново.","Reporting the stored identity":"В OLT передаются сохранённые данные идентификации","Reporting the image defaults":"В OLT передаются данные идентификации по умолчанию","The OLT is told the versions, model, hardware version, OMCC version and product code below. An empty key keeps the default.":"OLT получает указанные ниже версии ПО, модель, аппаратную версию, версию OMCC и код продукта. Для пустых параметров используются значения по умолчанию.","The OLT is told software version 0.0.0, the device id as model and hardware version, OMCC 128 and product code 15, whatever the keys below hold.":"Независимо от параметров ниже OLT получает версию ПО 0.0.0, ID устройства в качестве модели и аппаратной версии, OMCC 128 и код продукта 15.","Some OLTs provision a service only for the identity they expect: one they do not expect can leave the ONU in O5 with no service. Switching interrupts internet while the ONU registers again.":"Некоторые OLT назначают сервисы только устройствам с ожидаемой идентификацией. При несовпадении ONU может достичь O5 без работающих сервисов. Переключение прервёт интернет на время повторной регистрации.","Some OLTs provision a service only for the identity they":"Некоторые OLT назначают сервисы только устройствам с ожидаемой","expect: one they do not expect can leave the ONU in O5 with no service. Switching":"идентификацией. При несовпадении ONU может достичь O5 без работающих сервисов. Переключение","interrupts internet while the ONU registers again.":"прервёт интернет на время повторной регистрации.","Report the defaults":"Использовать значения по умолчанию","Report the stored identity":"Передавать сохранённые данные","Switched. It takes effect when OMCI is applied.":"Переключено. Изменение вступит в силу после применения OMCI.","Software version the OLT sees":"Версии ПО, передаваемые в OLT","The OLT at the other end":"Сведения об OLT","VLANs this line allows":"Разрешённые VLAN","VLAN translation":"Преобразование VLAN","How this line is bridged":"Порты моста","Upstream containers (T-CONT)":"Контейнеры восходящего трафика (T-CONT)","allocation id":"Alloc-ID","GEM ports":"Порты GEM","GEM port id":"GEM Port-ID","Version":"Версия","Active":"Активен","Image {0}":"Образ {0}","The only version string your ISP sees. Check it here after every flash if it has to match the ONU you replaced.":"Эти версии ПО ONU сообщает в OLT. Если требуется соответствие заменённому ONT, проверяйте их после обновления прошивки.","The only version string your ISP sees. Check it here after every flash":"Эти версии ПО ONU сообщает в OLT. Если требуется соответствие заменённому ONT,","if it has to match the ONU you replaced.":"проверяйте их после обновления прошивки.","Matches what partition {0} holds.":"Совпадает с версией в разделе {0}.","Matches what partition":"Совпадает с версией в разделе","holds.":".","Partition {0} holds “{1}”, which is not what the OLT was told. That is expected here: omcid reports 0.0.0 unless the ONU identity switch is on (Config), and then {2} for this image. Set the key, turn the switch on and apply to choose the reported string -- a change the OLT sees, so only on a line that checks it.":"В разделе {0} записана версия «{1}», а в OLT передаётся другая. Это отдельная настройка: при отключённой подмене идентификации omcid сообщает 0.0.0, при включённой — значение {2}. Если провайдер проверяет версию, задайте её в «Настройки → Идентификация ONU», включите подмену и примените OMCI.","holds “":"записана версия «","”, which is not":"», а в OLT передаётся другая.","what the OLT was told. That is expected here: omcid reports 0.0.0":"Это отдельная настройка: omcid сообщает 0.0.0,","unless the ONU identity switch is on (Config), and then":"пока подмена идентификации отключена, а после её включения —","for this image. Set the key, turn the switch on and apply to choose":"для этого образа. Чтобы изменить передаваемую версию, задайте параметр,","the reported string -- a change the OLT sees, so only on a line that":"включите подмену и примените OMCI. Это требуется только там, где OLT","checks it.":"проверяет версию.","Vendor":"Производитель","not reported":"нет данных","No tag filters are installed.":"Фильтры тегов VLAN не настроены.","The OLT allows one VLAN on this line: {0}.":"OLT разрешила VLAN {0}.","The OLT allows one VLAN on this line:":"OLT разрешила VLAN","The OLT allows these VLANs on this line: {0}.":"OLT разрешила VLAN: {0}.","The OLT allows these VLANs on this line:":"OLT разрешила VLAN:","Tag a VLAN outside that list and the ONU still reaches O5 while the traffic is discarded — which looks exactly like a dead line. The forwarding-operation byte that decides how strict each filter is shows unread in the raw view.":"Состояние O5 подтверждает регистрацию ONU, но не прохождение трафика. Кадры с VLAN вне списка могут отбрасываться. Действие фильтра задаёт поле ForwardOperation; его исходное значение доступно ниже.","Tag a VLAN outside that list and the ONU still reaches O5":"Состояние O5 подтверждает регистрацию ONU, но не прохождение трафика.","while the traffic is discarded — which looks exactly like a dead line.":"Кадры с VLAN вне списка могут отбрасываться.","The forwarding-operation byte that decides how strict each filter is":"Действие фильтра задаёт поле ForwardOperation;","shows unread in the raw view.":"его исходное значение доступно ниже.","No VLAN translation rules are installed: the OLT is not rewriting tags on this line.":"Правил преобразования VLAN нет: OLT не настроила замену тегов на этой линии.","No VLAN translation rules are installed: the OLT is not":"Правил преобразования VLAN нет:","rewriting tags on this line.":"OLT не настроила замену тегов на этой линии.","any VLAN":"любой VLAN","no tag added":"без добавления тега","priority {0}":"приоритет {0}","priority":"приоритет","The OLT expects VLAN {0} on the fibre and calls it VLAN {1} on your side.":"По правилу OLT на стороне оптики используется VLAN {0}, на стороне роутера — VLAN {1}.","The OLT expects VLAN":"По правилу OLT на стороне оптики используется VLAN","on the fibre and calls it VLAN":", на стороне роутера — VLAN","on your side.":".","Which of the two your router should tag is the most common thing to get wrong here. An ONU that applies this rule wants {0}. Users of this Realtek chipset report it does not apply the rule, and that {1} is what works. If one carries no traffic, try the other.":"Если модуль применяет это правило, роутеру нужен VLAN {0}. Для некоторых прошивок на Realtek сообщалось, что преобразование не выполняется и работает VLAN {1}. Само наличие правила в MIB не подтверждает его применение в аппаратном тракте.","Which of the two your router should tag is the most common":"Если модуль применяет это правило, роутеру нужен VLAN","thing to get wrong here. An ONU that applies this rule wants":". Для некоторых прошивок на Realtek сообщалось, что преобразование не выполняется и работает VLAN","apply the rule, and that":"преобразование не выполняется и работает VLAN","is what works. If one":". Само наличие правила","carries no traffic, try the other.":"не подтверждает его применение в аппаратном тракте.","physical Ethernet UNI":"Физический порт Ethernet UNI","GEM interworking TP":"Точка взаимодействия GEM (IW TP)","No bridge ports. The OLT has not built a data path.":"Портов моста нет. OLT ещё не настроила тракт передачи данных.","The bridge carries both the physical Ethernet UNI and the VEIP.":"К мосту подключены физический порт Ethernet UNI и виртуальный интерфейс VEIP.","The bridge carries the physical Ethernet UNI.":"К мосту подключён физический порт Ethernet UNI.","The bridge carries the VEIP, not the physical port.":"К мосту подключён виртуальный интерфейс VEIP.","type {0}":"тип {0}","type":"тип","Each row is a bridge port and what the OLT attached to it. The pointer is the entity id of a managed entity on this stick, so it can be looked up on the MIB tab; a type shown as a bare number is one no capture here has pinned down.":"В таблице показано, какие интерфейсы OLT подключила к портам моста. Последний столбец — ID соответствующего экземпляра ME; его можно найти в обозревателе MIB. Если тип указан числом, его название здесь не определено.","Each row is a bridge port and what the OLT attached to it.":"В таблице показано, какие интерфейсы OLT подключила к портам моста.","The pointer is the entity id of a managed entity on this stick, so it":"Последний столбец — ID соответствующего экземпляра ME;","can be looked up on the MIB tab; a type shown as a bare number is one":"его можно найти в обозревателе MIB. Если тип указан числом,","no capture here has pinned down.":"его название здесь не определено.",", by {0}":", идентификаторы {0}",", by":", идентификаторы","None assigned":"Не назначены","assigned":"назначено","provisioned":"настроено","{0} unassigned: created by the ONU, not given an {1} by the OLT.":"Не назначено: {0}. Эти T-CONT созданы ONU, но OLT не назначила им {1}.","unassigned: created by the ONU, not given an":"не назначено: созданы ONU, но OLT не назначила им","by the OLT.":".","The MIB answered with no rows, but the ONU always creates this entity itself, so the read is incomplete. It says nothing about the line.":"MIB вернула пустой ответ, хотя этот экземпляр должна создавать сама ONU. Чтение неполное; делать выводы о состоянии линии по нему нельзя.","The MIB answered with no rows, but the ONU always creates this entity itself,":"MIB вернула пустой ответ, хотя этот экземпляр должна создавать сама ONU.","so the read is incomplete. It says nothing about the line.":"Чтение неполное; делать выводы о состоянии линии по нему нельзя.","None":"Нет","The MIB holds none: the OLT has not provisioned any.":"Экземпляров нет: OLT их не создала.","This dump was longer than the daemon will hold; what you see is the start of it.":"Вывод не поместился в буфер службы. Показано только начало.","This dump was longer than the daemon will hold; what":"Вывод не поместился в буфер службы.","you see is the start of it.":"Показано только начало.","the fibre service drops while the ONU ranges again":"соединение прерывается на время повторной регистрации ONU","read only at boot":"читается только при загрузке","{0}router sends them. On a line whose OLT accepts only tagged frames the service {1}":"{0}отправляет роутер. Если OLT принимает только кадры с тегом VLAN, сервис {1}","The stick stops tagging VLAN {0}: upstream frames reach the OLT as the":"Модуль перестанет добавлять тег VLAN {0}: кадры будут передаваться в OLT в том виде, в котором их","router sends them. On a line whose OLT accepts only tagged frames the service":"отправляет роутер. Если OLT принимает только кадры с тегом VLAN, сервис","stops at once, while the ONU stays in O5, unless the router tags VLAN {0} itself.":"сразу перестанет работать, хотя ONU останется в O5. Роутер должен сам добавлять тег VLAN {0}.","{0}carry that VLAN the service stops at once, while the ONU stays in O5.":"{0}этот VLAN, сервис сразу перестанет работать, хотя ONU останется в O5.","The stick starts tagging untagged frames with VLAN {0}. If the OLT does not":"Модуль начнёт добавлять тег VLAN {0} к нетегированным кадрам. Если OLT не пропускает","carry that VLAN the service stops at once, while the ONU stays in O5.":"этот VLAN, сервис сразу перестанет работать, хотя ONU останется в O5.","The stick tags with VLAN {0} instead of {1}. If the OLT does not carry":"Модуль будет добавлять VLAN {0} вместо {1}. Если OLT не пропускает","VLAN {0} the service stops at once, while the ONU stays in O5.":"VLAN {0}, сервис сразу перестанет работать, хотя ONU останется в O5.","Class B+ receive window":"Диапазон приёма класса B+","Class B+ launch power":"Мощность передатчика класса B+","No reading":"Нет данных","Out of window":"Вне диапазона","Near the edge":"Близко к границе","dB":"дБ","{0} dB":"{0} дБ","{0}: no reading.":"{0}: нет данных.",": no reading.":": нет данных."};
