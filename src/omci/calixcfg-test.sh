#!/bin/sh
# Observed Information writes and per-line configuration compatibility.
set -u
Q=qemu-mips-static
B=${OMCID_BIN:-respond/build/omcid-drvtrace}
fail=0
. ./testlib.sh
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
expect() {
    check "$1" "$(grep -c "^-> $2" "$log" || true)" 1
}
ask() { inject_wait "$log" "$(frame "$1" "$2" "$3" "$4" "$5")"; }
start() {
    : > "$log"
    $Q "$B" -w 12 -s 5 -g /tmp/calixcfg-gpon -y /tmp/calixcfg-clock > "$log" 2>&1 &
    pid=$!
    trap 'omcid_stop "$pid"; rm -f /etc/omci-emulation.bin' EXIT HUP INT TERM
    omcid_up "$log"
}
mkdir -p /var/config /var/run /var/log
cp ../../test/fixtures/omci-store-isp1.xml /var/config/lastgood.xml
rm -f /var/config/lastgood_hs.xml /var/run/omcid-mib.snap
printf '\117\115\105\061\000\003\000\004\000\000\000\114\154\063\120\144\000\206\000\000\000\000\000\001\002\002\000\006\000\006\002\000\000\000\012\001\000\206\000\001\000\000\000\002\002\002\000\006\000\006\002\000\000\000\012\002\011\002\000\004\000\004\012\143\143\143\000\361\000\000\000\000\000\001\001\016\000\014\000\014\124\105\123\124\060\060\060\060\060\060\060\061' > /etc/omci-emulation.bin
printf 'state 5 (O5)\nonu_id 1\nsn 4f44495400000001\nalloc_ids 0\n' > /tmp/calixcfg-gpon
printf '100\n' > /tmp/calixcfg-clock
printf 'OMCI_UNKNOWN_ME_OK=1\nOMCI_POTS_PORTS=2\n' > /var/config/odi.conf
log=/tmp/omcid-calixcfg-off.log
start
ask cb01 49 00f4 0201 8000
expect 'outside E7 the original loop-detection schema remains' cb01290a00f4020100800000
ask cb02 49 008a 0001 4400
expect 'outside E7 native default config values remain unchanged' cb02290a008a00010044000000
ask cb03 49 0086 0001 4000
expect 'outside E7 a native IP-host MAC ignores the profile' cb03290a00860001004000000000000000
omcid_stop "$pid"; trap - EXIT HUP INT TERM
rm -f /var/run/omcid-mib.snap
{
    printf 'OMCI_UNKNOWN_ME_OK=1\nOMCI_POTS_PORTS=2\nOMCI_EMULATION=1\nOMCI_FIXED_ME='
    for id in 0101 0102 0103 0104; do
        printf '65311:0x%s:2:00000000 65319:0x%s:1:00 ' "$id" "$id"
    done
    printf '\n'
} > /var/config/odi.conf
log=/tmp/omcid-calixcfg.log
start
before=$(grep -c '^drv ' "$log" || true)
ask cb10 49 00f1 0000 8000
expect 'manufacturing identity comes from the private profile' cb10290a00f10000008000544553543030303030303031
listing=$($Q cli/build/omcli mib 241)
check 'manufacturing identity stays masked in ordinary CLI' "$(printf '%s\n' "$listing" | grep -c 'MfgSerialNumber.*\*' || true)" 1
ask cb11 48 00f1 0000 400060000000
expect 'the observed four-byte DateTime Set is stored' cb11280a00f1000000
ask cb12 49 00f1 0000 4000
expect 'DateTime Get returns the OLT time' cb12290a00f1000000400060000000
ask cb13 48 00f1 0000 00600000465000
expect 'observed TZoffset and DST packing is accepted' cb13280a00f1000000
ask cb14 49 00f1 0000 0060
expect 'TZoffset and DST are read back, not discarded' cb14290a00f100000000600000465000
ask cb15 48 00f1 0000 200001
expect 'TelnetEnable is stored as compatibility data' cb15280a00f1000000
ask cb16 49 00f1 0000 2000
expect 'TelnetEnable Get reflects the stored value' cb16290a00f1000000200001
printf '105\n' > /tmp/calixcfg-clock
ask cb17 49 00f1 0000 4000
expect 'OLT DateTime advances on a separate monotonic anchor' cb17290a00f1000000400060000005
ask cb11 48 00f1 0000 400060000000
check 'repeated DateTime Set reuses the cached reply' "$(grep -c '^-> cb11280a00f1000000' "$log" || true)" 2
ask cb18 49 00f1 0000 4000
expect 'a duplicate Set cannot rewind DateTime' cb18290a00f1000000400060000005
ask cb19 48 00f1 0000 8000414141414141414141414141
expect 'manufacturing identity is read-only' cb19280a00f100000900008000
ask cb1a 49 00f1 0001 4000
expect 'Information has only instance zero' cb1a290a00f1000105
ask cb1b 44 00f1 0000 ''
expect 'Information cannot create a hardware object' cb1b240a00f1000002
ask cb20 49 00f4 0201 8000
expect 'first phone extension returns Calix idle status' cb20290a00f4020100800001
ask cb21 49 00f4 0202 8000
expect 'second phone extension is independently present' cb21290a00f4020200800001
ask cb22 49 00f4 0203 8000
expect 'no third POTS extension is invented' cb22290a00f4020305
ask cb23 48 00f4 0201 800000
expect 'CallStatus cannot start loop-detection programming' cb23280a00f402010900008000
ask cb24 49 00f4 0201 4000
expect 'loop-detection attributes are not exposed in E7 PotsUniExt' cb24290a00f40201090000
for id in 0001 0002; do
    tci="cc${id#00}"
    ask "$tci" 49 008a "$id" 4400
    expect "config instance $id reports SIP and configured" "${tci}290a008a${id}0044000101"
done
ask cb25 49 008a 0000 4400
expect 'legacy config instance zero is unchanged' cb25290a008a00000044000000
ask cb26 48 008a 0001 58000000ffff
expect 'captured Calix automatic config write succeeds' cb26280a008a000100
ask cb27 49 008a 0001 4400
expect 'automatic protocol zero resolves to selected SIP one' cb27290a008a00010044000101
ask cb28 49 008a 0001 3800
expect 'config methods, method and address match the sane dump fields' cb28290a008a00010038000000000700ffff
ask cb29 49 008a 0002 0100
expect 'profile version uses the standard 25-byte string width' cb29290a008a000200010030000000000000000000000000000000000000000000000000
ask cb2a 49 008a 0003 4400
expect 'a third config instance is refused' cb2a290a008a000305
ask cb2b 48 008a 0001 100002
expect 'an unsupported retrieval method cannot change the line' cb2b280a008a00010900001000
ask cb2c 49 008a 0001 1000
expect 'a rejected method write leaves the prior method intact' cb2c290a008a000100100000
after=$(grep -c '^drv ' "$log" || true)
check 'all compatibility writes made no forwarding driver calls' "$after" "$before"
before_mac=$(grep -c '^drv ' "$log" || true)
ask ce00 49 0086 0000 4000
expect 'native host zero reads its exact binary MAC seed' ce00290a00860000004000020000000a01
ask ce01 49 0086 0001 40e0
expect 'diagnostic mask packs the MAC without copying current IP seed data' ce01290a008600010040e0020000000a02000000000000000000000000
ask ce02 49 0086 0002 4000
expect 'a host without an exact seed retains its native MAC' ce02290a00860002004000000000000000
after_mac=$(grep -c '^drv ' "$log" || true)
check 'IP-host diagnostic Gets make no forwarding driver calls' "$after_mac" "$before_mac"
ask ce03 48 0086 0001 10000a070809
expect 'native static IP writes still succeed' ce03280a0086000100
ask ce04 49 0086 0001 5000
expect 'native IP and profile MAC are independent fields' ce04290a00860001005000020000000a020a070809
ask ce05 48 0086 0001 400002000000beef
expect 'the profile-supplied MAC remains read-only' ce05280a008600010900004000
ask ce06 49 0086 0001 4000
expect 'a rejected MAC Set cannot alter the seed' ce06290a00860001004000020000000a02
omcid_stop "$pid"; trap - EXIT HUP INT TERM
printf '110\n' > /tmp/calixcfg-clock
log=/tmp/omcid-calixcfg-resume.log
start
ask cd01 49 00f1 0000 4000
expect 'DateTime and its anchor survive daemon respawn' cd01290a00f100000040006000000a
ask cd02 49 00f1 0000 0060
expect 'Information fields survive the ordinary native snapshot' cd02290a00f100000000600000465000
ask cd03 49 008a 0001 4400
expect 'config aliases survive daemon respawn' cd03290a008a00010044000101
ask cd07 49 0086 0001 5000
expect 'MAC seed and native IP survive the ordinary daemon resume' cd07290a00860001005000020000000a020a070809
ask cd04 4f 0002 0000 ''
ask cd05 49 00f1 0000 2000
expect 'MIB reset discards stored Information changes' cd05290a00f1000000200000
ask cd06 49 008a 0001 4400
expect 'MIB reset retains Calix per-line defaults' cd06290a008a00010044000101
ask cd08 49 0086 0001 5000
expect 'MIB reset clears native IP while retaining the private MAC' cd08290a00860001005000020000000a0200000000
omcid_stop "$pid"; trap - EXIT HUP INT TERM
sed -i 's/OMCI_EMULATION=1/OMCI_EMULATION=0/' /var/config/odi.conf
log=/tmp/omcid-calixcfg-overlay-off.log
start
ask ce10 49 0086 0001 4000
expect 'disabling the overlay restores the original native MAC' ce10290a00860001004000000000000000
omcid_stop "$pid"; trap - EXIT HUP INT TERM
sed -i 's/OMCI_EMULATION=0/OMCI_EMULATION=1/' /var/config/odi.conf
rm -f /etc/omci-emulation.bin
log=/tmp/omcid-calixcfg-missing-profile.log
start
ask ce11 49 0086 0001 4000
expect 'a missing private profile leaves the native MAC unchanged' ce11290a00860001004000000000000000
omcid_stop "$pid"; trap - EXIT HUP INT TERM
[ "$fail" -eq 0 ] || keep_log "$log" calixcfg-test.log
suite_exit
