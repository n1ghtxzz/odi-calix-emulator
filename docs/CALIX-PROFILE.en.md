# Calix/E7 profile setup

[Русский](CALIX-PROFILE.ru.md)

For ODI DFP-34X-2C2 running ODI Calix Emulator v1.0.0. Based on
[AndreZiviani/odi-oss](https://github.com/AndreZiviani/odi-oss), GPL-2.0.
The example and generator contain no subscriber identity or credentials.
The generator runs on a computer with Python 3. It never contacts an ONU,
applies settings, reboots a device or flashes firmware.

## What the example enables

`calix-e7.example.json` describes four logical Ethernet UNIs, two POTS
ports and VEIP in slot 3. The E7 model also adds service UNI 0107 and
second VEIP 0302 when VEIP is enabled. These are software representations:
the stick has one physical Ethernet interface, no telephone sockets and
no Wi-Fi radio. Match your original ONU and OLT service plan before applying
the example. Changing the advertised topology can change OLT provisioning.

The generator creates per-instance `OMCI_FIXED_ME` entries for 65311 and
65319. This pair selects the native E7 models for 241, 244, 251, 407,
65280–65283 and 65311. POTS and VEIP settings control their respective
instances. Physical UNI counters use the available hardware readings;
logical-only ports have zero counters. Stick voice telemetry does not
observe calls on an external PBX.

This is not a complete MIB clone for every Calix model. Arbitrary vendor
entities and hardware functions are not implemented automatically. Do not
copy stale bridges, GEM ports, T-CONTs, queues, Alloc-IDs or sessions into
the profile: the OLT creates the active service plan. Hardware DSCP remap
command 52 is still unsupported.

## 1. Collect your own settings

Back up the complete flash and configuration. Obtain your original ONU
identity, authentication method, reported versions, topology and service
VLAN/priority requirements from your equipment or provider.

| JSON field | Meaning |
|---|---|
| `identity.GPON_SN` | Your GPON SN: four vendor characters plus eight hex digits, 12 characters total. A billing inventory number may be different. `null` preserves the existing value. |
| `identity.GPON_ONU_MODEL` | Equipment ID, up to 20 printable ASCII characters; set only if required. |
| `identity.ONU_HW_VERSION` | Hardware version, up to 14 ASCII characters. |
| `identity.OMCI_SW_VER1/2` | The two reported image versions, up to 14 ASCII characters each. |
| `identity.OMCC_VER` | Decimal 0–255. |
| `identity.OMCI_VENDOR_PRODUCT_CODE` | Decimal 0–65535. |
| `ethernet_ports` | 1–4, including physical UNI 0101. |
| `compatibility.OMCI_POTS_PORTS` | 0, 1 or 2; use 0 when no voice ports are required. |
| `compatibility.OMCI_POTS_SLOT_ID` | POTS slot, normally 2; excludes 1, 6, 128 and an enabled VEIP slot. |
| `compatibility.OMCI_VEIP` | 0 or 1; zero suppresses the VEIP additions. |
| `compatibility.OMCI_VEIP_SLOT_ID` | VEIP slot; 3 produces 0301 and 0302. |
| `compatibility.OMCI_CUSTOM_ME` | Bitmask. A custom VEIP slot requires bit 0x100. The example value 256 contains only that bit. Preserve any other required bits: `existing_mask | 256`, entered as a decimal integer. |
| `management_ip` | Your management IPv4 address without a prefix, or `null` to preserve it. |

`OMCI_PRIVATE_ME=0` suppresses the ordinary 350/370/373 models, not the
added Calix models. `OMCI_UNKNOWN_ME_OK=1` retains compatibility responses
to unsupported requests; success does not mean that the requested function
exists. Both choices are explicit in this example and may need adjustment
for another OLT.

All `identity` values default to `null` and are omitted from the generated
seed. An empty string is rejected. With no supplied identity fields, no
`identity.env` file or identity-enable marker is created.
For `GPON_ONU_MODEL` and `OMCI_SW_VER1/2`, seed tokens allow letters, digits,
underscore, dot and hyphen without spaces, matching the fallback that adds
an absent configuration key. Do not copy trailing padding from binary MIB data.

PLOAM, LOID, LOID password and SIP password are deliberately absent. The
existing first-boot seed does not accept them. Configure the required PON
authentication through Config → ONU identity; existing credentials are not
cleared by this template. PLOAM accepts 1–10 text characters, exactly 20
hex digits, or `0x` followed by an even number of 2–20 hex digits. Keep
filled profiles private.

## 2. Prepare a private profile

Unpack `calix-e7-template-v1.0.0.zip`, which contains the JSON, generator,
both guides and license. On Linux/macOS:

```sh
umask 077
PROFILE_WORKDIR=$(mktemp -d)
cp calix-e7.example.json "$PROFILE_WORKDIR/line.json"
# Edit line.json with your text editor before continuing.
python3 prepare-calix-profile.py "$PROFILE_WORKDIR/line.json" \
  --output "$PROFILE_WORKDIR/generated"
```

In the source repository the generator is `tools/prepare-calix-profile.py`
and the JSON is under `examples/calix-e7/`. On Windows use `py -3` and
a separate private directory outside Git. Existing output is never
overwritten; output inside a Git working tree is refused.

Output contains `generated/seed/id`, `odi.conf` and, when requested,
`identity.env` and `lan-ip`. The ID is a content SHA-256, not a serial
number. It makes the existing seed apply once; the same profile does not
overwrite later owner edits. Unix directories use 0700 and files 0600.
Identity values are not printed to the terminal.

## 3. Choose an installation method

**Existing public image, without an additional OME1 overlay.** Add an SSH
key through the web UI first. Check that `generated/emulation.bin` does
not exist. Set `ONT_IP` to your actual management address, then copy the seed:

`/tmp/calix-seed` must not exist. If a previous attempt left it behind, use
a new directory name in both commands so a stale `identity.env` cannot be
mixed into the new profile.

```sh
scp -O -r "$PROFILE_WORKDIR/generated/seed" "root@$ONT_IP:/tmp/calix-seed"
ssh "root@$ONT_IP" 'ODI_PROFILE_DIR=/tmp/calix-seed /etc/scripts/profile-seed.sh'
```

This writes configuration; it does not Apply, reboot or Commit. Review
the values in the web UI, then apply OMCI changes in a maintenance window:
re-registration interrupts connectivity. The resulting settings persist
in the shared configuration partition; `/tmp` files are temporary. This
method does not install a binary overlay into the root filesystem.

**Your own image with a seed.** Build the v1.0.0 source on Linux with
Docker, using the absolute path to your private directory:

```sh
PROFILE_DIR="$PROFILE_WORKDIR/generated/seed" \
  ROOT_PW=locked VERSION=odi-calix-myline make image-all
```

If the generator produced `emulation.bin`, include it separately:

```sh
PROFILE_DIR="$PROFILE_WORKDIR/generated/seed" \
  EMULATION_PROFILE="$PROFILE_WORKDIR/generated/emulation.bin" \
  ROOT_PW=locked VERSION=odi-calix-myline make image-all
```

The resulting image contains private data. Keep it private. Write only the
inactive slot, Try it, and commit manually after checking service. The
generator does not set an SSH password; `ROOT_PW=locked` retains keys-only
SSH. Initial web login without existing settings is admin/admin; set your
own web password.

## Optional reported identity fields

`reported_mfg_serial` supplies your own manufacturing identifier to ME 241,
exactly 12 ASCII bytes. This is the current compatibility-model width, not
a universal Calix wire contract. `reported_ip_host_macs` maps decimal-string
ME 134 instance IDs to your own `xx:xx:xx:xx:xx:xx` MAC values. Read the
instance IDs from your line MIB. Defaults are `null` and an empty map;
no made-up identifier is substituted.

When these fields are present, the generator creates checksummed OME1 data
for only ME 241/0 attribute 1 and ME 134/matching-instance attribute 2.
These affect OMCI replies, not interface MACs, DHCP, IP addresses or VLANs.
Include `emulation.bin` in your own build as above. In v1.0.0 the fixed
`/etc/omci-emulation.bin` path is in the read-only root filesystem; copying
it to `/etc/config` does not install an overlay. Do not enable
`OMCI_EMULATION=2`: these native seeds work in the ordinary strict mode.
If the overlay was previously disabled, set `OMCI_EMULATION=1` through
settings or `/etc/scripts/flash set OMCI_EMULATION 1` before the next
registration.

## Verify your line

After a trial, check management, O5, OLT-assigned VLAN/T-CONT/GEM state,
Internet DHCP, traffic in both directions and voice. O5 alone confirms PON
registration, not service delivery. Use your own VLAN IDs and priorities;
the template hardcodes none. The stick does not register SIP: calls need
an external PBX/client and the credentials for your own voice service.

Inspect `/var/log/omcid.log`, MIB Browser and OMCI → Services/Phone.
Logs, dumps and filled JSON may expose identification and SIP details;
redact them before posting a public issue. If a trial fails, return to the
committed slot and restore the saved configuration: both slots share the
configuration partition, which a slot change does not roll back. Neither
the generator nor this package commits a trial automatically.
