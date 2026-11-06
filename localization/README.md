# Web UI sources

`web/` contains the editable English UI and the generated Russian dictionary
exports. It derives from [odi-ui v1.12.0](https://github.com/AndreZiviani/odi-ui/tree/v1.12.0),
under GPL-2.0; the license is in `LICENSE.odi-ui`.

Edit Russian copy in `localization/ru.json`, localization behavior in
`localization/runtime.js`, and ordinary UI markup/renderers in `web/`.
Run `python3 tools/build-ui-language.py` before committing. Compiling the
unchanged dictionary is idempotent. Dictionary exports share existing modules
because confd has a fixed file allowlist and a 65536-byte static file buffer.
Each generated module stays below 60000 bytes.

Raw logs, log levels, command output, MIB attribute identifiers and provider
SIP values are intentionally not translated. Native confirmation bodies are
localized; browser-owned OK/Cancel controls follow the browser language.

Browser tests use synthetic MIB fixtures only:

```sh
npm ci
npx playwright install chromium
make test-web
```

`PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select an existing compatible Chromium.
The tests dismiss confirmations and never write to a device. The source
fixtures contain no owner capture, real serial, SIP password or line profile.
