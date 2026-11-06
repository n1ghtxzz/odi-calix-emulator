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
| MIB browser | firmware-specific views | 106 classes, including ten Calix/E7 models; numeric reads and hex entity IDs |
| Web language | firmware-specific | RU/EN selector, 1762 reviewed dictionary entries; all ten confirmation sites exercised in 30 cases and all five HTML dialogs checked |
| Diagnostic data | firmware-specific formatting | logs, severity levels, raw dumps, MIB attribute identifiers and provider SIP values remain untranslated |
| Hardware DSCP | model-specific | hardware command 52 remains unsupported; wire-level DSCP priority support is not claimed |

The SFP has one physical Ethernet interface. Emulated LAN/POTS/VEIP instances
do not create physical ports. SIP registration and calls are handled by an
external PBX or SIP client.

## Build

Use Linux, Docker and the dependencies in [docs/BUILDING.md](docs/BUILDING.md):

```sh
make test
npm ci
npx playwright install chromium
make test-web
ROOT_PW=locked VERSION=odi-calix-v1.0.0 make image-all
```

The image uses the bundled `web/` assets. The unchanged confd and metricsd
binaries remain pinned to v1.12.0 and v1.8.0. Supply `EMULATION_PROFILE` and
`PROFILE_DIR` from outside the repository when needed for your own line.
No owner capture, real device identity, SIP password or private line profile
is included here. The firmware does not invent another subscriber identity.

## Validation and images

Tests run locally or in containers, without writing to a live ONU: host-side
boot/update checks, OMCI protocol regressions and browser tests with synthetic
MIB fixtures. They verify implementation behavior and do not replace testing
on a particular optical line. Hardware DSCP support remains incomplete.

The owner-specific image, containing the owner profile, is delivered separately
and is not uploaded to this public repository. Its verified service binaries
and kernel are preserved; release assembly changes version/provenance metadata
only. Checksums and verification manifests accompany the image.

Nothing flashes or commits a device automatically. Follow
[docs/FLASHING.md](docs/FLASHING.md) for an inactive-slot trial and manual
commit. See [localization/README.md](localization/README.md) to edit translations.
