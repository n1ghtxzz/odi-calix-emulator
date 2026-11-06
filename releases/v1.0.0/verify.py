"""Check the prepared public tar without accessing an ONU."""
import hashlib
import json
from pathlib import Path
import struct
import tarfile
import zlib

root = Path(__file__).resolve().parent
image = root / 'odi-calix-v1.0.0.tar'
report = json.loads((root / 'image-verification.json').read_text())
assert hashlib.sha256(image.read_bytes()).hexdigest() == report['image_sha256']
assert report['source_commit'] == '26dcea2907052b756b554a1d9c0062bd6869fd08'
assert report['root_password_locked']
assert not report['owner_profile_included']
assert not report['owner_credentials_included']
with tarfile.open(image) as archive:
    assert set(archive.getnames()) == {'fwu.sh', 'fwu_ver', 'md5.txt', 'rootfs', 'uImage'}
    parts = {n: archive.extractfile(n).read() for n in archive.getnames()}
for line in parts['md5.txt'].decode().splitlines():
    digest, name = line.split()
    assert hashlib.md5(parts[name]).hexdigest() == digest
kernel = parts['uImage']
header = struct.unpack('>7I4B32s', kernel[:64])
assert header[0] == 0x27051956
assert zlib.crc32(kernel[:4] + bytes(4) + kernel[8:64]) & 0xffffffff == header[1]
assert zlib.crc32(kernel[64:]) & 0xffffffff == header[6]
assert len(kernel) == 64 + header[3]
assert len(kernel) <= 1359872 and len(parts['rootfs']) <= 2572288
print('Prepared public image: checksums, header and partition limits verified')
