#!/bin/sh
# Observed vendor request shapes, with synthetic configuration and TCIs.
set -u
Q=qemu-mips-static
fail=0
. ./testlib.sh
check() {
    if [ "$2" = "$3" ]; then echo "ok    $1"; else
        echo "FAIL  $1: got $2, expected $3"; fail=$((fail + 1));
    fi
}
frame() {
    body=${5:-}
    pad=$((64 - ${#body}))
    printf '%s%s0a%s%s%s' "$1" "$2" "$3" "$4" "$body"
    [ "$pad" -eq 0 ] || printf "%0${pad}d" 0
    printf '0000002800000000\n'
}
expect() {
    got=$(grep -c "^-> $2" "$log" || true)
    check "$1" "$got" 1
}
mkdir -p /var/config /var/run /var/log
cp ../../test/fixtures/omci-store-isp1.xml /var/config/lastgood.xml
rm -f /var/config/lastgood_hs.xml /var/run/omcid-resume-decision
{
    printf 'OMCI_FIXED_ME='
    for id in 0101 0102 0103 0104; do
        printf '65311:0x%s:2:00000000 ' "$id"
        printf '65319:0x%s:1:00 65319:0x%s:2:01 65319:0x%s:3:01 ' "$id" "$id" "$id"
    done
    printf '\n'
} > /var/config/odi.conf
log=/tmp/omcid-e7.log
: > "$log"
$Q respond/build/omcid -w 12 > "$log" 2>&1 &
pid=$!
trap 'omcid_stop "$pid"' EXIT HUP INT TERM
omcid_up "$log"
for cls in 11 65319; do
    listing=$($Q cli/build/omcli mib "$cls")
    rows=$(printf '%s\n' "$listing" | grep -c "^$cls " || true)
    check "class $cls enumerates four LANs and private WLAN immediately after startup" "$rows" 5
done
inject_wait "$log" "$(frame e701 49 ff27 0101 4000)"
expect "LLDP starts disabled" e701290aff27010100400001
inject_wait "$log" "$(frame e702 48 ff27 0101 400000)"
expect "LLDP administrative write succeeds" e702280aff27010100
inject_wait "$log" "$(frame e703 49 ff27 0101 4000)"
expect "LLDP read reflects the write" e703290aff27010100400000
inject_wait "$log" "$(frame e704 49 ff27 0102 4000)"
expect "another UNI keeps its state" e704290aff27010200400001
inject_wait "$log" "$(frame e705 49 ff27 0101 a000)"
expect "no LLDP agent is claimed" e705290aff27010100a0000001
inject_wait "$log" "$(frame e706 48 ff27 0101 200000)"
expect "operational state is read-only" e706280aff2701010900002000
inject_wait "$log" "$(frame e707 48 ff27 0105 400000)"
expect "an unconfigured control instance is refused" e707280aff27010505
inject_wait "$log" "$(frame e708 44 ff27 0101 '')"
expect "the OLT cannot create an autonomous LLDP entity" e708240aff27010102
inject_wait "$log" "$(frame e709 49 000b 0102 0600)"
expect "secondary UNI reports disabled and no link" e709290a000b01020006000100
for id in 0102 0103 0104; do
    tci="e8${id#01}"
    inject_wait "$log" "$(frame "$tci" 49 000b "$id" f600)"
    expect "secondary UNI $id retains Ethernet type while down" "${tci}290a000b${id}00f6002f2f00000100"
done
inject_wait "$log" "$(frame e70a 49 0005 0101 2000)"
expect "cardholder includes the private WLAN in its logical count" e70a290a0005010100200005
inject_wait "$log" "$(frame e70b 49 0006 0101 4000)"
expect "circuit pack agrees on logical UNI count" e70b290a0006010100400005
inject_wait "$log" "$(frame e70c 49 0101 0000 8000)"
expect "ONU2-G equipment id is empty" e70c290a010100000080000000000000000000000000000000000000000000
inject_wait "$log" "$(frame e70d 4f 0002 0000 '')"
inject_wait "$log" "$(frame e70e 49 ff27 0101 4000)"
expect "MIB reset restores the configured default" e70e290aff27010100400001
for id in 0102 0103 0104; do
    tci="e9${id#01}"
    inject_wait "$log" "$(frame "$tci" 49 000b "$id" f600)"
    expect "reset preserves inactive UNI $id type and state" "${tci}290a000b${id}00f6002f2f00000100"
done
omcid_stop "$pid"
trap - EXIT HUP INT TERM
[ "$fail" -eq 0 ] || keep_log "$log" e7-test.log
suite_exit
