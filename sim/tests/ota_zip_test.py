from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
import zipfile


SIM = Path(__file__).resolve().parents[1]


class OtaZipTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / 'non_ab_ota.py'
        self.source.write_text('def zip_command(tmpfile):\n    return ["zip", tmpfile, "-r", ".", "-0"]\n')

    def patch(self):
        return subprocess.run(['python3', str(SIM / 'patch_ota_zip.py'), str(self.source)],
                              capture_output=True, text=True)

    def test_patch_is_idempotent(self):
        self.assertEqual(self.patch().returncode, 0)
        first = self.source.read_text()
        self.assertEqual(self.patch().returncode, 0)
        self.assertEqual(first, self.source.read_text())
        self.assertIn('"-y"', first)

    def test_unknown_upstream_command_fails_without_rewriting_it(self):
        self.source.write_text('unsupported command\n')
        result = self.patch()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.source.read_text(), 'unsupported command\n')

    def test_archive_preserves_guest_link_without_reading_host_files(self):
        self.assertEqual(self.patch().returncode, 0)
        payload = self.root / 'target-files'
        ramdisk = payload / 'RECOVERY/RAMDISK'
        ramdisk.mkdir(parents=True)
        host = self.root / 'host-debug'
        host.mkdir()
        (host / 'events').write_text('not guest data')
        (ramdisk / 'd').symlink_to(host, target_is_directory=True)
        (ramdisk / 'guest-file').write_text('guest data')
        namespace = {}
        exec(self.source.read_text(), namespace)
        archive = self.root / 'target.zip'
        result = subprocess.run(namespace['zip_command'](str(archive)), cwd=payload,
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        with zipfile.ZipFile(archive) as zipped:
            link = zipped.getinfo('RECOVERY/RAMDISK/d')
            self.assertTrue(stat.S_ISLNK(link.external_attr >> 16))
            self.assertEqual(zipped.read(link).decode(), str(host))
            self.assertFalse(any(name.startswith('RECOVERY/RAMDISK/d/') for name in zipped.namelist()))
            self.assertEqual(zipped.read('RECOVERY/RAMDISK/guest-file'), b'guest data')


if __name__ == '__main__':
    unittest.main()
