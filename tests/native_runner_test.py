"""Runner failure-path checks; no Thunderbird process is started."""
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


RUNNER = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/test-thunderbird.py"))


class NativeRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="stf-runner-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.profile = Path(self.temporary.name)
        (self.profile / "sender-to-filter-test-profile").write_text("disposable\n")
        self.result_path = self.profile / "native-result.json"
        self.process = mock.Mock(pid=123456, returncode=0)

    def run_fixture(self, result=None, visible=False):
        def launch(*args, **kwargs):
            self.assertFalse(self.result_path.exists(), "stale results must be removed before launch")
            if result is not None:
                self.result_path.write_text(json.dumps(result))
            return self.process

        with mock.patch.object(subprocess, "Popen", side_effect=launch) as start:
            output, _ = RUNNER["run_process"](Path("/fixture/thunderbird"), self.profile, 1, visible)
        return output, start

    def test_unmarked_profile_is_refused_before_launch_or_result_removal(self):
        (self.profile / "sender-to-filter-test-profile").write_text("not-disposable\n")
        self.result_path.write_text('{"ok": true}')
        with mock.patch.object(subprocess, "Popen") as start:
            with self.assertRaises(ValueError):
                RUNNER["run_process"](Path("/fixture/thunderbird"), self.profile, 1, False)
        start.assert_not_called()
        self.assertTrue(self.result_path.exists())

    def test_restart_cannot_reuse_stale_success(self):
        self.result_path.write_text('{"ok": true, "checks": ["previous process"]}')
        result, _ = self.run_fixture()
        self.assertFalse(result["ok"])
        self.assertEqual(result["checks"], [])

    def test_crash_overrides_written_success(self):
        self.process.returncode = -6
        result, _ = self.run_fixture({"ok": True, "checks": ["before crash"]})
        self.assertFalse(result["ok"])
        self.assertEqual(result["exit_code"], -6)
        self.assertEqual(result["process_id"], 123456)

    def test_timeout_kills_only_launched_child_and_rejects_success(self):
        self.process.wait.side_effect = [subprocess.TimeoutExpired("fixture", 1),
                                         subprocess.TimeoutExpired("fixture", 5), None]
        result, start = self.run_fixture({"ok": True, "checks": []})
        self.assertFalse(result["ok"])
        self.assertTrue(result["timed_out"])
        start.assert_called_once()
        self.process.terminate.assert_called_once()
        self.process.kill.assert_called_once()
        self.assertEqual(self.process.wait.call_count, 3)

    def test_success_uses_explicit_isolated_profile(self):
        result, start = self.run_fixture({"ok": True, "checks": ["fresh"]})
        self.assertTrue(result["ok"])
        self.assertEqual(start.call_args.args[0],
                         ["/fixture/thunderbird", "--no-remote", "--profile", str(self.profile), "--headless"])
        self.assertEqual(start.call_args.kwargs["env"]["MOZ_NO_REMOTE"], "1")
        self.process.terminate.assert_not_called()

    def test_visible_mode_removes_inherited_headless_setting(self):
        with mock.patch.dict(os.environ, {"MOZ_HEADLESS": "1"}):
            result, start = self.run_fixture({"ok": True, "checks": []}, visible=True)
        self.assertTrue(result["ok"])
        self.assertNotIn("MOZ_HEADLESS", start.call_args.kwargs["env"])
        self.assertNotIn("--headless", start.call_args.args[0])

    def test_macos_sandbox_is_refused_before_creating_profile(self):
        with mock.patch.dict(os.environ, {"CODEX_SANDBOX": "seatbelt"}), \
                mock.patch.object(sys, "platform", "darwin"), \
                mock.patch.object(sys, "argv", ["test-thunderbird.py", "--binary", "/fixture/thunderbird"]), \
                mock.patch.object(subprocess, "Popen") as start, \
                mock.patch.object(tempfile, "TemporaryDirectory") as create_profile, \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                RUNNER["main"]()
        self.assertEqual(error.exception.code, 2)
        start.assert_not_called()
        create_profile.assert_not_called()

    def test_application_copy_excludes_updaters_and_leaves_installed_bundle_untouched(self):
        bundle = self.profile / "installed/Thunderbird.app"
        binary = bundle / "Contents/MacOS/thunderbird"
        helper = bundle / "Contents/Library/LaunchServices/org.mozilla.updater"
        updater = bundle / "Contents/MacOS/updater.app/Contents/MacOS/org.mozilla.updater"
        for file in [binary, helper, updater]:
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("original")
        directory = self.profile / "temporary"; directory.mkdir()
        with mock.patch.object(sys, "platform", "darwin"), mock.patch.object(subprocess, "run") as sign:
            copied = RUNNER["isolated_binary"](binary, directory)
        self.assertEqual(sign.call_count, 2)
        self.assertTrue(all(str(directory) in str(call.args[0][-1]) for call in sign.call_args_list))
        self.assertNotEqual(copied, binary)
        self.assertEqual(copied.read_text(), "original")
        self.assertFalse((copied.parent / "updater.app").exists())
        self.assertFalse((copied.parents[1] / "Library/LaunchServices/org.mozilla.updater").exists())
        policies = json.loads((copied.parents[1] / "Resources/distribution/policies.json").read_text())
        self.assertTrue(policies["policies"]["DisableAppUpdate"])
        self.assertEqual(helper.read_text(), "original")
        self.assertEqual(updater.read_text(), "original")
        self.assertFalse((bundle / "Contents/Resources/distribution/policies.json").exists())


if __name__ == "__main__":
    unittest.main()
