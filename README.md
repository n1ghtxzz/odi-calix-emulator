# ODI Calix Emulator

[English](README.md) · [Русский](README.ru.md)

Firmware for the **ODI DFP-34X-2C2** GPON SFP ONU, with Calix/E7 OMCI
compatibility and a Russian/English web interface.

This is a fork of **[odi-oss by AndreZiviani](https://github.com/AndreZiviani/odi-oss)**,
based on commit `6d933bafa45976b982b56fb6979cf856c49006fc`. Upstream copyright,
attribution and GPL-2.0 licensing are retained. The upstream technical README
is preserved in [README.upstream.md](README.upstream.md); the web UI derives
from [odi-ui v1.12.0](https://github.com/AndreZiviani/odi-ui/tree/v1.12.0).

## Release 1.0.0

The release combines the preserved R6 OMCI implementation with the R8.1 web
interface. Unfinished hardware DSCP changes are excluded.

| Area | Stock (OEM) firmware | This firmware |
|---|---|---|
| OMCI interoperability | model-specific behavior | Calix/E7 profile support, including 241, 244, 251, 407, 65280–65283, 65311 and 65319 |
| MIB browser | firmware-specific views | 106 classes, including 10 Calix/E7 models; numeric reads and hex entity IDs |
| Web language | firmware-specific | RU/EN selector, 1762 reviewed dictionary entries; 10 confirmation sites exercised in 30 cases, 5 HTML dialogs and 4 setup steps checked |
| Diagnostic data | firmware-specific formatting | logs, severity levels, raw dumps, MIB attribute identifiers and provider SIP values remain untranslated |
| Profile setup | model-specific | Public Calix/E7 example, offline private-profile generator and Russian/English guides; no subscriber identity or passwords |
| Hardware DSCP | model-specific | hardware command 52 remains unsupported; wire-level DSCP priority support is not claimed |

The SFP has 1 physical Ethernet interface. Emulated LAN/POTS/VEIP instances
do not create physical ports. SIP registration and calls are handled by an
external PBX or SIP client.

## Ready-to-flash image

Download the [v1.0.0 release](https://github.com/n1ghtxzz/odi-calix-emulator/releases/tag/v1.0.0):

- [Firmware image](https://github.com/n1ghtxzz/odi-calix-emulator/releases/download/v1.0.0/odi-calix-v1.0.0.tar)
- [SHA256SUMS](https://github.com/n1ghtxzz/odi-calix-emulator/releases/download/v1.0.0/SHA256SUMS)
- [Installation guide, RU/EN](https://github.com/n1ghtxzz/odi-calix-emulator/releases/download/v1.0.0/INSTALL.md)

The public image uses a clean public skeleton and UI, reusing the verified
R8.1 kernel and executable binaries. It contains no owner line profile,
real device identity, PLOAM/LOID credentials or SIP password. Configure
your own line separately; this is a generic image.

SSH is keys-only. Initial web login without existing settings is
`admin/admin`; set your own web password and add an SSH key. Back up the
device and configuration, trial only the inactive slot, then commit
manually after checking Internet and voice. See
[docs/FLASHING.md](docs/FLASHING.md). The configuration partition is shared
between slots; changing slots does not restore previous settings.

## Build

Use Linux, Docker and the dependencies in [docs/BUILDING.md](docs/BUILDING.md):

```sh
make test
npm ci
npx playwright install chromium
make test-web
ROOT_PW=locked VERSION=odi-calix-v1.0.0 make image-all
```

The image uses the bundled `web/` assets. The unchanged `confd` and `metricsd`
binaries remain pinned to `v1.12.0` and `v1.8.0`. Supply `EMULATION_PROFILE`
and `PROFILE_DIR` from outside the repository when needed for your own line.
No owner capture or private line profile is included here. The firmware
does not invent another subscriber identity. See
[localization/README.md](localization/README.md) to edit translations.

## Validation and limits

For this release, 28 service test groups and 36 browser checks passed,
including the confirmation/dialog/setup checks listed above. The profile
generator passed 10 additional checks, including the actual seed writer
against isolated configuration files. These run locally, in containers or
in GitHub Actions, without writing to a live ONU.

The checks cover boot/update behavior, OMCI protocol regressions, Calix/E7
models, VoIP and the web UI with synthetic MIB fixtures. They verify
implementation behavior and do not replace testing a particular optical
line. Hardware DSCP remains incomplete. Checksums, an image verification
manifest and SBOM accompany the public release. Nothing flashes or commits
a device automatically.

An owner-specific image containing a private line profile is distributed
separately and is not uploaded to the public repository or release.

## Calix profile template

The release includes a [blank template and offline generator](https://github.com/n1ghtxzz/odi-calix-emulator/releases/download/v1.0.0/calix-e7-template-v1.0.0.zip).
Read the [English guide](docs/CALIX-PROFILE.en.md) or
[Russian guide](docs/CALIX-PROFILE.ru.md).

Null identity fields preserve existing values; no subscriber serials or
passwords are shipped. Match the example topology to your original ONU and
OLT plan. Prepare profiles outside Git and keep filled profiles and images
private. The generator never contacts a device or applies settings. The
guides cover authentication, the existing-image seed method, a custom build,
optional OME1 fields, service verification and configuration recovery.
