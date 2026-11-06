/*
 * Reading the OMCI MIB, and turning what omcicli prints into something the two
 * ME pages can render.
 *
 * One parser, two pages. `mebrowser.js` shows the blocks as they came;
 * `services.js` picks a handful apart and says what they mean. Both go through
 * here so there is exactly one place that knows the output shape -- and that
 * shape is not consistent even within one firmware. ME 84 prints `EntityID`,
 * ME 171 prints `EntityId`, and a table's rows are bare lines with no key at
 * all. The parser is deliberately permissive about all of it: an attribute it
 * does not recognise still reaches the page as text, because a MIB dump this
 * daemon cannot label is far more useful than one it drops.
 */

import { get } from './dom.js';

/*
 * omcicli frames each table with rows of X and separates instances with rows of
 * =. Both are decoration; neither carries data.
 */
const isBanner = (l) => /^X{3,}\s*$/.test(l);
const isRule = (l) => /^={3,}\s*$/.test(l);

/*
 * Parse one `omcicli mib get` dump.
 *
 * Returns { name, instances: [ { id, attrs: [[k, v]], groups: [{label, attrs}], raw } ] },
 * where `raw` is the instance's own lines as printed.
 *
 * `name` is the table name omcicli itself printed, and the pages display it
 * rather than the label they asked for. That is the check that keeps a wrong
 * class id from being quietly mislabelled: ask for 84 and the card says
 * whatever came back, so a mismatch is visible instead of assumed away.
 */
function parseOmci(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, ''));
  const instances = [];
  let name = '';
  let cur = null;
  let group = null;

  /* `end` is the line that closed the instance, so each one keeps the lines
     it was read from: the MIB browser's raw view shows one entity as the
     device printed it, without a second parser to find it again. */
  const flush = (end) => {
    if (cur && (cur.attrs.length || cur.groups.length)) {
      cur.raw = lines.slice(cur.from, end).join('\n').trimEnd();
      instances.push(cur);
    }
    cur = null;
    group = null;
  };

  let rows = null;
  let odi = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    /*
       odi-oss omcid prints its own shape for every class it has no vendor
       renderer for: a `<class> <Name> <instance>` header per row, then one
       `    Attr   <hex bytes>` line per attribute, and a `N rows` count at
       the end. Read off src/omci/respond/show.c (cli_row). Values are raw
       bytes, so they are turned into what the vendor dump would have
       printed: a number as 0x.., a string as its text.
    */
    const hdr = /^(\d+) (\S+) (\d+)(\s+\(row truncated\))?\s*$/.exec(line);
    if (hdr) {
      flush(i);
      odi = true;
      name = hdr[2];
      cur = { id: '0x' + Number(hdr[3]).toString(16).padStart(4, '0'), attrs: [], groups: [], truncated: !!hdr[4], from: i };
      continue;
    }
    const cnt = /^(\d+) rows?\s*$/.exec(line);
    if (cnt) { flush(i); rows = Number(cnt[1]); continue; }
    if (odi && cur) {
      const a = /^ {4}(\S+)\s+([0-9a-fA-F]+)\s*$/.exec(line);
      if (a) { (group ? group.attrs : cur.attrs).push([a[1], hexValue(a[2])]); continue; }
      if (/^ {4}(\S+)\s*$/.test(line)) { group = { label: line.trim(), attrs: [] }; cur.groups.push(group); continue; }
      const g = /^ {6}\s*(\d+)\s+(.*)$/.exec(line);
      if (g && group) { group.attrs.push([g[1], g[2]]); continue; }
    }

    /* The table name sits between two banner rows, once, at the top. */
    if (isBanner(line)) {
      const next = lines[i + 1];
      if (next && !isBanner(next) && !isRule(next) && isBanner(lines[i + 2] || '')) {
        name = next.trim();
        i += 2;
      }
      continue;
    }
    if (isRule(line)) { flush(i); continue; }

    const t = line.trim();
    if (!t) continue;
    if (!cur) { cur = { id: '', attrs: [], groups: [], from: i }; group = null; }

    /*
       An INDENTED line continues the attribute above it rather than starting
       anything. Real dumps do this in at least two places: ME 131 breaks
       `ToDInfo` into tab-indented sub-lines that themselves contain colons,
       and ME 171 follows `DscpToPbitMapping:` with eight indented hex words
       and no colons at all. Treating those as new keys or new sub-tables
       produced eight empty headings and attached the instance's own remaining
       attributes to the last INDEX row.
    */
    if (/^\s/.test(line) && (group ? group.attrs.length : cur.attrs.length)) {
      const into = group ? group.attrs : cur.attrs;
      const last = into[into.length - 1];

      last[1] = last[1] ? last[1] + ' ' + t : t;
      continue;
    }

    const c = t.indexOf(':');
    if (c > 0) {
      const k = t.slice(0, c).trim();
      const v = t.slice(c + 1).trim();
      if (/^entity\s*id$/i.test(k)) cur.id = v;
      (group ? group.attrs : cur.attrs).push([k, v]);
    } else {
      /* A line with no colon opens a sub-table: `ReceivedFrameVlanTaggingOperTable`
         and then one `INDEX n` per row. */
      group = { label: t, attrs: [] };
      cur.groups.push(group);
    }
  }
  flush(lines.length);
  return { name, instances, rows };
}

/* Raw attribute bytes from the odi-oss dump, as the vendor dump would print
   them: up to four bytes is a number; longer is a string if it reads as one
   (NUL padding dropped), and hex otherwise. */
function hexValue(hex) {
  if (hex.length <= 8) return '0x' + hex;
  const t = hex.replace(/(00)+$/, '');
  if (!t) return '';
  let out = '';
  for (let i = 0; i < t.length; i += 2) {
    const c = parseInt(t.slice(i, i + 2), 16);
    if (c < 0x20 || c > 0x7e) return '0x' + hex;
    out += String.fromCharCode(c);
  }
  return out;
}

/* Case-insensitive attribute lookup, top level only. */
function attr(inst, key) {
  const want = String(key).toLowerCase();
  for (const [k, v] of inst.attrs) if (k.toLowerCase() === want) return v;
  return null;
}

/*
 * Fetch one dump. Never throws for a device-side condition: an ONU that has not
 * registered answers with nothing at all, and "nothing at all" is a finding the
 * pages render, not an error they hide.
 */
async function fetchOmci(params) {
  const qs = new URLSearchParams(params).toString();
  try {
    const r = await get('/api/omci?' + qs);
    return {
      raw: r.raw || '',
      truncated: !!r.truncated,
      ok: r.ok !== false,
      error: r.error || '',
      ...parseOmci(r.raw || ''),
    };
  } catch (e) {
    return { raw: '', truncated: false, ok: false, error: String(e.message || e), name: '', instances: [] };
  }
}

/*
 * Whether a dump means "the MIB service did not answer" rather than "this table
 * is empty".
 *
 * Both failure modes were seen on our own sticks: `omcicli` either prints
 * nothing at all, or prints its registered-table listing instead of the table
 * you asked for. Rendering either as "the OLT has not created any" is the most
 * misleading thing this page could say -- it reads as a provisioning fault on a
 * line that is carrying traffic. Both were seen with the stock omci_app, which
 * stops servicing its request queue after a long run; omcid has not shown it,
 * but a daemon that is not running answers the same way.
 */
function unavailable(dump) {
  if (!dump.ok) return dump.error || 'the MIB could not be read';
  const raw = String(dump.raw || '');

  if (!raw.trim())
    return 'omcicli returned nothing: the OMCI daemon is not answering. '
         + 'Check that omcid is running (ps); starting it again is described '
         + 'in the image docs (TOOLS.md, Restarting a daemon).';
  if (/^no managed entity called /m.test(raw))
    return 'omcid does not know this table: ' + raw.trim();
  if (/^TableId\s*\[\d+\]\s*Name:/m.test(raw) && !dump.instances.length)
    return 'omcicli listed its tables instead of reading the one asked for, '
         + 'which is how the stock omci_app fails when it has stopped '
         + 'servicing its request queue.';
  return null;
}

/* One ME, by class id or table name. */
const fetchMe = (me, entity) =>
  fetchOmci(entity ? { cmd: 'me', me, entity } : { cmd: 'me', me });

export { parseOmci, attr, fetchOmci, fetchMe, unavailable };

export const UI_RU_PART_5 = {"Create (the default) is what the stick has always done. None presents the ONU as pure PPTP: no VEIP, no UNI-G of the VEIP, no TR-069 server, and no cardholder or circuit pack of the VEIP slot, five entities fewer in the MIB upload; only for an OLT that provisions the physical UNI and never a bridge port on a VEIP. Applying re-registers the ONU, so the fibre service drops meanwhile. A separate key from the VEIP slot because the stock firmware reads that one as a slot number only. Read by omcid at start and on SIGHUP, by this image, not the stock firmware.":"При отключении ONU представляет только физические UNI: исчезают VEIP, его UNI-G, сервер TR-069, слот и плата. Подходит лишь для OLT, которая настраивает физический UNI и не использует VEIP. Применение прерывает связь для повторной регистрации ONU. Номер слота задаётся отдельно. Только для этой прошивки.","The three vendor-private entities the ONU creates for itself (350, 370 and 373; 373 carries a third-party product string), as the stock firmware does.":"Самостоятельно создаваемые ONU классы 350, 370 и 373, как в штатной прошивке.","Leave them out only for an OLT that rejects or mistrusts them. Applying re-registers the ONU, so the fibre service drops meanwhile. Read by omcid at start and on SIGHUP, by this image, not the stock firmware.":"Класс 373 содержит строку стороннего продукта. Отключайте только для OLT, которая отклоняет эти объекты. Применение вызывает повторную регистрацию и кратковременный разрыв связи. Только для этой прошивки.","Lets the OLT reboot the stick over OMCI.":"По умолчанию перезагрузка через OMCI запрещена.","Off by default. On, a Reboot of the ONU-G is answered with success and the stick restarts a second later (the fibre is down for the boot); acknowledge only answers success and does not reboot, for an OLT that insists on a successful answer; off, it is refused with command not supported. Read each time the OLT sends a Reboot, so a change is in effect at once. Read by this image, not the stock firmware.":"Значение 1 подтверждает команду Reboot для ONU-G и перезагружает модуль через секунду; оптическая связь прерывается. Режим acknowledge только подтверждает команду, не перезагружая устройство. Значение 0 отклоняет команду как неподдерживаемую. Изменение действует сразу. Только для этой прошивки.","Entities of a native ONU that this stick has no model for, answered with bytes you copy from that ONU.":"Ответы на ME, для которых у omcid нет собственной модели.","Up to 16 entries, one per row: the class (1 to 65535), the instance (0 to 65535, decimal or 0x hex), the attribute (1 to 16) and its bytes in hex (optional 0x, 1 to 25 bytes), e.g. 200:0x8001:1:0x0011aa. Rows with the same class and instance are one entity with several attributes: it is listed in the MIB upload, a Get of it answers the attributes asked for that it has, and a Get of any other instance of the class is answered as unknown. Instance and attribute both set to any (the form CLASS:HEX) answers every instance of the class, and the entity is not in the MIB upload. Only a class omcid has no model of its own for is answered: an implemented class is never overridden. A slot cannot be listed twice, and a class cannot be in both forms. Empty removes the key. Anything malformed turns the whole key off in omcid, so it is refused here before it is written. Applying re-registers the ONU, so the OLT provisions it again and the fibre service drops meanwhile. The bytes stay on this stick, in odi.conf, are not logged and are redacted from the diagnostics bundle. Read by omcid at start and on SIGHUP, by this image, not the stock firmware.":"Значения копируются из исходного ONT. До 16 записей: CLASS:INSTANCE:ATTR:HEX, например 200:0x8001:1:0x0011aa. Класс: 1–65535; экземпляр: 0–65535 или 0x в hex; атрибут: 1–16; значение: 1–25 байт в hex. Записи одного класса и экземпляра образуют ME, включаемый в MIB Upload. Формат CLASS:HEX отвечает для любого экземпляра и не включается в MIB Upload. Реализованные классы не переопределяются. Дубли и смешение двух форматов запрещены. Пустое поле удаляет параметр; неверная запись отключает его целиком. Применение вызывает повторную регистрацию ONU и разрыв связи. Данные хранятся в odi.conf, не записываются в журналы и скрываются в архиве диагностики. Только для этой прошивки.","Whether the host port (the SFP edge, toward the router) runs auto-negotiation.":"По умолчанию включено, как в штатной прошивке: согласуется 1000BASE-X.","On, the default and what the stock firmware does, negotiates 1000BASE-X with the router; off forces 1000BASE-X full duplex, for a router port with auto-negotiation off. Changed only from Config, Network, Host port, as a trial that reverts by itself after two minutes unless kept; never by Save. A boot whose forced link does not come up runs auto-negotiation and says so; three short power cycles in a row clear it. Read by this image, not the stock firmware.":"При отключении принудительно используется 1000BASE-X, полный дуплекс. Меняется только временной проверкой в «Настройки → Сеть → Соединение с роутером», с откатом через две минуты без подтверждения. Если принудительный режим не установит соединение при загрузке, автосогласование временно включится. Три коротких включения питания сбрасывают настройку. Только для этой прошивки.","How the host port (the SFP edge, toward the router) talks to the router. fiber1g, the default and what the stock firmware does, is 1000BASE-X (Fiber 1G, the most compatible); 2500basex is 2500BASE-X, for a router port that runs 2.5G, with auto-negotiation off; hisgmii is HiSGMII.":"fiber1g — 1000BASE-X, штатный и наиболее совместимый режим; 2500basex — 2500BASE-X без автосогласования, если роутер поддерживает 2.5G; hisgmii — HiSGMII.","Changed only from Config, Network, Host port, as a trial that reverts by itself after two minutes unless kept; never by Save. A 2500basex boot that sees no link runs Fiber 1G and says so; three short power cycles in a row clear it. While it is not fiber1g, HOST_AUTONEG cannot be tried. Read by this image, not the stock firmware.":"Меняется только временной проверкой в «Настройки → Сеть», с откатом через две минуты без подтверждения. При отсутствии соединения в 2.5G модуль временно запустится в Fiber 1G. Три коротких включения питания сбрасывают настройку. В режимах, отличных от fiber1g, проверка HOST_AUTONEG недоступна. Только для этой прошивки.","The remote syslog collector, as `host` or `host:port`; empty (the shipped default) leaves remote logging off.":"Сервер журналов в формате host или host:port.","Read by this image, not the stock firmware. Letters, digits, dots and hyphens only, optional port 1-65535.":"Пустое поле отключает удалённую запись. Допустимы буквы, цифры, точки и дефисы; порт необязателен, от 1 до 65535. Только для этой прошивки.","The NTP server, as `host` or `host:port`; empty (the shipped default) leaves the NTP client off.":"Сервер времени в формате host или host:port.","Read by this image, not the stock firmware. Passed to busybox `ntpd -p`, which resolves the string with the shared host2sockaddr/str2sockaddr helper -- a bare host defaults to port 123, and a trailing `:port` overrides it. Letters, digits, dots and hyphens only, optional port 1-65535.":"Пустое поле отключает NTP-клиент. Используется busybox ntpd -p; порт по умолчанию — 123. Допустимы буквы, цифры, точки и дефисы; порт от 1 до 65535. Только для этой прошивки.","Lets the stick follow the IGMP of the router behind it and apply what the OLT provisions for multicast: one row per group, and the group limit and access lists of the profile.":"Отслеживает IGMP от роутера и применяет multicast-профиль OLT: группы, ограничения и списки доступа.","Experimental, and not yet run against a real multicast stream. Off, multicast is flooded as it always was. Saving restarts the snooping daemon; the fibre service is not touched. Read by this image, not the stock firmware.":"Работа с реальным multicast-потоком ещё не проверена. При отключении multicast передаётся на все подходящие порты. Сохранение перезапускает службу snooping, не разрывая PON. Только для этой прошивки.","Also drops multicast from the fibre that no host asked for, so a group nobody joined stays off the host link.":"Отбрасывает multicast с оптической стороны, если ни один хост не подписался на группу.","Experimental. It is the one part of snooping that can cut a stream, so it is a separate switch and off by default. Does nothing while IGMP snooping is off. Saving restarts the snooping daemon; the fibre service is not touched. Read by this image, not the stock firmware.":"Может прервать поток, поэтому по умолчанию отключено и вынесено отдельно. Работает только с IGMP snooping. Сохранение перезапускает службу без разрыва PON. Только для этой прошивки.","Snoops IPv6 multicast the way IGMP snooping does for IPv4, on the same multicast profile: one row per group, and the group limit and access lists of the profile.":"Отслеживает IPv6 multicast по тому же профилю, что и IGMP snooping для IPv4.","Router advertisements, neighbour discovery and DHCPv6 are never pruned. With the drop of unjoined multicast on, unjoined IPv6 groups are dropped too. Experimental. Off, IPv6 multicast is flooded as it always was. Does nothing while IGMP snooping is off. Saving restarts the snooping daemon; the fibre service is not touched. Read by this image, not the stock firmware.":"Router Advertisement, Neighbor Discovery и DHCPv6 не отбрасываются. При включённом отбрасывании групп без подписки оно действует и для IPv6. Требуется IGMP snooping. При отключении IPv6 multicast передаётся без фильтрации по подпискам. Сохранение перезапускает службу без разрыва PON. Только для этой прошивки.","Keeps the stick switched off, laser included, once the OLT has disabled it, across restarts and power-offs, until the OLT enables it again.":"После отключения ONU со стороны OLT сохраняет это состояние, включая выключенный лазер, через перезагрузки и отключения питания.","Experimental. Off by default, because a stick that stays dark can be brought back only by the OLT. Read at boot, so a change needs a reboot. Read by this image, not the stock firmware.":"Восстановить работу сможет только OLT. По умолчанию отключено. Изменение требует перезагрузки. Только для этой прошивки.","Makes the stick tell the OLT it is restarting on purpose, just before an orderly restart or power-off, so the OLT can tell that from a lost ONU.":"Отправляет OLT уведомление Dying_Gasp перед штатной перезагрузкой или выключением.","Experimental. Off by default, because what the OLT does with it is not known: one that gets it without a restart following may drop and re-activate the ONU. Read at boot, so a change needs a reboot. Read by this image, not the stock firmware.":"По умолчанию отключено: реакция OLT не проверена; уведомление без последующей перезагрузки может вызвать деактивацию ONU. Изменение требует перезагрузки. Только для этой прошивки.","Switches the laser on even when the laser driver chip is not the one this image was validated with.":"Разрешает включение лазера, даже если микросхема его драйвера не проверена с этой прошивкой.","Off, such a stick keeps the laser off and refuses to activate on the fibre. A laser that lights outside its timeslot takes down every other ONU on the OLT port, so set it only on a port with no other ONU. Read at boot, so a change needs a reboot. Read by this image, not the stock firmware.":"По умолчанию такой лазер остаётся отключённым. Излучение вне своего временного слота может нарушить работу всех ONU на порту OLT. Допустимо только на изолированном стенде без других ONU. Изменение требует перезагрузки. Только для этой прошивки.","Whether the stick obeys the OLT when it locks the Ethernet port.":"При включении, как в штатной прошивке, команда OLT отключает Ethernet-порт до разблокировки.","On, as on the stock firmware, the host link goes down until the OLT unlocks it; on this SFP that port is the only way in, so a lock also cuts this page and ssh. Off ignores the lock and the port stays up. Read at every lock, so a change is in effect at once. Read by this image, not the stock firmware.":"У SFP это единственный путь управления, поэтому пропадут веб-интерфейс и SSH. При отключении команда блокировки игнорируется. Изменение действует при следующей команде OLT без перезапуска. Только для этой прошивки.","What a T-CONT the OLT has not set reports as its Alloc-ID.":"Alloc-ID, возвращаемый для T-CONT, который OLT ещё не настроила через OMCI. ploam — назначенный по PLOAM ID, как в штатной прошивке. unassigned — стандартное значение «не назначен».","Ploam, the default and what the stock firmware does, reports the one the OLT assigned on the fibre; unassigned reports the standard not-assigned value. Use unassigned only with an OLT that sets the Alloc-ID itself and picks the first T-CONT that reports empty; one that reads it back may treat the T-CONT as unusable. Read at every Get, so a change is in effect at once. Read by this image, not the stock firmware.":"Второй вариант нужен лишь OLT, которая сама назначает Alloc-ID, выбирая первый свободный T-CONT; другие OLT могут считать его непригодным. Изменение действует сразу. Только для этой прошивки.","Tells the OLT the stick has 1 or 2 phone ports, so an OLT that offers voice can provision a SIP line on each for the router behind the stick.":"Сообщает OLT о наличии одного или двух телефонных портов для назначения SIP-линий.","Experimental. The stick has no phone socket, places no call and registers nothing, and the voice does not reach the router yet: the line can be provisioned and carries nothing. Saving re-registers the ONU, so it interrupts internet while the OLT provisions it again. Read by this image, not the stock firmware.":"Физических POTS-портов у SFP нет: звонки и регистрацию выполняет внешний SIP-клиент или АТС. Наличие параметров SIP в MIB само по себе не гарантирует передачу голосового трафика. Применение вызывает повторную регистрацию ONU и прерывает интернет. Только для этой прошивки.","The slot of the phone circuit pack, 2 to 254 and not 6, 128 or the VEIP's slot.":"Номер слота телефонной платы: 2–254, кроме 6, 128 и слота VEIP.","Empty takes the first free slot from 2 up. Has no effect unless Phone ports is 1 or 2 (this page cannot show that dependency). Saving re-registers the ONU, so it interrupts internet. A value that is not a free slot is ignored by omcid. Read by this image, not the stock firmware.":"Пустое поле выбирает первый свободный слот начиная с 2. Действует только при одном или двух телефонных портах. Занятый слот omcid игнорирует. Применение вызывает повторную регистрацию ONU и прерывает интернет. Только для этой прошивки.","Lets the router behind the stick tell it whether its SIP client is registered (the Phone tab and the API say how), and shows the OLT that state as the line status instead of \"config done\".":"Внешний роутер или АТС может передавать состояние регистрации SIP через API; оно отображается в разделе «Телефония» и передаётся OLT как состояние линии.","Only a report received in the last 5 minutes counts; without one the line reads \"config done\", as with the key off. Has no effect unless Phone ports is 1 or 2. Read at every Get, so a change is in effect at once. Read by this image, not the stock firmware.":"Отчёт действует пять минут, затем используется «настройка завершена». Требуется хотя бы один телефонный порт. Изменение действует сразу. Только для этой прошивки.","/etc/config/lan-ip, when it exists, wins over this key.":"Если существует /etc/config/lan-ip, используется адрес из этого файла.","A change is a trial (mgmt-addr.sh): applied, kept only when confirmed over the new address.":"Изменение проходит временную проверку через mgmt-addr.sh и сохраняется только после подтверждения с нового адреса.","1 adds the second address beside the first, 0 removes it.":"1 добавляет дополнительный адрес, 0 удаляет его.","Applied at once, as a trial; the first address is not touched.":"Проверяется временно; основной адрес не меняется.","A fixed rescue address, as br0:2.":"Резервный адрес br0:2.","Applied at once; a trial.":"Применяется сразу с временной проверкой.","omcid tags only with type 1 and manual mode 1, as the stock firmware does.":"omcid добавляет теги только при типе VLAN 1 и ручном режиме 1, как в штатной прошивке.","Applying makes omcid rebuild the bridge connections in place from the MIB it holds: the ONU stays in O5 and the fibre service is not dropped.":"При применении соединения моста перестраиваются по текущей MIB; ONU остаётся в O5, повторная регистрация не выполняется.","See VLAN config mode.":"См. режим настройки VLAN.","Switching between stick tags and router tags (transparent) is rebuilt in place, without re-ranging the ONU.":"Переключение между тегированием на модуле и прозрачной передачей перестраивает соединения без повторной регистрации ONU.","Answered to CTC-profile OLTs in the LOID authentication entity.":"Передаётся OLT с профилем CTC в ME аутентификации LOID.","Written with LOID_OLD, because the OLD value wins whenever the two differ.":"Записывается вместе с LOID_OLD, потому что при различии используется значение OLD.","Reported only while the ONU identity switch is on; otherwise 0.0.0.":"Передаётся только при включённой подмене идентификации, иначе — 0.0.0.","The stock firmware may rewrite this key when it boots.":"Штатная прошивка может перезаписать параметр при загрузке.","An odi-only key, kept in odi.conf: empty removes it. Applying deactivates the ONU so the OLT reads the new version.":"Хранится в odi.conf; пустое поле удаляет параметр. Применение деактивирует ONU, чтобы OLT прочитала новую версию.","Read each time the OLT starts, activates or commits a software download, so a change is in effect at once and nothing is applied.":"Читается на каждом этапе загрузки ПО от OLT.","An odi-only key, kept in odi.conf.":"Действует сразу, без применения. Параметр этой прошивки, хранится в odi.conf.","Read each time the OLT sends a Reboot, so a change is in effect at once and nothing is applied.":"Читается при каждой команде Reboot от OLT.","Changes what omcid answers the OLT for classes it does not model, so applying re-registers the ONU and the OLT provisions it again with the new answers.":"Меняет ответы на неподдерживаемые классы ME. Применение вызывает повторную регистрацию ONU и настройку со стороны OLT.","An odi-only key, kept in odi.conf: empty removes it.":"Параметр этой прошивки, хранится в odi.conf.","Applying re-registers the ONU so the OLT reads the entities again.":"Пустое поле удаляет его. Применение вызывает повторную регистрацию, чтобы OLT перечитала ME.","Applying re-registers the ONU: the entities of the VEIP slot appear or disappear and the OLT provisions it again.":"При применении ONU регистрируется заново; ME слота VEIP появляются или исчезают.","The stock key, kept in the config store.":"Штатный параметр хранилища настроек.","Applying re-registers the ONU with the VEIP, its UNI-G, the TR-069 server, the cardholder and the circuit pack at the new entity ids, and the OLT provisions it again.":"При применении ONU регистрируется заново: VEIP, его UNI-G, сервер TR-069, слот и плата получают новые ID экземпляров.","Applying re-registers the ONU: the three vendor-private entities appear or disappear and the OLT provisions it again.":"При применении ONU регистрируется заново; три проприетарных ME появляются или исчезают.","Applying deactivates the ONU, writes the new serial into the PON MAC (the driver accepts it only while the ONU is deactivated) and ranges it again; the OLT sees a new ONU.":"Для применения ONU деактивируется, новый серийный номер записывается в PON MAC, затем выполняется повторная регистрация.","A reboot applies it too.":"OLT увидит новую ONU. Перезагрузка также применяет изменение.","Applying restarts igmpd; the fibre service stays up. The switch floods for the moment the daemon is gone.":"Применение перезапускает igmpd без разрыва PON; на время перезапуска multicast передаётся без фильтрации подписок.","Applying restarts igmpd. Only 1 drops; unset or anything else does not.":"Применение перезапускает igmpd. Только значение 1 включает отбрасывание.","Applying restarts igmpd. Only 1 turns MLD snooping on; unset or anything else leaves IPv6 multicast flooded. Needs IGMP_SNOOPING=1.":"Применение перезапускает igmpd. Только 1 включает MLD snooping; иначе IPv6 multicast передаётся без фильтрации подписок. Требуется IGMP_SNOOPING=1.","Takes effect at the next boot, which drops the service.":"Вступает в силу после перезагрузки, которая прерывает связь.","Read each time the OLT sets the port state, so a change is in effect at once and nothing is applied.":"Читается при каждой команде изменения состояния порта от OLT.","An odi-only key, kept in odi.conf. A MIB reset or a restart always unlocks the port.":"Действует сразу. Хранится в odi.conf. Сброс MIB или перезапуск всегда снимает блокировку порта.","Read at every Get and MIB upload, so a change needs no reload and no re-registration.":"Читается при каждом Get и MIB Upload.","Applying re-registers the ONU: the phone entities appear or disappear and the OLT provisions it again.":"При применении ONU регистрируется заново; телефонные ME появляются или исчезают.","Applying re-registers the ONU.":"Пустое поле удаляет его. Применение вызывает повторную регистрацию ONU.","Read at every Get of the line status, so a change needs no reload and no re-registration.":"Читается при каждом Get состояния линии.","This takes about eighty seconds and the stick must not lose power meanwhile. The partition you are running now is not touched, and nothing boots the new one until you try it.":"Запись займёт около 80 секунд. Не отключайте питание. Текущий раздел сохранится; новая прошивка запустится только после пробной загрузки.","Commit to partition {0}?":"Закрепить раздел {0}?","It becomes the one the stick boots by default, instead of partition {0}. If it later fails to come up, the stick keeps booting it: there is no trial to fall back from.":"Этот раздел будет загружаться по умолчанию вместо раздела {0}. При сбое модуль продолжит запускать его; автоматического отката больше не будет.","It becomes the one the stick boots by default. If it later fails to come up, the stick keeps booting it: there is no trial to fall back from.":"Этот раздел будет загружаться по умолчанию. При сбое модуль продолжит запускать его; автоматического отката больше не будет.","Partition {0} will boot once, at the next reboot. If it fails, the stick returns to partition {1}, the committed one, on its own. Continue?":"При следующей перезагрузке раздел {0} будет запущен один раз. Если загрузка не удастся, модуль сам вернётся к закреплённому разделу {1}. Продолжить?","Partition {0} will boot once, at the next reboot. If it fails, the stick returns to partition {1}, the committed one, on its own.":"При следующей перезагрузке раздел {0} будет запущен один раз. Если загрузка не удастся, модуль сам вернётся к закреплённому разделу {1}.","Partition {0} holds the stock firmware ({1}).":"Раздел {0} содержит штатную прошивку ({1}).","Partition {0} holds an image that is not odi-oss ({1}).":"Раздел {0} содержит другую прошивку ({1}).","Partition {0} holds an image this page cannot identify ({1}).":"Раздел {0} содержит неопределённую прошивку ({1}).","The stick reboots and the fibre service drops for about two minutes. This is a trial of partition {0}: the reboot comes back on partition {1}, the committed one, not on this image.":"Модуль перезагрузится. Оптическое соединение прервётся примерно на две минуты. Сейчас выполняется пробная загрузка раздела {0}; после перезагрузки запустится закреплённый раздел {1}.","The stick reboots and the fibre service drops for about two minutes. This is a trial of partition {0}: the reboot comes back on partition {1}, the committed one, not on this image. Continue?":"Модуль перезагрузится. Оптическое соединение прервётся примерно на две минуты. Сейчас выполняется пробная загрузка раздела {0}; после перезагрузки запустится закреплённый раздел {1}. Продолжить?","It is the last one: on an image whose root password is locked, nothing else lets you log in over ssh. To get it back you have to paste it again.":"Это последний ключ. Если вход по паролю root запрещён, доступ по SSH будет потерян. Для восстановления ключ придётся добавить заново.","Whoever holds its private half can no longer log in. To get it back you have to paste it again.":"Владелец этого закрытого ключа больше не сможет войти. Для восстановления ключ придётся добавить заново.","Try {0} on the host port?":"Проверить режим {0} на порту к роутеру?","If the router port does not run this mode, the link drops and this page stops answering. Nothing is stored until you keep it: the stick goes back by itself after two minutes (120 s).":"Если порт роутера не поддерживает этот режим, соединение и доступ к странице пропадут. Настройка сохранится только после подтверждения. Без него через две минуты (120 с) будет автоматический откат.","Write {0} identity key(s) ({1})?":"Записать параметры идентификации: {0} ({1})?","Only do this onto the stick the backup came from: on another stick the OLT would see the same serial number twice.":"Восстанавливайте эти параметры только на модуле, с которого снята копия. Иначе OLT увидит два устройства с одинаковым серийным номером.","The stick stops tagging VLAN {0}: upstream frames reach the OLT as the router sends them. On a line whose OLT accepts only tagged frames the service stops at once, while the ONU stays in O5, unless the router tags VLAN {1} itself. Continue?":"Модуль перестанет добавлять тег VLAN {0}. В OLT кадры будут уходить в том виде, в котором их отправляет роутер. Если провайдер принимает только кадры с тегом VLAN, сервис сразу перестанет работать, хотя ONU останется в O5. Роутер должен сам добавлять тег VLAN {1}. Продолжить?","The stick starts tagging untagged frames with VLAN {0}. If the OLT does not carry that VLAN the service stops at once, while the ONU stays in O5. Continue?":"Модуль начнёт добавлять тег VLAN {0} к нетегированным кадрам. Если OLT не пропускает этот VLAN, сервис сразу перестанет работать, хотя ONU останется в O5. Продолжить?","The stick tags with VLAN {0} instead of {1}. If the OLT does not carry VLAN {2} the service stops at once, while the ONU stays in O5. Continue?":"Модуль будет добавлять тег VLAN {0} вместо {1}. Если OLT не пропускает VLAN {2}, сервис сразу перестанет работать, хотя ONU останется в O5. Продолжить?","The management address is tried now: the stick moves to {0}. The address it has now keeps working beside it, and this page opens the new one by itself when it answers (the browser asks for the password again there). The stick goes back to the old address after 90 seconds unless you press Keep on the new one. Nothing is stored until you do. Continue?":"Начать временную проверку адреса управления {0}? Прежний адрес останется доступен. Новый адрес откроется автоматически; войдите заново и подтвердите его. Без подтверждения через 90 секунд будет откат. До подтверждения настройка не сохраняется. Продолжить?","The management address changes now, and this page with it, to {0}. Continue?":"Адрес управления изменится сейчас. Страница откроется по адресу {0}. Продолжить?","This page stopped following the reboot after {0} minutes. Reload it to see where the stick is. If it ran a trial image, it comes back on the committed one, at the address that image has.":"Наблюдение за перезагрузкой остановлено через {0} мин. Обновите страницу, чтобы проверить доступность. После пробной загрузки модуль возвращается к закреплённой прошивке и её IP-адресу.","No answer after {0} minutes. If the stick ran a trial image that did not come up, it reverts to the committed one by itself, which takes another minute or two. This page keeps trying.":"Нет ответа уже {0} мин. Если пробный образ не загрузится, модуль вернётся к закреплённой прошивке ещё через одну-две минуты. Проверка доступности продолжается.","This page is on the new address ({0}), so it works. Keep stores it; Revert, or no answer, goes back to the address before.":"Страница открыта по новому адресу ({0}); соединение работает. Нажмите «Подтвердить», чтобы сохранить адрес. Откат или отсутствие подтверждения вернёт прежний адрес.","This page is on {0}, which the stick already had, and it stays up meanwhile. It opens the new address by itself as soon as that answers; press Keep there. If it never answers, do nothing: the stick goes back by itself. Revert works from here.":"Страница открыта по прежнему адресу {0} и остаётся доступна. Новый адрес откроется автоматически, как только станет доступен; подтвердите его там. Если ответа нет, ничего не делайте: будет автоматический откат. Отменить изменение можно и здесь.","{0} does not answer from this computer yet, and this page keeps trying until the countdown ends. If this computer has no route to it, or it is the wrong address, press Revert, or do nothing: the stick goes back by itself and this address keeps working.":"Адрес {0} пока недоступен с этого компьютера. Проверка продолжится до конца отсчёта. Если маршрута к нему нет или адрес неверен, отмените изменение либо дождитесь автоматического отката. Прежний адрес продолжит работать.","{0} answers. Opening it now: the browser asks for the password again there, because it keeps the password per address. The countdown and Keep are on that page. If you cancel the prompt, go Back to this page.":"Адрес {0} доступен. Открываем его; потребуется повторный вход, поскольку браузер хранит данные входа отдельно для каждого адреса. Обратный отсчёт и подтверждение будут на новой странице. Если отмените вход, вернитесь сюда кнопкой «Назад».","Kept: on is stored.":"Подтверждено: сохранено включённое автосогласование.","Kept: off (forced 1000BASE-X full duplex) is stored.":"Подтверждено: сохранено 1000BASE-X без автосогласования, полный дуплекс.","Not kept in time: back to on. Nothing was stored.":"Нет подтверждения: восстановлено включённое автосогласование. Настройка не сохранена.","Not kept in time: back to off (forced 1000BASE-X full duplex). Nothing was stored.":"Нет подтверждения: восстановлено 1000BASE-X без автосогласования, полный дуплекс. Настройка не сохранена.","Reverted: back to on. Nothing was stored.":"Выполнен откат: восстановлено включённое автосогласование. Настройка не сохранена.","Reverted: back to off (forced 1000BASE-X full duplex). Nothing was stored.":"Выполнен откат: восстановлено 1000BASE-X без автосогласования, полный дуплекс. Настройка не сохранена.","Not applied: back to on. Nothing was stored.":"Не применено: восстановлено включённое автосогласование. Настройка не сохранена.","Not applied: back to off (forced 1000BASE-X full duplex). Nothing was stored.":"Не применено: восстановлено 1000BASE-X без автосогласования, полный дуплекс. Настройка не сохранена.","Kept: the management address is stored. The stick answers at on now.":"Адрес управления сохранён. Теперь модуль доступен по адресу включённое автосогласование.","Kept: the management address is stored. The stick answers at off (forced 1000BASE-X full duplex) now.":"Адрес управления сохранён. Теперь модуль доступен по адресу 1000BASE-X без автосогласования, полный дуплекс.","Not applied: on":"Не применено: включённое автосогласование","Not applied: off (forced 1000BASE-X full duplex)":"Не применено: 1000BASE-X без автосогласования, полный дуплекс"};
