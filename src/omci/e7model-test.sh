#!/bin/sh
# Provisioning state and extra interfaces, using synthetic configuration.
set -u
Q=qemu-mips-static
B=${OMCID_BIN:-respond/build/omcid-drvtrace}
fail=0
. ./testlib.sh
CAPS=020000ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00000000000000010000000300000002ffffffff000000000000001000000040000000800000000800000000000000100000000f00000440
check() {
    if [ "$2" = "$3" ]; then echo "ok    $1"; else
        echo "FAIL  $1: got $2, expected $3"; fail=$((fail+1));
    fi
}
frame() {
    body=${5:-}; pad=$((64-${#body}))
    printf '%s%s0a%s%s%s' "$1" "$2" "$3" "$4" "$body"
    [ "$pad" -eq 0 ] || printf "%0${pad}d" 0
    printf '0000002800000000\n'
}
ask() { inject_wait "$log" "$(frame "$1" "$2" "$3" "$4" "$5")"; }
expect() { check "$1" "$(grep -c "^-> $2" "$log" || true)" 1; }
start() {
    : > "$log"
    $Q "$B" -a -s 5 -w 45 -c "$CAPS" -g /tmp/e7model-gpon -l /tmp/e7model-link -x /tmp/e7model-counters -y /tmp/e7model-clock > "$log" 2>&1 &
    pid=$!
    trap 'omcid_stop "$pid"' EXIT HUP INT TERM
    omcid_up "$log"
}
mkdir -p /var/config /var/run /var/log
cp ../../test/fixtures/omci-store-isp1.xml /var/config/lastgood.xml
sed -i 's/Name="OMCI_CUSTOM_ME" Value="[0-9]*"/Name="OMCI_CUSTOM_ME" Value="37184"/' /var/config/lastgood.xml
sed -i '/Name="OMCI_CUSTOM_ME"/a\        <Value Name="OMCI_VEIP_SLOT_ID" Value="3"/>' /var/config/lastgood.xml
rm -f /var/config/lastgood_hs.xml /var/run/omcid-mib.snap /etc/omci-emulation.bin
printf 'state 5 (O5)\nonu_id 1\nsn 4f44495400000001\nalloc_ids 0\n' > /tmp/e7model-gpon
printf '1\n' > /tmp/e7model-link
printf '100\n' > /tmp/e7model-clock
printf '0 26 3\n0 35 4\n0 0 16\n0 1 100\n0 2 7\n0 3 8\n0 5 32\n0 7 9\n0 8 10\n0 9 11\n' > /tmp/e7model-counters
printf 'OMCI_UNKNOWN_ME_OK=1\nOMCI_POTS_PORTS=2\nOMCI_VEIP=1\n' > /var/config/odi.conf
log=/tmp/omcid-e7model-off.log
start
ask ea00 49 0197 0021 e000
expect 'outside E7 class 407 retains unknown-ME compatibility' ea00290a01970021000000
ask ea01 49 00fb 0101 07f2
expect 'outside E7 class 251 retains unknown-ME compatibility' ea01290a00fb0101000000
omcid_stop "$pid"; trap - EXIT HUP INT TERM
rm -f /var/run/omcid-mib.snap
{
    printf 'OMCI_UNKNOWN_ME_OK=1\nOMCI_POTS_PORTS=2\nOMCI_VEIP=1\nOMCI_FIXED_ME='
    for id in 0101 0102 0103 0104; do
        printf '65311:0x%s:2:00000000 65319:0x%s:1:00 ' "$id" "$id"
    done
    printf '\n'
} > /var/config/odi.conf
log=/tmp/omcid-e7model.log
start
sync_send "$log"
for cls in 11 65311 65319; do
    listing=$($Q cli/build/omcli mib "$cls")
    check "class $cls includes the private fifth interface" "$(printf '%s\n' "$listing" | grep -c "^$cls " || true)" 5
done
for cls in 329 340; do
    listing=$($Q cli/build/omcli mib "$cls")
    check "class $cls has the second configured-slot interface" "$(printf '%s\n' "$listing" | grep -c "^$cls " || true)" 2
done
before=$(grep -c '^drv ' "$log" || true)
ask ea02 49 0005 0101 2000
expect 'Ethernet cardholder includes private WLAN' ea02290a0005010100200005
ask ea03 49 0006 0101 4000
expect 'Ethernet pack reports five logical interfaces' ea03290a0006010100400005
ask ea04 49 0005 0103 2000
expect 'VEIP cardholder reports two interfaces' ea04290a0005010300200002
ask ea05 49 0006 0103 4000
expect 'VEIP pack reports two interfaces' ea05290a0006010300400002
ask ea06 49 000b 0107 f600
expect 'private WLAN has its original type and remains down' ea06290a000b010700f600282800000100
ask ea07 49 0108 0107 f000
expect 'private UNI-G points to the second VEIP' ea07290a0108010700f000000e00020302
ask ea08 49 ff27 0107 a000
expect 'private LLDP control claims no agent' ea08290aff27010700a0000001
ask ea09 49 ff1f 0107 7800
expect 'private WLAN counters are zero without physical samples' ea09290aff1f0107007800000000000000000000000000000000000000000000000000
ask ea0a 49 0149 0302 c000
expect 'second VEIP starts enabled as a software interface' ea0a290a0149030200c0000000
ask ea0b 48 0149 0302 800001
expect 'second VEIP stores its own administrative state' ea0b280a0149030200
ask ea0c 49 0149 0302 c000
expect 'second VEIP operational state follows its own lock' ea0c290a0149030200c0000101
ask ea0d 48 0149 0302 800000
expect 'second VEIP can unlock without toggling physical PON' ea0d280a0149030200
ask ea0e 48 000b 0107 080001
expect 'private WLAN accepts administrative data' ea0e280a000b010700
ask ea0f 44 0149 0302 ''
expect 'an autonomous second VEIP cannot be created by OLT' ea0f240a0149030202
ask eb00 46 000b 0107 ''
expect 'an autonomous private WLAN cannot be deleted by OLT' eb00260a000b010702
ask eb01 49 00fb 0101 07f2
expect 'uncreated extension is not reported as a fake instance' eb01290a00fb010105
ask eb02 44 00fb 0101 ''
expect 'observed empty class 251 constructor creates stored state' eb02240a00fb0101000000
ask eb02 44 00fb 0101 ''
check 'a repeated constructor uses its cached response' "$(grep -c '^-> eb02240a00fb0101000000' "$log" || true)" 2
ask eb03 44 00fb 0101 ''
expect 'a new Create for an existing extension is refused' eb03240a00fb010107
ask eb04 48 00fb 0101 07f20044000300040000007801010001
expect 'class 251 stores the observed scalar-mask layout' eb04280a00fb010100
ask eb05 49 00fb 0101 07f2
expect 'class 251 scalar readback returns nonzero stored data' eb05290a00fb01010007f20044000300040000007801010001
ask eb06 48 00fb 0101 000101
expect 'class 251 final policy byte is independently stored' eb06280a00fb010100
ask eb07 49 00fb 0101 0001
expect 'class 251 final policy byte reads back' eb07290a00fb010100000101
ask eb08 48 00fb 0101 10000001
expect 'unmeasured static-table size is read-only' eb08280a00fb01010900001000
ask eb09 49 00fb 0101 0800
expect 'unknown static IP table format remains empty' eb09290a00fb010100080000000000
ask eb0a 48 00fb 0101 080000000000
expect 'opaque static IP entries cannot be silently accepted' eb0a280a00fb01010900000800
ask eb0b 44 00fb 0102 01
expect 'unobserved nonempty creation data is refused' eb0b240a00fb010202
ask eb0c 44 0197 0021 003c003c00
expect 'public SIP agent extension parses the real constructor shape' eb0c240a01970021000000
ask eb0d 49 0197 0021 e000
expect 'both SIP OPTIONS timers and Boolean read back' eb0d290a0197002100e000003c003c00
ask eb0e 48 0197 0021 c000004b005a
expect 'SIP OPTIONS timers can change as stored policy' eb0e280a0197002100
ask eb0f 49 0197 0021 e000
expect 'updated SIP OPTIONS timers remain independent' eb0f290a0197002100e000004b005a00
ask ec00 48 0197 0021 200002
expect 'undefined revertive Boolean is refused' ec00280a019700210900002000
ask ec01 49 0197 0021 2000
expect 'rejected Boolean does not change stored policy' ec01290a0197002100200000
ask ec02 48 0197 0021 10000a070809
expect 'resolved proxy data cannot be written by OLT' ec02280a019700210900001000
ask ec03 49 0197 0021 1e00
expect 'no external SIP resolution is fabricated' ec03290a01970021001e00000000000000000000000000
ask ec04 49 0197 0022 e000
expect 'another SIP agent extension is not invented' ec04290a0197002205
after=$(grep -c '^drv ' "$log" || true)
check 'extension and software-interface operations made no driver calls' "$after" "$before"
ask ec05 49 0086 0001 40e0
wire=$(sed -n 's/^-> ec05/ ec05/p' "$log" | tail -n 1 | tr -d ' ')
diag=$(sed -n 's/^diag-reply ec05/ec05/p' "$log" | tail -n 1)
check 'diagnostic log is the exact serialized reply including CRC' "$diag" "$wire"
trace_before=$(grep -c '^diag-reply ' "$log" || true)
ask ec06 49 0094 0001 2000
ask ec07 49 0086 0001 4000
check 'credential and non-whitelisted IP-host masks are not traced' "$(grep -c '^diag-reply ' "$log" || true)" "$trace_before"
: > /tmp/e7model-burst.txt
i=0
while [ "$i" -lt 520 ]; do
    frame "$(printf '%04x' $((0xed00+i)))" 49 000b 0107 f600 >> /tmp/e7model-burst.txt
    i=$((i+1))
done
$Q cli/build/omcli --inject-file /tmp/e7model-burst.txt > /dev/null
wait_for "$log" '^-> ef0729' 15
check 'diagnostic trace has a bounded per-process budget' "$(grep -c '^diag-reply ' "$log" || true)" 512
keep_log "$log" e7model-wire.log
omcid_stop "$pid"; trap - EXIT HUP INT TERM
log=/tmp/omcid-e7model-resume.log
start
ask ec08 49 00fb 0101 07f2
expect 'class 251 data survives ordinary daemon resume' ec08290a00fb01010007f20044000300040000007801010001
ask ec09 49 0197 0021 e000
expect 'class 407 data survives ordinary daemon resume' ec09290a0197002100e000004b005a00
ask ec0a 46 0197 0021 ''
expect 'class 407 can be deleted without SIP side effects' ec0a260a0197002100
ask ec0b 49 0197 0021 e000
expect 'deleted class 407 is no longer readable' ec0b290a0197002105
ask ec0c 4f 0002 0000 ''
ask ec0d 49 00fb 0101 07f2
expect 'MIB reset discards class 251 provisioning' ec0d290a00fb010105
ask ec0e 49 0149 0302 c000
expect 'MIB reset restores the software VEIP defaults' ec0e290a0149030200c0000000
keep_log "$log" e7model-resume.log
omcid_stop "$pid"; trap - EXIT HUP INT TERM
sed -i 's/^OMCI_VEIP=1$/OMCI_VEIP=0/' /var/config/odi.conf
log=/tmp/omcid-e7model-veip-off.log
start
listing=$($Q cli/build/omcli mib 11)
check 'VEIP off retains four LAN views without private WLAN' "$(printf '%s\n' "$listing" | grep -c '^11 ' || true)" 4
listing=$($Q cli/build/omcli mib 329)
check 'VEIP off creates neither virtual interface' "$(printf '%s\n' "$listing" | grep -c '^329 ' || true)" 0
omcid_stop "$pid"; trap - EXIT HUP INT TERM
[ "$fail" -eq 0 ] || keep_log "$log" e7model-test.log
suite_exit
