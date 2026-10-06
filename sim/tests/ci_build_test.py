from pathlib import Path
import os
import shutil
import subprocess
import tempfile
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
                    'SKIP_SYNC': '1', 'OUT_DIR': 'unrelated-output'}

    def run_build(self, **env):
        return subprocess.run(['bash', str(self.scripts / 'ci-build.sh'), str(self.cache)],
                              env={**self.env, **env}, capture_output=True, text=True)

    def test_reuses_compiler_outputs_without_republishing_old_releases(self):
        result = self.run_build()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.calls.read_text().strip().split('|')[1:],
                         ['virtio_arm64only', 'both', '32', '8', 'unset'])
        self.assertEqual((self.status / 'build.exit').read_text(), '0\n')
        self.assertEqual((self.status / 'android/lineage').resolve(), self.tree)

    def test_failed_build_keeps_failure_code_and_cached_outputs(self):
        result = self.run_build(RESULT='7')
        self.assertEqual(result.returncode, 7)
        self.assertEqual((self.status / 'build.exit').read_text(), '7\n')
        self.assertTrue((self.tree / 'out/non-ab/compiled.o').exists())

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
        self.assertEqual(tracked.read_text(), 'upstream\n')
        self.assertFalse(stale.exists())
        self.assertTrue(unrelated.exists())
        self.assertTrue((self.tree / 'out/ab/compiled.o').exists())

    def test_broken_cached_git_metadata_fails_before_building(self):
        project = self.tree / 'vendor/lineage'
        project.mkdir(parents=True)
        (project / '.git').write_text('invalid git metadata\n')
        result = self.run_build()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.status / 'bootstrap.exit').read_text().strip(), str(result.returncode))
        self.assertFalse(self.calls.exists())


if __name__ == '__main__':
    unittest.main()
