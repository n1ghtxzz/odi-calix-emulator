#!/bin/sh
# Apply an optional, owner-supplied image profile once. Never source data.
# No boot-slot or commit state is touched. A stock fallback ignores the
# sidecar management and compatibility keys this profile adds.
set -eu
P=${ODI_PROFILE_DIR:-/etc/odi-profile}
C=${ODI_CONFIG_DIR:-/etc/config}
FLASH=${ODI_PROFILE_FLASH:-/etc/scripts/flash}
[ -r "$P/id" ] || exit 0
[ -d "$C" ] || exit 1
id=$(head -n 1 "$P/id")
[ "${#id}" -eq 64 ] || exit 1
case "$id" in *[!0-9a-f]*) exit 1;; esac
[ "$(cat "$C/image-profile.id" 2>/dev/null || true)" != "$id" ] || exit 0
umask 077

# A stock release may omit a report key entirely. Add only an allowlisted,
# absent stock key to a valid CS table; never replace a failed existing
# write or reset the store. Values here are identity tokens and integers.
add_missing_stock_key() {
    case "$1" in
    GPON_SN|OMCI_SW_VER1|OMCI_SW_VER2|OMCC_VER|OMCI_VENDOR_PRODUCT_CODE|GPON_ONU_MODEL|\
    OMCI_VEIP_SLOT_ID|OMCI_CUSTOM_ME|VLAN_CFG_TYPE|VLAN_MANU_MODE) ;;
    *) return 1;;
    esac
    [ "${#2}" -le 64 ] || return 1
    case "$2" in *[!A-Za-z0-9_.-]*) return 1;; esac
    cs=${CS:-$C/lastgood.xml}
    hs=${HS:-$C/lastgood_hs.xml}
    [ -s "$cs" ] || return 1
    if grep -Fq "Name=\"$1\"" "$cs" "$hs" 2>/dev/null; then return 1; fi
    tmp="$cs.profile-new.$$"
    if ! awk -v k="$1" -v v="$2" '
        { print }
        !done && /<Dir Name="MIB_TABLE">/ {
            printf "\t\t<Value Name=\"%s\" Value=\"%s\"/>\n", k, v
            done = 1
        }
        END { exit !done }
    ' "$cs" > "$tmp"; then rm -f "$tmp"; return 1; fi
    [ -s "$tmp" ] || { rm -f "$tmp"; return 1; }
    mv -f "$tmp" "$cs"
}

# Set the management override first, so a refused identity key still leaves
# the owner an address. network.sh validates this address before use.
if [ -r "$P/lan-ip" ]; then
    head -n 1 "$P/lan-ip" > "$C/lan-ip.profile-new"
    mv -f "$C/lan-ip.profile-new" "$C/lan-ip"
fi
for file in odi.conf identity.env; do
    [ -r "$P/$file" ] || continue
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in ''|'#'*) continue;; *=*) ;; *) exit 1;; esac
        key=${line%%=*}
        value=${line#*=}
        case "$key" in
        GPON_SN|OMCI_SW_VER1|OMCI_SW_VER2|OMCC_VER|OMCI_VENDOR_PRODUCT_CODE|GPON_ONU_MODEL|\
        ONU_HW_VERSION|OMCI_UNI_LOCK|OMCI_PRIVATE_ME|OMCI_UNKNOWN_ME_OK|OMCI_FIXED_ME|\
        OLT_SW_DOWNLOAD|OMCI_ACCEPT_REBOOT|HOST_SERDES|OMCI_VEIP|OMCI_VEIP_SLOT_ID|\
        OMCI_CUSTOM_ME|OMCI_POTS_PORTS|OMCI_POTS_SLOT_ID|OMCI_TCONT_ALLOC_UNSET|\
        VLAN_CFG_TYPE|VLAN_MANU_MODE) ;;
        *) echo "image profile: refused key $key" >&2; exit 1;;
        esac
        # Five seconds bounds a slow config writer, without another daemon.
        if ! timeout 5 "$FLASH" set "$key" "$value"; then
            add_missing_stock_key "$key" "$value" || exit 1
        fi
        # Both readers must use the same serial if an old store carries
        # a duplicate: ranging reads CS first, OMCI identity reads HS first.
        if [ "$key" = GPON_SN ]; then
            cs=${CS:-$C/lastgood.xml}
            hs=${HS:-$C/lastgood_hs.xml}
            if grep -Fq 'Name="GPON_SN"' "$cs" 2>/dev/null &&
               grep -Fq 'Name="GPON_SN"' "$hs" 2>/dev/null; then
                CS="$hs" HS="$hs" timeout 5 "$FLASH" set "$key" "$value" || exit 1
            fi
        fi
    done < "$P/$file"
done
if [ -r "$P/identity.env" ]; then
    : > "$C/omci-identity.on"
fi
printf '%s\n' "$id" > "$C/image-profile.id.new"
mv -f "$C/image-profile.id.new" "$C/image-profile.id"
echo "image profile applied"
