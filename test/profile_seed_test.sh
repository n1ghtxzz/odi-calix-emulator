#!/bin/bash
# The actual first-boot seed script, with only its file paths and flash
# writer replaced. No device, config partition or boot environment is used.
set -eu
cd "$(dirname "$0")/.."
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/profile" "$scratch/config"
export ODI_PROFILE_DIR="$scratch/profile" ODI_CONFIG_DIR="$scratch/config"
export ODI_PROFILE_FLASH="$scratch/flash" TEST_PROFILE_LOG="$scratch/writes"
cat > "$scratch/flash" <<'SH'
#!/bin/sh
printf '%s %s %s\n' "$1" "$2" "$3" >> "$TEST_PROFILE_LOG"
[ "${TEST_PROFILE_FAIL:-0}" != 1 ]
SH
chmod 755 "$scratch/flash"
printf '%064d\n' 1 > "$scratch/profile/id"
printf '192.168.2.1\n' > "$scratch/profile/lan-ip"
printf 'OMCI_UNI_LOCK=0\nOMCI_UNKNOWN_ME_OK=1\n' > "$scratch/profile/odi.conf"
printf 'GPON_SN=ODIT00000001\nGPON_ONU_MODEL=\n' > "$scratch/profile/identity.env"
sh rootfs/skeleton/etc/scripts/profile-seed.sh
test "$(cat "$scratch/config/lan-ip")" = 192.168.2.1
test -f "$scratch/config/omci-identity.on"
test "$(wc -l < "$scratch/writes")" -eq 4
cmp "$scratch/profile/id" "$scratch/config/image-profile.id"
echo 'ok first boot applies settings and management before marking completion'
sh rootfs/skeleton/etc/scripts/profile-seed.sh
test "$(wc -l < "$scratch/writes")" -eq 4
echo 'ok another boot preserves owner changes and writes nothing'
printf '%064d\n' 2 > "$scratch/profile/id"
if TEST_PROFILE_FAIL=1 sh rootfs/skeleton/etc/scripts/profile-seed.sh; then exit 1; fi
test "$(cat "$scratch/config/image-profile.id")" = "$(printf '%064d' 1)"
echo 'ok a failed writer leaves the old completion marker'
printf 'sw_commit=1\n' > "$scratch/profile/odi.conf"
if sh rootfs/skeleton/etc/scripts/profile-seed.sh 2>/dev/null; then exit 1; fi
test "$(cat "$scratch/config/image-profile.id")" = "$(printf '%064d' 1)"
echo 'ok a profile cannot write a boot-slot key'

# Actual flash script integration, with missing stock report keys and an
# existing authentication field. Neither a fixture reset nor a fake writer.
mkdir "$scratch/real" "$scratch/real-tmp"
export CS="$scratch/real/lastgood.xml" HS="$scratch/real/lastgood_hs.xml"
export ODI_CONF="$scratch/real/odi.conf" TMPDIR_="$scratch/real-tmp"
export ODI_CONFIG_DIR="$scratch/real"
export ODI_PROFILE_FLASH="$PWD/rootfs/skeleton/etc/scripts/flash"
cat > "$CS" <<'XML'
<Config Name="ROOT">
 <Dir Name="MIB_TABLE">
  <Value Name="VLAN_CFG_TYPE" Value="1"/>
  <Value Name="PRESERVED_VALUE" Value="unchanged"/>
 </Dir>
</Config>
XML
cat > "$HS" <<'XML'
<Config Name="ROOT">
 <Dir Name="MIB_TABLE">
  <Value Name="GPON_PLOAM_PASSWD" Value="preserved-test-value"/>
 </Dir>
</Config>
XML
cp "$HS" "$scratch/hs-before"
printf 'OMCI_UNI_LOCK=0\n' > "$scratch/profile/odi.conf"
printf 'GPON_SN=ODIT00000001\nOMCC_VER=150\nVLAN_CFG_TYPE=0\n' > "$scratch/profile/identity.env"
sh rootfs/skeleton/etc/scripts/profile-seed.sh
grep -q 'Name="GPON_SN" Value="ODIT00000001"' "$CS"
grep -q 'Name="OMCC_VER" Value="150"' "$CS"
grep -q 'Name="VLAN_CFG_TYPE" Value="0"' "$CS"
grep -q 'Name="PRESERVED_VALUE" Value="unchanged"' "$CS"
cmp "$HS" "$scratch/hs-before"
test "$(grep -c 'Name="GPON_SN"' "$CS")" -eq 1
echo 'ok absent report keys are added once; existing config and authentication are preserved'

printf '%064d\n' 3 > "$scratch/profile/id"
awk '{ print } /<Dir Name="MIB_TABLE">/ { print "  <Value Name=\"GPON_SN\" Value=\"ODITFFFFFFFF\"/>" }' "$HS" > "$HS.new"
mv "$HS.new" "$HS"
sh rootfs/skeleton/etc/scripts/profile-seed.sh
grep -q 'Name="GPON_SN" Value="ODIT00000001"' "$CS"
grep -q 'Name="GPON_SN" Value="ODIT00000001"' "$HS"
grep -v 'Name="GPON_SN"' "$HS" > "$scratch/hs-without-sn"
cmp "$scratch/hs-before" "$scratch/hs-without-sn"
echo 'ok duplicate serial copies agree for ranging and OMCI; other HS fields stay intact'
