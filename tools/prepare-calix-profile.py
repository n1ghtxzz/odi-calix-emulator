#!/usr/bin/env python3
"""Prepare private data for the existing profile seed; never access a device."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import struct
import sys

IDENTITY = {
    'GPON_SN': 12, 'GPON_ONU_MODEL': 20, 'ONU_HW_VERSION': 14,
    'OMCI_SW_VER1': 14, 'OMCI_SW_VER2': 14,
    'OMCC_VER': 255, 'OMCI_VENDOR_PRODUCT_CODE': 65535,
}
COMPAT = {
    'OMCI_PRIVATE_ME', 'OMCI_UNKNOWN_ME_OK', 'OMCI_POTS_PORTS',
    'OMCI_POTS_SLOT_ID', 'OMCI_VEIP', 'OMCI_VEIP_SLOT_ID', 'OMCI_CUSTOM_ME',
}
TOP = {'schema', 'ethernet_ports', 'management_ip', 'identity',
       'compatibility', 'reported_mfg_serial', 'reported_ip_host_macs'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value, key, low, high):
    require(isinstance(value, (str, int)) and not isinstance(value, bool),
            key + ': expected decimal integer')
    text = str(value)
    require(re.fullmatch(r'[0-9]+', text) is not None,
            key + ': expected decimal integer')
    result = int(text)
    require(low <= result <= high, key + ': integer out of range')
    return result


def plain(value, key, limit):
    require(isinstance(value, str), key + ': expected string or null')
    require(0 < len(value) <= limit and all(32 <= ord(c) <= 126 for c in value),
            key + ': expected nonempty printable ASCII within field width')
    require(not any(c in value for c in '<>"&'),
            key + ': XML metacharacters are not supported by the seed writer')
    require(not any(t in value.upper() for t in ['REPLACE', 'YOUR_', 'CHANGE_ME']),
            key + ': replace the placeholder or use null')
    return value


def encode_overlay(rows):
    payload = bytearray()
    count = 0
    for cls, inst, attrs in sorted(rows):
        payload.extend(struct.pack('>HHHH', cls, inst, 0, len(attrs)))
        for index, flags, data in attrs:
            payload.extend(struct.pack('>BBHH', index, flags, len(data), len(data)))
            payload.extend(data)
            count += 1
    digest = 2166136261
    for byte in payload:
        digest = ((digest ^ byte) * 16777619) & 0xffffffff
    return b'OME1' + struct.pack('>HHII', len(rows), count, len(payload), digest) + payload


def prepare(document):
    require(isinstance(document, dict) and set(document) == TOP,
            'unexpected or missing top-level fields')
    require(type(document['schema']) is int and document['schema'] == 1,
            'unsupported schema')
    ports = number(document['ethernet_ports'], 'ethernet_ports', 1, 4)
    identity = document['identity']
    require(isinstance(identity, dict) and set(identity) <= set(IDENTITY),
            'unknown identity key; passwords are configured separately')
    saved_identity = {}
    for key, value in identity.items():
        if value is None:
            continue
        if key in ('OMCC_VER', 'OMCI_VENDOR_PRODUCT_CODE'):
            saved_identity[key] = str(number(value, key, 0, IDENTITY[key]))
        else:
            value = plain(value, key, IDENTITY[key])
            if key == 'GPON_SN':
                require(re.fullmatch(r'[A-Za-z0-9]{4}[0-9a-fA-F]{8}', value) is not None,
                        'GPON_SN: expected four vendor characters and eight hex digits')
            if key in ('GPON_ONU_MODEL', 'OMCI_SW_VER1', 'OMCI_SW_VER2'):
                require(re.fullmatch(r'[A-Za-z0-9_.-]+', value) is not None,
                        key + ': seed tokens allow letters, digits, underscore, dot and hyphen')
            saved_identity[key] = value
    values = document['compatibility']
    require(isinstance(values, dict) and set(values) == COMPAT,
            'unexpected or missing compatibility keys')
    limits = {
        'OMCI_PRIVATE_ME': (0, 1), 'OMCI_UNKNOWN_ME_OK': (0, 1),
        'OMCI_POTS_PORTS': (0, 2), 'OMCI_POTS_SLOT_ID': (2, 254),
        'OMCI_VEIP': (0, 1), 'OMCI_VEIP_SLOT_ID': (2, 254),
        'OMCI_CUSTOM_ME': (0, 99999999),
    }
    settings = {key: number(values[key], key, *limits[key]) for key in sorted(COMPAT)}
    pots, veip = settings['OMCI_POTS_SLOT_ID'], settings['OMCI_VEIP_SLOT_ID']
    require(pots not in (6, 128) and veip != 128, 'reserved POTS or VEIP slot')
    require(not settings['OMCI_POTS_PORTS'] or not settings['OMCI_VEIP'] or pots != veip,
            'POTS and VEIP slots collide')
    require(not settings['OMCI_VEIP'] or settings['OMCI_CUSTOM_ME'] & 256,
            'custom VEIP slot requires bit 0x100 in OMCI_CUSTOM_ME')
    entries = []
    for port in range(1, ports + 1):
        entries += [f'65311:0x{0x100+port:04x}:2:00000000',
                    f'65319:0x{0x100+port:04x}:1:00']
    serialized = {key: str(value) for key, value in settings.items()}
    serialized['OMCI_FIXED_ME'] = ' '.join(entries)
    files = {'seed/odi.conf': ''.join(k + '=' + serialized[k] + '\n'
                                    for k in sorted(serialized)).encode()}
    if saved_identity:
        files['seed/identity.env'] = ''.join(k + '=' + saved_identity[k] + '\n'
                                           for k in sorted(saved_identity)).encode()
    address = document['management_ip']
    if address is not None:
        require(isinstance(address, str), 'management_ip: expected IPv4 string or null')
        address = ipaddress.IPv4Address(address)
        require(not (address.is_multicast or address.is_loopback or address.is_unspecified
                     or int(address) == 0xffffffff), 'management_ip: unusable address')
        files['seed/lan-ip'] = (str(address) + '\n').encode()
    rows = []
    serial = document['reported_mfg_serial']
    if serial is not None:
        serial = plain(serial, 'reported_mfg_serial', 12)
        require(len(serial) == 12, 'reported_mfg_serial: model requires exactly 12 ASCII bytes')
        # Read-only, secret, assumed model width; native seed uses the exact width.
        rows.append((241, 0, [(1, 14, serial.encode('ascii'))]))
    macs = document['reported_ip_host_macs']
    require(isinstance(macs, dict) and len(macs) <= 16,
            'reported_ip_host_macs: expected at most 16 instance/MAC pairs')
    instances = set()
    for instance, mac in macs.items():
        require(isinstance(instance, str) and re.fullmatch(r'0|[1-9][0-9]*', instance) is not None,
                'IP host instances use canonical decimal strings')
        inst = number(instance, 'IP host instance', 0, 65535)
        require(inst not in instances, 'duplicate IP host instance')
        instances.add(inst)
        require(isinstance(mac, str) and re.fullmatch(r'(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}', mac) is not None,
                'reported MAC: expected six colon-separated hex bytes')
        data = bytes.fromhex(mac.replace(':', ''))
        require(data != bytes(6) and not data[0] & 1, 'reported MAC must be nonzero unicast')
        rows.append((134, inst, [(2, 2, data)]))
    if rows:
        files['emulation.bin'] = encode_overlay(rows)
    digest = hashlib.sha256()
    for name, data in sorted(files.items()):
        digest.update(name.encode() + b'\0' + data + b'\0')
    files['seed/id'] = (digest.hexdigest() + '\n').encode()
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('settings', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    try:
        files = prepare(json.loads(args.settings.read_text(encoding='utf-8-sig')))
        target = args.output.resolve()
        require(not target.exists(), 'output exists; choose a new private directory')
        require(not any((p / '.git').exists() for p in [target, *target.parents]),
                'output must be outside a Git working tree')
        os.umask(0o077)
        target.mkdir(mode=0o700, parents=True)
        (target / 'seed').mkdir(mode=0o700)
        for name, data in files.items():
            path = target / name
            with path.open('xb') as stream:
                stream.write(data)
            path.chmod(0o600)
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print('Profile not prepared: ' + str(error), file=sys.stderr)
        return 1
    print('Private profile prepared. No device contacted; no settings applied.')
    print('Optional OME1 overlay: ' + ('present' if 'emulation.bin' in files else 'not requested'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
