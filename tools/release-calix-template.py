#!/usr/bin/env python3
"""Package the public Calix template; optionally append assets to v1.0.0."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
IMAGE_DIGEST = 'sha256:485169aafa8c2830faf1892e5c060a98c671706c125f6aa30e6cf1270928eebf'
MARKER = '<!-- calix-profile-template-v1.0.0 -->'
ASSETS = ['calix-e7-template-v1.0.0.zip', 'CALIX-PROFILE.ru.md',
          'CALIX-PROFILE.en.md', 'calix-e7.example.json', 'CALIX-PROFILE-SHA256SUMS']


def command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True,
                          timeout=90).stdout


def metadata(repo):
    return json.loads(command(['gh', 'api', f'repos/{repo}/releases/tags/v1.0.0']))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def package(target):
    example = json.loads((ROOT / 'examples/calix-e7/calix-e7.example.json').read_text())
    assert all(value is None for value in example['identity'].values())
    assert example['reported_mfg_serial'] is None
    assert not example['reported_ip_host_macs'] and example['management_ip'] is None
    target.mkdir(parents=True, exist_ok=True)
    sources = {
        'calix-e7.example.json': ROOT / 'examples/calix-e7/calix-e7.example.json',
        'prepare-calix-profile.py': ROOT / 'tools/prepare-calix-profile.py',
        'CALIX-PROFILE.ru.md': ROOT / 'docs/CALIX-PROFILE.ru.md',
        'CALIX-PROFILE.en.md': ROOT / 'docs/CALIX-PROFILE.en.md',
        'LICENSE': ROOT / 'LICENSE',
    }
    with zipfile.ZipFile(target / ASSETS[0], 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, source in sorted(sources.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = (0o100755 if name.endswith('.py') else 0o100644) << 16
            archive.writestr(entry, source.read_bytes())
    for name in ASSETS[1:4]:
        shutil.copyfile(sources[name], target / name)
    (target / ASSETS[4]).write_bytes(''.join(sha(target / name) + '  ' + name + '\n'
                                           for name in ASSETS[:4]).encode())
    return {name: 'sha256:' + sha(target / name) for name in ASSETS}


def publish(target, digests):
    repo = os.environ['GITHUB_REPOSITORY']
    release = metadata(repo)
    assert release['tag_name'] == 'v1.0.0' and not release['draft']
    assets = {item['name']: item for item in release['assets']}
    assert assets['odi-calix-v1.0.0.tar']['digest'] == IMAGE_DIGEST
    for name, digest in digests.items():
        if name in assets:
            assert assets[name]['digest'] == digest, 'refuse to replace existing asset: ' + name
    missing = [str(target / name) for name in ASSETS if name not in assets]
    if missing:
        command(['gh', 'release', 'upload', 'v1.0.0', '--repo', repo, *missing])
    # Read notes again so unrelated edits made during upload are preserved.
    current = metadata(repo)
    if MARKER not in (current['body'] or ''):
        link = f'https://github.com/{repo}/releases/download/v1.0.0/'
        addition = ('\n\n' + MARKER + '\n## Профиль Calix / Calix profile\n\n'
                    '[Шаблон и генератор / Template and generator](' + link + ASSETS[0] + ') · '
                    '[Инструкция на русском](' + link + ASSETS[1] + ') · '
                    '[English guide](' + link + ASSETS[2] + ')\n\n'
                    'Шаблон не содержит серийников и паролей. Пустые поля сохраняют '
                    'идентификацию устройства; генератор не применяет настройки и не прошивает SFP. '
                    'Хеш и образ прошивки не изменены.\n\n'
                    'The template contains no subscriber identity or passwords. Null fields preserve '
                    'existing identity; the generator never applies settings or flashes a device. '
                    'The firmware image and its checksum are unchanged.\n')
        with tempfile.TemporaryDirectory() as temporary:
            notes = Path(temporary) / 'release-notes.md'
            notes.write_bytes(((current['body'] or '') + addition).encode())
            command(['gh', 'release', 'edit', 'v1.0.0', '--repo', repo, '--notes-file', str(notes)])
    final = metadata(repo)
    assets = {item['name']: item for item in final['assets']}
    assert assets['odi-calix-v1.0.0.tar']['digest'] == IMAGE_DIGEST
    assert all(assets[name]['digest'] == digest for name, digest in digests.items())
    assert MARKER in final['body']
    print(final['html_url'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    digests = package(args.output)
    if args.publish:
        publish(args.output, digests)
    print(json.dumps(digests, indent=2))


if __name__ == '__main__':
    main()
