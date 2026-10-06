from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import tarfile
import unittest


SIM = Path(__file__).resolve().parents[1]


class CachedBuildTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.scripts = self.root / 'sim'
        self.scripts.mkdir()
        shutil.copy(SIM / 'ci-build.sh', self.scripts)
        self.cache = self.root / 'cache'
        self.tree = self.cache / 'android/lineage'
        self.tree.mkdir(parents=True)
        self.status = self.root / 'status'
        self.calls = self.root / 'calls'
        (self.scripts / 'build.sh').write_text('''#!/bin/bash
set -euo pipefail
printf '%s|%s|%s|%s|%s|%s\\n' "$1" "$2" "$3" "$BUILD_JOBS" "$SYNC_JOBS" "${SKIP_SYNC:-unset}" >> "$CALLS"
test -f "$1/out/non-ab/compiled.o"
test -f "$1/out/ab/compiled.o"
test ! -e "$1/out/releases/$2/stale.zip"
exit "${RESULT:-0}"
''')
        for layout in ('non-ab', 'ab'):
            output = self.tree / 'out' / layout
            output.mkdir(parents=True)
            (output / 'compiled.o').write_text('cached compiler output')
        release = self.tree / 'out/releases/virtio_arm64only'
        release.mkdir(parents=True)
        (release / 'stale.zip').write_text('old release')
        self.env = {**os.environ, 'DEPOT_BUILD_ROOT': str(self.status),
                    'CALLS': str(self.calls), 'BUILD_JOBS': '32', 'SYNC_JOBS': '8',
                    'SKIP_SYNC': '1', 'OUT_DIR': 'unrelated-output', 'CI_MIN_LOCAL_GIB': '0'}

    def checkpoint(self):
        with tarfile.open(self.cache / 'android.tar', 'w') as archive:
            archive.add(self.tree, arcname='.')

    def run_build(self, **env):
        self.checkpoint()
        return subprocess.run(['bash', str(self.scripts / 'ci-build.sh'), str(self.cache)],
                              env={**self.env, **env}, capture_output=True, text=True)

    def test_reuses_compiler_outputs_without_republishing_old_releases(self):
        result = self.run_build()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.calls.read_text().strip().split('|')[1:],
                         ['virtio_arm64only', 'both', '32', '8', 'unset'])
        self.assertEqual((self.status / 'build.exit').read_text(), '0\n')
        working = self.status / 'android/lineage'
        self.assertFalse(working.is_symlink())
        self.assertNotEqual(working.resolve(), self.tree)
        self.assertTrue((working / 'out/non-ab/compiled.o').exists())
        with tarfile.open(self.cache / 'android.tar') as archive:
            self.assertFalse(any(name.startswith('./out/releases') for name in archive.getnames()))

    def test_failed_build_keeps_failure_code_and_cached_outputs(self):
        self.checkpoint()
        original = (self.cache / 'android.tar').read_bytes()
        result = subprocess.run(['bash', str(self.scripts / 'ci-build.sh'), str(self.cache)],
                                env={**self.env, 'RESULT': '7'}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 7)
        self.assertEqual((self.status / 'build.exit').read_text(), '7\n')
        self.assertTrue((self.status / 'android/lineage/out/non-ab/compiled.o').exists())
        self.assertEqual((self.cache / 'android.tar').read_bytes(), original)

    def test_ci_owned_source_edits_are_reset_without_cleaning_output_trees(self):
        project = self.tree / 'device/virt/virtio-common'
        project.mkdir(parents=True)
        subprocess.run(['git', 'init', '-q', str(project)], check=True)
        tracked = project / 'device-common.mk'
        tracked.write_text('upstream\n')
        subprocess.run(['git', '-C', str(project), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(project), '-c', 'user.name=Fixture',
                        '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], check=True)
        tracked.write_text('previous overlay\n')
        stale = project / 'modem_simulator/obsolete.cpp'
        stale.parent.mkdir()
        stale.write_text('removed overlay')
        unrelated = project / 'unrelated.txt'
        unrelated.write_text('not managed by the overlay')
        result = self.run_build()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        working = self.status / 'android/lineage'
        self.assertEqual((working / 'device/virt/virtio-common/device-common.mk').read_text(), 'upstream\n')
        self.assertFalse((working / 'device/virt/virtio-common/modem_simulator/obsolete.cpp').exists())
        self.assertTrue((working / 'device/virt/virtio-common/unrelated.txt').exists())
        self.assertTrue((working / 'out/ab/compiled.o').exists())
        self.assertEqual(tracked.read_text(), 'previous overlay\n')

    def test_broken_cached_git_metadata_fails_before_building(self):
        project = self.tree / 'vendor/lineage'
        project.mkdir(parents=True)
        (project / '.git').write_text('invalid git metadata\n')
        result = self.run_build()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.status / 'bootstrap.exit').read_text().strip(), str(result.returncode))
        self.assertFalse(self.calls.exists())

    def test_insufficient_storage_fails_before_restoring_or_building(self):
        space = os.statvfs(self.root)
        unavailable = space.f_bavail * space.f_frsize // 1024 ** 3 + 1
        result = self.run_build(CI_MIN_LOCAL_GIB=str(unavailable))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('insufficient local disk', result.stderr)
        self.assertFalse((self.status / 'android/lineage').exists())
        self.assertFalse(self.calls.exists())

    def test_storage_only_preflight_does_not_restore_or_build(self):
        self.checkpoint()
        result = subprocess.run(['bash', str(self.scripts / 'ci-build.sh'), str(self.cache),
                                 'virtio_arm64only', '--check-storage'],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.status / 'android/lineage').exists())
        self.assertFalse(self.calls.exists())

    def test_empty_cache_builds_locally_and_publishes_an_archive(self):
        (self.scripts / 'build.sh').write_text('''#!/bin/bash
set -euo pipefail
mkdir -p "$1/out/non-ab"
printf 'compiled' > "$1/out/non-ab/compiled.o"
''')
        result = subprocess.run(['bash', str(self.scripts / 'ci-build.sh'), str(self.cache)],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        with tarfile.open(self.cache / 'android.tar') as archive:
            self.assertEqual(archive.extractfile('./out/non-ab/compiled.o').read(), b'compiled')

    def test_restore_retains_symlinks_and_hardlinks(self):
        output = self.tree / 'out/non-ab'
        (output / 'linked.o').symlink_to('compiled.o')
        os.link(output / 'compiled.o', output / 'hardlinked.o')
        result = self.run_build()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        working = self.status / 'android/lineage/out/non-ab'
        self.assertTrue((working / 'linked.o').is_symlink())
        self.assertEqual((working / 'compiled.o').stat().st_ino, (working / 'hardlinked.o').stat().st_ino)

    def test_corrupt_archive_fails_preparation_without_running_the_build(self):
        (self.cache / 'android.tar').write_bytes(b'not a tar archive')
        result = subprocess.run(['bash', str(self.scripts / 'ci-build.sh'), str(self.cache)],
                                env=self.env, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.status / 'bootstrap.exit').read_text().strip(), str(result.returncode))
        self.assertFalse(self.calls.exists())

    def test_failed_checkpoint_write_retains_previous_good_archive(self):
        self.checkpoint()
        original = (self.cache / 'android.tar').read_bytes()
        tools = self.root / 'tools'
        tools.mkdir()
        real_tar = shutil.which('tar')
        wrapper = tools / 'tar'
        wrapper.write_text(f'''#!/bin/bash
if [ "$1" = --create ]; then exit 9; fi
exec "{real_tar}" "$@"
''')
        wrapper.chmod(0o755)
        result = subprocess.run(['bash', str(self.scripts / 'ci-build.sh'), str(self.cache)],
                                env={**self.env, 'PATH': str(tools) + os.pathsep + os.environ['PATH']},
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 9)
        self.assertEqual((self.cache / 'android.tar').read_bytes(), original)
        self.assertEqual(list(self.cache.glob('android.tar.*')), [])


if __name__ == '__main__':
    unittest.main()
