"""Profile preparation and the real seed writer against isolated fixture files."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / 'tools/prepare-calix-profile.py'
spec = importlib.util.spec_from_file_location('calix_profile', TOOL)
profile = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profile)
EXAMPLE = json.loads((ROOT / 'examples/calix-e7/calix-e7.example.json').read_text())


class ProfileTests(unittest.TestCase):
    def test_public_example_has_no_owner_values(self):
        self.assertTrue(all(v is None for v in EXAMPLE['identity'].values()))
        self.assertIsNone(EXAMPLE['management_ip'])
        self.assertIsNone(EXAMPLE['reported_mfg_serial'])
        self.assertEqual(EXAMPLE['reported_ip_host_macs'], {})
        files = profile.prepare(EXAMPLE)
        self.assertEqual(set(files), {'seed/odi.conf', 'seed/id'})
        self.assertEqual(files, profile.prepare(copy.deepcopy(EXAMPLE)))
        fixed = next(x for x in files['seed/odi.conf'].decode().splitlines()
                     if x.startswith('OMCI_FIXED_ME='))
        self.assertEqual(len(fixed.split('=', 1)[1].split()), 8)
        self.assertIn('65311:0x0101:2:00000000', fixed)
        self.assertIn('65319:0x0104:1:00', fixed)

    def test_identity_is_omitted_until_explicitly_supplied(self):
        data = copy.deepcopy(EXAMPLE)
        data['identity']['GPON_SN'] = 'ODIT00000001'
        files = profile.prepare(data)
        self.assertEqual(files['seed/identity.env'], b'GPON_SN=ODIT00000001\n')
        self.assertNotEqual(files['seed/id'], profile.prepare(EXAMPLE)['seed/id'])
        self.assertNotIn('emulation.bin', files)

    def test_empty_and_unresolved_identity_are_refused(self):
        for value in ['', 'REPLACE_ME', 'A\nB', 'A"B', 'x' * 21]:
            data = copy.deepcopy(EXAMPLE)
            data['identity']['GPON_ONU_MODEL'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                profile.prepare(data)

    def test_password_and_boot_slot_keys_are_not_accepted(self):
        for key in ['GPON_PLOAM_PASSWD', 'LOID_PASSWD', 'SIP_PASSWORD', 'sw_commit']:
            data = copy.deepcopy(EXAMPLE)
            data['identity'][key] = 'fixture-only'
            with self.subTest(key=key), self.assertRaises(ValueError):
                profile.prepare(data)

    def test_topology_errors_are_rejected(self):
        mutations = [
            ('OMCI_POTS_SLOT_ID', '3'), ('OMCI_POTS_SLOT_ID', '6'),
            ('OMCI_VEIP_SLOT_ID', '128'), ('OMCI_CUSTOM_ME', '0'),
            ('OMCI_POTS_PORTS', '3'),
        ]
        for key, value in mutations:
            data = copy.deepcopy(EXAMPLE)
            data['compatibility'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                profile.prepare(data)

    def test_report_overlay_has_exact_binary_fields(self):
        data = copy.deepcopy(EXAMPLE)
        data['reported_mfg_serial'] = 'TEST00000001'
        data['reported_ip_host_macs'] = {'0': '02:00:00:00:0a:01',
                                        '1': '02:00:00:00:0a:02'}
        encoded = profile.prepare(data)['emulation.bin']
        self.assertEqual(encoded[:4], b'OME1')
        rows, attrs, size, checksum = struct.unpack('>HHII', encoded[4:16])
        self.assertEqual((rows, attrs, size), (3, 3, len(encoded) - 16))
        expected_payload = bytes.fromhex(
            '0086000000000001020200060006020000000a01'
            '0086000100000001020200060006020000000a02'
            '00f1000000000001010e000c000c') + b'TEST00000001'
        self.assertEqual(encoded[16:], expected_payload)
        reference = 2166136261
        for byte in expected_payload:
            reference = ((reference ^ byte) * 16777619) & 0xffffffff
        self.assertEqual(checksum, reference)

    def test_unusable_reported_macs_are_refused(self):
        for value in ['00:00:00:00:00:00', '01:00:00:00:00:01', 'aa:bb', None]:
            data = copy.deepcopy(EXAMPLE)
            data['reported_ip_host_macs'] = {'0': value}
            with self.subTest(value=value), self.assertRaises(ValueError):
                profile.prepare(data)

    def test_cli_does_not_overwrite_or_write_into_git(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            settings = root / 'line.json'
            settings.write_text(json.dumps(EXAMPLE))
            existing = root / 'existing'
            existing.mkdir()
            (existing / 'keep').write_bytes(b'unchanged')
            repository = root / 'repository'
            repository.mkdir()
            (repository / '.git').mkdir()
            for target in [existing, repository / 'private-output']:
                result = subprocess.run([sys.executable, str(TOOL), str(settings),
                                         '--output', str(target)], capture_output=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
            self.assertEqual((existing / 'keep').read_bytes(), b'unchanged')
            self.assertFalse((repository / 'private-output').exists())

    @unittest.skipIf(os.name == 'nt', 'requires the POSIX seed writer')
    def test_real_seed_preserves_auth_and_identity_and_applies_once(self):
        self.seed_roundtrip(copy.deepcopy(EXAMPLE), supply_identity=False)

    @unittest.skipIf(os.name == 'nt', 'requires the POSIX seed writer')
    def test_real_seed_changes_only_explicit_identity_fields(self):
        data = copy.deepcopy(EXAMPLE)
        data['identity']['GPON_SN'] = 'ODIT00000001'
        self.seed_roundtrip(data, supply_identity=True)

    def seed_roundtrip(self, data, supply_identity):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for directory in ['seed', 'config', 'scratch']:
                (root / directory).mkdir()
            for name, content in profile.prepare(data).items():
                (root / name).write_bytes(content)
            xml = ('<Config Name="ROOT">\n <Dir Name="MIB_TABLE">\n'
                   '  <Value Name="GPON_SN" Value="ODITFFFFFFFF"/>\n'
                   '  <Value Name="GPON_PLOAM_PASSWD" Value="unit-fixture-only"/>\n'
                   ' </Dir>\n</Config>\n').encode()
            cs, hs = root / 'config/lastgood.xml', root / 'config/lastgood_hs.xml'
            cs.write_bytes(xml)
            hs.write_bytes(xml)
            env = dict(os.environ, ODI_PROFILE_DIR=str(root / 'seed'),
                       ODI_CONFIG_DIR=str(root / 'config'), CS=str(cs), HS=str(hs),
                       ODI_CONF=str(root / 'config/odi.conf'), TMPDIR_=str(root / 'scratch'),
                       ODI_PROFILE_FLASH=str(ROOT / 'rootfs/skeleton/etc/scripts/flash'))
            command = ['sh', str(ROOT / 'rootfs/skeleton/etc/scripts/profile-seed.sh')]
            subprocess.run(command, env=env, check=True, capture_output=True, timeout=30)
            for file in [cs, hs]:
                self.assertIn(b'GPON_PLOAM_PASSWD" Value="unit-fixture-only"', file.read_bytes())
                serial = b'ODIT00000001' if supply_identity else b'ODITFFFFFFFF'
                self.assertIn(b'GPON_SN" Value="' + serial + b'"', file.read_bytes())
            self.assertEqual((root / 'config/omci-identity.on').exists(), supply_identity)
            self.assertFalse((root / 'config/lan-ip').exists())
            self.assertIn('OMCI_FIXED_ME=', (root / 'config/odi.conf').read_text())
            self.assertEqual((root / 'config/image-profile.id').read_bytes(),
                             (root / 'seed/id').read_bytes())
            first = {p.name: p.read_bytes() for p in (root / 'config').iterdir()}
            subprocess.run(command, env=env, check=True, capture_output=True, timeout=30)
            self.assertEqual(first, {p.name: p.read_bytes() for p in (root / 'config').iterdir()})


if __name__ == '__main__':
    unittest.main()
