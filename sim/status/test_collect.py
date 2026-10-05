import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location('collect', Path(__file__).with_name('collect.py'))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class CollectorTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / 'bootstrap.exit').write_text('0')

    def write_release(self, layout, product='virtio_arm64only'):
        release = self.root / 'android/lineage/out/releases' / product / layout / 'release.json'
        release.parent.mkdir(parents=True, exist_ok=True)
        release.write_text(json.dumps({'product': product, 'partition_layout': layout}))

    def mark_verified_layout(self, layout):
        self.write_release(layout)
        for stage in ('policy', 'inspect', 'upload'):
            (self.root / f'{stage}-{layout}.exit').write_text('0')

    def test_running_build_and_incremental_refresh(self):
        log = self.root / 'build.log'
        log.write_text('OUT_DIR=out/non-ab\nTARGET_BUILD_VARIANT=userdebug\n[ 28% 28/100] compile fixture\nsecret value must not appear\n')
        first = collector.collect(self.root)
        self.assertEqual(first['layouts'][0]['progress']['percent'], 28)
        self.assertEqual(first['layouts'][1]['status'], 'queued')
        self.assertEqual(first['recent'], ['Build actions: 28% (28/100)'])
        self.assertNotIn('secret value', json.dumps(first))
        with log.open('a') as stream:
            stream.write('[ 29% 29/100] compile fixture\n')
        self.assertEqual(collector.collect(self.root)['layouts'][0]['progress']['done'], 29)

    def test_verified_uploads_expose_only_public_links(self):
        (self.root / 'build.exit').write_text('0')
        for layout in ('non-ab', 'ab'):
            self.mark_verified_layout(layout)
        (self.root / 'pipeline.exit').write_text('0')
        (self.root / 'upload-non-ab.log').write_text('  "fixture.zip" (123 bytes, MD5 abc)\n    https://gofile.io/d/file-id\n    folder: https://gofile.io/d/folder-id\n')
        result = collector.collect(self.root)
        self.assertEqual(result['status'], 'complete')
        self.assertEqual(result['layouts'][0]['status'], 'complete')
        self.assertEqual(result['layouts'][0]['downloads'], [{'name': 'fixture.zip', 'url': 'https://gofile.io/d/folder-id'}])

    def test_upload_success_without_release_or_checks_is_not_complete(self):
        (self.root / 'upload-non-ab.exit').write_text('0')
        (self.root / 'upload-non-ab.log').write_text('  "fixture.zip" (123 bytes, MD5 abc)\n    https://gofile.io/d/file-id\n')
        result = collector.collect(self.root)
        self.assertNotEqual(result['layouts'][0]['status'], 'complete')
        self.assertEqual(result['layouts'][0]['downloads'], [])

    def test_successful_build_only_run_is_built_for_both_layouts(self):
        (self.root / 'build.exit').write_text('0')
        for layout in ('non-ab', 'ab'):
            self.write_release(layout)
        result = collector.collect(self.root)
        self.assertEqual(result['status'], 'built')
        self.assertEqual(result['stage'], 'Images built · uploads not started')
        for layout in result['layouts']:
            self.assertEqual(layout['status'], 'built')
            self.assertEqual(layout['downloads'], [])

    def test_successful_build_without_release_metadata_is_not_built(self):
        (self.root / 'build.exit').write_text('0')
        (self.root / 'pipeline.exit').write_text('0')
        result = collector.collect(self.root)
        self.assertNotEqual(result['status'], 'built')
        self.assertNotIn('built', [layout['status'] for layout in result['layouts']])

    def test_build_failure_overrides_pipeline_success(self):
        (self.root / 'build.log').write_text('OUT_DIR=out/ab\nFAILED: fixture target\n')
        (self.root / 'build.exit').write_text('1')
        (self.root / 'pipeline.exit').write_text('0')
        result = collector.collect(self.root)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['stage'], 'Image build failed')
        self.assertEqual(result['failure'], 'Image build failed (exit code 1).')
        self.assertEqual(result['layouts'][1]['status'], 'failed')
        self.assertNotIn('fixture target', json.dumps(result))

    def test_marker_only_failure_has_safe_fallback(self):
        (self.root / 'inspect-ab.exit').write_text('3')
        result = collector.collect(self.root)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['stage'], 'Image checks failed · A/B')
        self.assertEqual(result['failure'], 'Image checks failed for A/B release (exit code 3).')

    def test_bootstrap_failure_blocks_both_layouts_without_building(self):
        (self.root / 'bootstrap.exit').write_text('2')
        result = collector.collect(self.root)
        self.assertEqual(result['stage'], 'Builder setup failed')
        self.assertEqual(result['failure'], 'Builder setup failed (exit code 2).')
        for layout in result['layouts']:
            self.assertEqual(layout['status'], 'blocked')
            self.assertEqual([step['status'] for step in layout['steps']], ['pending'] * 4)
            self.assertIsNone(layout['progress'])

    def test_pipeline_failure_does_not_uncomplete_verified_layouts(self):
        (self.root / 'build.exit').write_text('0')
        for layout in ('non-ab', 'ab'):
            self.mark_verified_layout(layout)
        (self.root / 'pipeline.exit').write_text('7')
        result = collector.collect(self.root)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['stage'], 'Build pipeline failed')
        self.assertEqual(result['layouts'][0]['status'], 'complete')
        self.assertEqual(result['layouts'][1]['status'], 'complete')

    def test_progress_and_failure_summaries_do_not_persist_log_text(self):
        secret = 'ghp_private_test_credential'
        (self.root / 'build.log').write_text(
            f'OUT_DIR=out/ab\nTARGET_BUILD_VARIANT={secret}\n'
            f'[ 28% 28/100] compile with token {secret}\n'
            f'FAILED: /private/target command={secret}\n'
        )
        result = collector.collect(self.root)
        saved = (self.root / '.lutm-status.json').read_text()
        output = json.dumps(result)
        self.assertEqual(result['recent'], ['Build actions: 28% (28/100)'])
        self.assertEqual(result['failure'], collector.GENERIC_COMPILER_FAILURE)
        self.assertNotIn(secret, output)
        self.assertNotIn(secret, saved)
        self.assertNotIn('FAILED:', output)
        self.assertNotIn('/private/target', saved)

    def test_replacing_log_resets_cached_progress_and_failure(self):
        log = self.root / 'build.log'
        log.write_text('OUT_DIR=out/non-ab\n[ 28% 28/100] compile\nFAILED: old failure\n')
        self.assertTrue(collector.collect(self.root)['failure'])
        replacement = self.root / 'replacement.log'
        replacement.write_text('OUT_DIR=out/ab\n' + 'setup output\n' * 10)
        self.assertGreater(replacement.stat().st_size, log.stat().st_size)
        os.replace(replacement, log)
        result = collector.collect(self.root)
        self.assertEqual(result['recent'], [])
        self.assertIsNone(result['failure'])
        self.assertIsNone(result['layouts'][1]['progress'])

    def test_truncating_log_resets_cached_progress_and_failure(self):
        log = self.root / 'build.log'
        log.write_text('OUT_DIR=out/non-ab\n[ 28% 28/100] compile\nFAILED: old failure\n')
        self.assertTrue(collector.collect(self.root)['failure'])
        log.write_text('OUT_DIR=out/ab\n')
        result = collector.collect(self.root)
        self.assertEqual(result['recent'], [])
        self.assertIsNone(result['failure'])
        self.assertIsNone(result['layouts'][1]['progress'])

    def test_layout_switch_clears_previous_recent_activity(self):
        log = self.root / 'build.log'
        log.write_text('OUT_DIR=out/non-ab\n[ 28% 28/100] compile\nFAILED: old attempt\n')
        collector.collect(self.root)
        with log.open('a') as stream:
            stream.write('OUT_DIR=out/ab\n[ 50% 50/100] compile\n')
        result = collector.collect(self.root)
        self.assertEqual(result['recent'], ['Build actions: 50% (50/100)'])
        self.assertIsNone(result['layouts'][0]['progress'])
        self.assertEqual(result['layouts'][1]['progress']['percent'], 50)
        self.assertIsNone(result['failure'])

    def test_new_variant_in_the_same_layout_resets_previous_actions(self):
        log = self.root / 'build.log'
        log.write_text('OUT_DIR=out/non-ab\nTARGET_BUILD_VARIANT=userdebug\n[100% 100/100] recovery\n')
        collector.collect(self.root)
        with log.open('a') as stream:
            stream.write('TARGET_BUILD_VARIANT=user\nOUT_DIR=out/non-ab\n')
        result = collector.collect(self.root)
        self.assertEqual(result['recent'], [])
        self.assertIsNone(result['layouts'][0]['progress'])
        self.assertEqual(result['stage'], 'Building non-A/B')

    def test_product_comes_from_safe_metadata_or_explicit_argument(self):
        metadata = self.root / '.lutm-build.json'
        metadata.write_text(json.dumps({'product': 'virtio_x86_64'}))
        self.assertEqual(collector.collect(self.root)['product'], 'virtio_x86_64')
        self.assertEqual(collector.collect(self.root, 'virtio_arm64only')['product'], 'virtio_arm64only')
        metadata.write_text(json.dumps({'product': '../outside'}))
        self.assertEqual(collector.collect(self.root)['product'], 'virtio_arm64only')
        with self.assertRaises(ValueError):
            collector.collect(self.root, '../outside')


if __name__ == '__main__':
    unittest.main()
