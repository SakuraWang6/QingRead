"""Packaging boundaries for the local ArkWeb origin; no SDK or device needed."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('prepare_harmony', Path(__file__).with_name('prepare-harmony.py'))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class HarmonyAssetsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        self.source = self.root / 'dist'
        self.source.mkdir()
        (self.source / 'assets').mkdir()
        (self.source / 'index.html').write_text('<script type="module" src="/assets/main.js"></script>')
        (self.source / 'assets/main.js').write_text('export const version = 1;')
        self.destination = self.root / 'rawfile'

    def test_packages_complete_offline_resources_with_correct_types_and_hashes(self):
        binary = b'\0asm\x01\0\0\0'
        (self.source / 'assets/reader.wasm').write_bytes(binary)
        self.assertEqual(prepare.prepare(self.source, self.destination), 3)
        index = json.loads((self.destination / 'qingread-assets.json').read_text())
        assets = {item['path']: item for item in index['assets']}
        self.assertEqual(index['schemaVersion'], 1)
        self.assertEqual(assets['/assets/reader.wasm']['mime'], 'application/wasm')
        self.assertEqual(assets['/assets/reader.wasm']['sha256'], hashlib.sha256(binary).hexdigest())
        self.assertEqual((self.destination / 'web/assets/reader.wasm').read_bytes(), binary)

    def test_subpath_or_incomplete_build_does_not_replace_existing_resources(self):
        prepare.prepare(self.source, self.destination)
        before = (self.destination / 'qingread-assets.json').read_bytes()
        (self.source / 'index.html').write_text('<script src="/qingread/assets/main.js"></script>')
        with self.assertRaises(ValueError):
            prepare.prepare(self.source, self.destination)
        self.assertEqual((self.destination / 'qingread-assets.json').read_bytes(), before)
        self.assertIn('version = 1', (self.destination / 'web/assets/main.js').read_text())

    def test_symlinks_and_private_signing_files_are_rejected(self):
        for name in ['signature.p12', 'session.db', 'identity.pem', 'identity.p12.bak',
                     'identity.pem.txt', 'session.sqlite-wal', 'id_rsa', 'secrets.yaml']:
            with self.subTest(name=name):
                path = self.source / name
                path.write_text('private fixture')
                with self.assertRaises(ValueError):
                    prepare.prepare(self.source, self.destination)
                path.unlink()
        private = self.root / 'outside.txt'
        private.write_text('outside fixture')
        (self.source / 'linked.txt').symlink_to(private)
        with self.assertRaises(ValueError):
            prepare.prepare(self.source, self.destination)

    def test_changed_input_preserves_previous_build(self):
        prepare.prepare(self.source, self.destination)
        before = (self.destination / 'qingread-assets.json').read_bytes()
        copy = prepare.shutil.copyfile

        def changing_copy(source, destination):
            result = copy(source, destination)
            if Path(source).name == 'main.js':
                Path(destination).write_text('changed during packaging')
            return result

        with mock.patch.object(prepare.shutil, 'copyfile', changing_copy):
            with self.assertRaises(ValueError):
                prepare.prepare(self.source, self.destination)
        self.assertEqual((self.destination / 'qingread-assets.json').read_bytes(), before)
        self.assertIn('version = 1', (self.destination / 'web/assets/main.js').read_text())
        self.assertEqual(list(self.destination.glob('.qingread-stage-*')), [])


if __name__ == '__main__':
    unittest.main()
