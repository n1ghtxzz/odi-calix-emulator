#!/bin/sh
# Software MIB protocol and isolation checks, synthetic data only.
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
mkdir -p /var/config /var/log /var/run
cp ../../test/fixtures/omci-store-isp1.xml /var/config/lastgood.xml
rm -f /var/config/lastgood_hs.xml
printf 'OMCI_EMULATION=1\n' > /var/config/odi.conf
printf '\117\115\105\061\000\005\000\014\000\000\000\301\227\074\371\067\000\013\001\001\000\000\000\001\001\002\000\001\000\001\001\000\057\044\001\000\000\000\005\001\000\000\002\000\002\000\001\002\000\000\001\000\001\005\003\000\000\001\000\001\003\004\000\000\002\000\002\044\001\013\000\000\002\000\002\377\377\377\120\000\001\000\000\000\005\001\000\000\002\000\002\022\064\002\002\000\001\000\001\007\003\001\000\004\000\074\000\001\002\003\004\005\006\007\010\011\012\013\014\015\016\017\020\021\022\023\024\025\026\027\030\031\032\033\034\035\036\037\040\041\042\043\044\045\046\047\050\051\052\053\054\055\056\057\060\061\062\063\064\065\066\067\070\071\072\073\004\010\000\001\000\001\011\005\004\000\004\000\004\101\102\103\104\377\121\000\001\000\000\000\001\001\000\000\004\000\004\000\000\000\052\377\122\000\001\000\000\000\000' > /etc/omci-emulation.bin
printf 'OMCI_EMULATION=0\n' > /var/config/odi.conf
log=/tmp/omcid-emulation-native.log
: > "$log"
$Q respond/build/omcid-drvtrace -a -w 12 > "$log" 2>&1 &
pid=$!
trap 'omcid_stop "$pid"; rm -f /etc/omci-emulation.bin' EXIT HUP INT TERM
omcid_up "$log"
inject_wait "$log" "$(frame e900 4d 0002 0000 '')"
native_upload=$(grep '^-> e9002d' "$log" | cut -c20-23)
omcid_stop "$pid"
trap - EXIT HUP INT TERM
rm -f /var/run/omcid-mib.snap
printf 'OMCI_EMULATION=1\n' > /var/config/odi.conf
log=/tmp/omcid-emulation.log
: > "$log"
$Q respond/build/omcid-drvtrace -a -w 12 > "$log" 2>&1 &
pid=$!
trap 'omcid_stop "$pid"; rm -f /etc/omci-emulation.bin' EXIT HUP INT TERM
omcid_up "$log"
check 'profile loads atomically' "$(grep -c 'software MIB: 5 entities' "$log")" 1
listing=$($Q cli/build/omcli emulation 65360)
check 'emulated ME is visible in CLI' "$(printf '%s\n' "$listing" | grep -c '^65360 Emulated 1')" 1
check 'secrets are masked' "$(printf '%s\n' "$listing" | grep -c 'attr5 \*\*')" 1
native_listing=$($Q cli/build/omcli mib 65360)
check 'normal MIB excludes software inventory' "$(printf '%s\n' "$native_listing" | grep -c '^65360 ' || true)" 0
before=$(grep -c '^drv ' "$log" || true)
inject_wait "$log" "$(frame ea01 49 ff50 0001 8000)"
expect 'initial scalar value' ea01290aff5000010080001234
inject_wait "$log" "$(frame ea02 48 ff50 0001 8000beef)"
expect 'scalar Set succeeds in software' ea02280aff50000100
inject_wait "$log" "$(frame ea03 49 ff50 0001 8000)"
expect 'Get reflects Set' ea03290aff500001008000beef
inject_wait "$log" "$(frame ea04 48 ff50 0001 400009)"
expect 'read-only field refuses Set' ea04280aff50000102
inject_wait "$log" "$(frame ea05 49 ff50 0001 1000)"
expect 'assumed width is unavailable in strict mode' ea05290aff500001090000
inject_wait "$log" "$(frame ea06 49 ff50 0001 2000)"
expect 'Get primes table length' ea06290aff5000010020000000003c
inject_wait "$log" "$(frame ea07 5a ff50 0001 20000000)"
expect 'first table chunk has 29 bytes' ea073a0aff500001002000000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c
inject_wait "$log" "$(frame ea08 5a ff50 0001 20000002)"
expect 'last table chunk is the remainder' ea083a0aff5000010020003a3b
inject_wait "$log" "$(frame ea09 5a ff50 0001 20000003)"
expect 'table walk is bounded' ea093a0aff50000103
inject_wait "$log" "$(frame ea0a 49 ff50 0001 0400)"
expect 'unknown attribute gets result nine' ea0a290aff500001090000
inject_wait "$log" "$(frame ea0b 49 ff50 0002 8000)"
expect 'unknown instance gets result five' ea0b290aff50000205
inject_wait "$log" "$(frame ea0c 49 000b 0101 8000)"
expect 'native UNI overrides shadow value' ea0c290a000b01010080002f
inject_wait "$log" "$(frame ea0d 46 ff51 0001 '')"
expect 'Delete is software-only' ea0d260aff51000100
inject_wait "$log" "$(frame ea0e 49 ff51 0001 8000)"
expect 'deleted instance cannot be read' ea0e290aff51000105
inject_wait "$log" "$(frame ea0f 44 ff51 0002 '')"
expect 'Create of a software instance succeeds' ea0f240aff51000200
inject_wait "$log" "$(frame ea10 49 ff51 0002 8000)"
expect 'created instance starts with template defaults' ea10290aff5100020080000000002a
check 'all software requests leave driver trace unchanged' "$(grep -c '^drv ' "$log" || true)" "$before"
inject_wait "$log" "$(frame ea11 4d 0002 0000 '')"
expect 'software inventory does not change native upload count' "ea112d0a00020000$native_upload"
inject_wait "$log" "$(frame ea1a 49 002f 2401 f000)"
expect 'unprovisioned native bridge never reads stale snapshot fields' ea1a290a002f240100f000000000000000
inject_wait "$log" "$(frame ea1b 44 002f 2401 0001050324010001000100000000)"
expect 'native bridge is created through its real handler' ea1b240a002f240100
inject_wait "$log" "$(frame ea1c 49 002f 2401 f000)"
expect 'native Create stores bridge and mapper pointers' ea1c290a002f240100f000000105032401
inject_wait "$log" "$(frame ea1d 48 002f 2401 00202222)"
inject_wait "$log" "$(frame ea1e 49 002f 2401 f000)"
expect 'TD-only Set preserves previously created bridge fields' ea1e290a002f240100f000000105032401
inject_wait "$log" "$(frame ea12 4f 0002 0000 '')"
inject_wait "$log" "$(frame ea13 49 ff50 0001 8000)"
expect 'MIB reset restores profile defaults' ea13290aff5000010080001234
inject_wait "$log" "$(frame ea14 5a ff50 0001 20000000)"
expect 'reset invalidates table snapshot' ea143a0aff50000103
inject_wait "$log" "$(frame ea15 49 ff50 0001 2000)"
inject_wait "$log" "$(frame ea16 49 00ab 0000 0400)"
inject_wait "$log" "$(frame ea17 5a ff50 0001 20000000)"
expect 'native table Get replaces software snapshot' ea173a0aff50000103
inject_wait "$log" "$(frame ea18 49 ff50 0001 2000)"
inject_wait "$log" "$(frame ea19 5a 00ab 0000 04000000)"
expect 'software table Get replaces native snapshot' ea193a0a00ab000003
omcid_stop "$pid"
trap - EXIT HUP INT TERM
printf 'OMCI_EMULATION=2\nOMCI_UNKNOWN_ME_OK=1\n' > /var/config/odi.conf
: > "$log"
$Q respond/build/omcid -w 12 > "$log" 2>&1 &
pid=$!
trap 'omcid_stop "$pid"; rm -f /etc/omci-emulation.bin' EXIT HUP INT TERM
omcid_up "$log"
inject_wait "$log" "$(frame eb01 49 ff50 0001 1000)"
expect 'experimental mode explicitly permits assumed width' eb01290aff50000100100009
inject_wait "$log" "$(frame eb02 48 ff50 0001 4000ff)"
expect 'existing unknown-ME policy keeps vendor write acknowledgement' eb02280aff50000100
inject_wait "$log" "$(frame eb03 49 ff50 0001 4000)"
expect 'unsupported compatibility write does not invent stored bytes' eb03290aff50000100400007
inject_wait "$log" "$(frame eb04 44 ff50 0001 01020304)"
expect 'preseeded vendor instance preserves compatible Create success' eb04240aff50000100
inject_wait "$log" "$(frame eb05 49 ff50 0001 0400)"
expect 'unmodelled vendor attribute preserves enabled compatibility reply' eb05290aff500001000000
omcid_stop "$pid"
printf 'OMCI_EMULATION=0\n' > /var/config/odi.conf
: > "$log"
$Q respond/build/omcid -w 12 > "$log" 2>&1 &
pid=$!
omcid_up "$log"
listing=$($Q cli/build/omcli emulation 65360)
check 'off switch removes all shadow entities' "$(printf '%s\n' "$listing" | grep -c '^65360 ' || true)" 0
omcid_stop "$pid"
trap - EXIT HUP INT TERM
printf 'OMCI_EMULATION=1\n' > /var/config/odi.conf
printf x >> /etc/omci-emulation.bin
: > "$log"
$Q respond/build/omcid -w 12 > "$log" 2>&1 &
pid=$!
trap 'omcid_stop "$pid"; rm -f /etc/omci-emulation.bin' EXIT HUP INT TERM
omcid_up "$log"
check 'corrupt profile is refused atomically' "$(grep -c 'invalid profile, overlay disabled' "$log")" 1
inject_wait "$log" "$(frame ec01 49 000b 0101 8000)"
expect 'invalid profile leaves native UNI working' ec01290a000b01010080002f
omcid_stop "$pid"
trap - EXIT HUP INT TERM
rm -f /etc/omci-emulation.bin
suite_exit
