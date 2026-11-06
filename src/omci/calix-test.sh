#!/bin/sh
# Private telemetry wire contracts and read-only hardware-counter sampling.
set -u
Q=qemu-mips-static
B=${OMCID_BIN:-respond/build/omcid-drvtrace}
CAPS=020000ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00000000000000010000000300000002ffffffff000000000000001000000040000000800000000800000000000000100000000f00000440
fail=0
. ./testlib.sh
check() {
    if [ "$2" = "$3" ]; then echo "ok    $1"; else
        echo "FAIL  $1: got $2, expected $3"; fail=$((fail+1));
    fi
}
frame() {
    body=${5:-}
    pad=$((64-${#body}))
    printf '%s%s0a%s%s%s' "$1" "$2" "$3" "$4" "$body"
    [ "$pad" -eq 0 ] || printf "%0${pad}d" 0
    printf '0000002800000000\n'
}
expect() {
    got=$(grep -c "^-> $2" "$log" || true)
    check "$1" "$got" 1
}
ask() { inject_wait "$log" "$(frame "$1" "$2" "$3" "$4" "$5")"; }
counters() {
    printf '0 26 3\n0 35 4\n0 0 %s\n0 1 %s\n0 2 7\n0 3 8\n0 5 %s\n0 7 9\n0 8 10\n0 9 11\n' "$1" "$3" "$2" > /tmp/calix-counters
}
mkdir -p /var/config /var/run /var/log
cp ../../test/fixtures/omci-store-isp1.xml /var/config/lastgood.xml
rm -f /var/config/lastgood_hs.xml /var/run/omcid-mib.snap
printf 'OMCI_UNKNOWN_ME_OK=1\n' > /var/config/odi.conf
log=/tmp/omcid-calix.log
: > "$log"
$Q "$B" -w 12 > "$log" 2>&1 &
pid=$!
trap 'omcid_stop "$pid"' EXIT HUP INT TERM
omcid_up "$log"
ask ca01 49 ff02 0201 fe00
expect 'without E7, the existing multicast model is preserved' ca01290aff020201098000
ask ca02 49 ff00 0201 fc00
expect 'without E7, no new voice schema is enabled' ca02290aff000201000000
omcid_stop "$pid"
trap - EXIT HUP INT TERM

{
    printf 'OMCI_UNKNOWN_ME_OK=1\nOMCI_POTS_PORTS=2\nOMCI_FIXED_ME='
    for id in 0101 0102 0103 0104; do
        printf '65311:0x%s:2:00000000 65319:0x%s:1:00 ' "$id" "$id"
    done
    printf '\n'
} > /var/config/odi.conf
printf '100\n' > /tmp/calix-clock
counters 4294967312 8589934624 4294967290
: > "$log"
$Q "$B" -w 12 -c "$CAPS" -x /tmp/calix-counters -y /tmp/calix-clock > "$log" 2>&1 &
pid=$!
trap 'omcid_stop "$pid"' EXIT HUP INT TERM
omcid_up "$log"
before=$(grep -c '^drv ' "$log" || true)
for cls in 65280 65281 65282 65283; do
    rows=$($Q cli/build/omcli mib "$cls" | grep -c "^$cls " || true)
    check "class $cls has two POTS instances" "$rows" 2
done
ask ca10 49 ff00 0201 fc00
expect 'call counters return six packed uint32 values, not an empty mask' ca10290aff00020100fc00000000000000000000000000000000000000000000000000
ask ca11 5c ff01 0202 fc00
expect 'Get current data uses the same complete voice schema' ca113c0aff01020200fc00000000000000000000000000000000000000000000000000
ask ca12 49 ff02 0201 fe00
expect 'Ext3 answers the observed seven-attribute mask in 23 bytes' ca12290aff02020100fe000000000000000000000000000000000000000000000000
ask ca13 49 ff03 0201 ffc0
expect 'Ext4 has correctly packed ports, addresses and DSCP 46' ca13290aff03020100ffc000000000000000000000000000002e00000000
ask ca14 49 ff02 0203 fe00
expect 'a third nonexistent phone is not invented' ca14290aff02020305
ask ca15 44 ff02 0201 ''
expect 'voice telemetry cannot create a service' ca15240aff02020102
ask ca16 46 ff02 0201 ''
expect 'voice telemetry cannot delete a service' ca16260aff02020102
ask ca17 48 ff02 0201 800000000001
expect 'voice counters are read-only' ca17280aff0202010900008000
ask ca18 48 ff03 0201 00c00101
expect 'clearing empty local call statistics is accepted' ca18280aff03020100
ask ca19 49 ff00 0201 fe00
expect 'an overfull response reports the fitting mask' ca19290aff00020109fc00
ask ca1a 49 ff03 0201 0020
expect 'unknown voice attributes are reported, not guessed' ca1a290aff030201090000

ask ca20 49 ff1f 0101 7800
expect 'RX errors and 64-bit octets/packets come from the port' ca20290aff1f01010078000000000300000004000000010000001000000000fffffffa
ask ca21 49 ff1f 0101 0700
expect 'RX multicast/broadcast and TX octets have the correct direction' ca21290aff1f0101000700000000000000000700000000000000080000000200000020
ask ca22 49 ff1f 0101 00e0
expect 'TX packet classes are live, separate 64-bit values' ca22290aff1f01010000e00000000000000009000000000000000a000000000000000b
ask ca23 49 ff1f 0102 7800
expect 'logical UNI2 does not mirror physical traffic' ca23290aff1f0102007800000000000000000000000000000000000000000000000000

counters 4294968312 8589936624 6
printf '102\n' > /tmp/calix-clock
ask ca24 49 ff1f 0101 001e
expect 'rates and peaks use byte deltas over elapsed seconds' ca24290aff1f010100001e000001f4000001f4000003e8000003e8
ask ca25 49 ff1f 0101 0800
expect '32-bit packet wrap extends to a monotonic 64-bit count' ca25290aff1f01010008000000000100000006
ask ca26 48 ff1f 0101 800001
expect 'reset establishes a software baseline' ca26280aff1f010100
ask ca27 49 ff1f 0101 7800
expect 'software reset reports zero without clearing hardware' ca27290aff1f0101007800000000000000000000000000000000000000000000000000
ask ca28 49 ff1f 0101 0001
expect 'reset time uses the monotonic seconds clock' ca28290aff1f010100000100000066
ask ca29 49 ff1f 0101 001e
expect 'reset also clears the software peaks' ca29290aff1f010100001e00000000000000000000000000000000
ask ca2a 48 ff1f 0101 9000010000000000000000
expect 'mixed read-only/reset write is rejected atomically' ca2a280aff1f01010900001000
counters 4294968512 8589937024 10
printf '104\n' > /tmp/calix-clock
ask ca2b 49 ff1f 0101 1000
expect 'post-reset RX counts only bytes since the baseline' ca2b290aff1f010100100000000000000000c8
ask ca2c 49 ff1f 0101 001e
expect 'post-reset rates and peaks use new deltas' ca2c290aff1f010100001e0000006400000064000000c8000000c8
ask ca2d 49 ff1f 0101 0001
expect 'rejected mixed write did not change reset time' ca2d290aff1f010100000100000066
ask ca2e 48 ff1f 0101 800002
expect 'an invalid reset value cannot change counters' ca2e280aff1f01010900008000
ask ca2f 49 ff1f 0105 1000
expect 'unconfigured Ethernet instances are refused' ca2f290aff1f010505
ask ca26 48 ff1f 0101 800001
check 'a retransmitted reset repeats the cached response' "$(grep -c '^-> ca26280aff1f010100' "$log" || true)" 2
ask ca34 49 ff1f 0101 1000
expect 'a retransmitted reset cannot clear newly counted traffic' ca34290aff1f010100100000000000000000c8
ask ca35 49 ff1f 0101 0001
expect 'a retransmitted reset cannot move its timestamp' ca35290aff1f010100000100000066

rm -f /tmp/calix-counters
printf '108\n' > /tmp/calix-clock
ask ca30 49 ff1f 0101 1000
expect 'expired hardware data is an explicit failure' ca30290aff1f0101090000
ask ca31 49 ff1f 0102 1000
expect 'logical zeroes remain available without physical counters' ca31290aff1f01020010000000000000000000
counters 16 32 1
printf '110\n' > /tmp/calix-clock
ask ca32 49 ff1f 0101 1000
expect 'a hardware discontinuity never turns into a huge unsigned delta' ca32290aff1f01010010000000000000000010
ask ca33 49 ff1f 0101 0001
expect 'hardware discontinuity gets a new timestamp' ca33290aff1f01010000010000006e
after=$(grep -c '^drv ' "$log" || true)
check 'all telemetry Gets and Sets made no forwarding driver calls' "$after" "$before"
omcid_stop "$pid"
trap - EXIT HUP INT TERM
[ "$fail" -eq 0 ] || keep_log "$log" calix-test.log
suite_exit
