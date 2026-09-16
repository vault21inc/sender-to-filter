#!/usr/bin/env python3
"""Run native filter checks in a new, offline, disposable Thunderbird profile."""
import argparse
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile


def isolated_binary(binary, directory):
    """Copy macOS apps, excluding both updater executables, before any launch.

    A profile alone cannot isolate an application update pending at startup.
    Never launch the installed .app or modify its policies, files or updater.
    """
    if sys.platform != "darwin":
        return binary
    bundle = next((p for p in binary.parents if p.suffix == ".app"), None)
    if bundle is None:
        raise ValueError("macOS native checks require an application bundle to copy")
    copied = directory / "Thunderbird-test.app"
    shutil.copytree(bundle, copied, symlinks=True,
                    ignore=lambda _path, names: set(names) & {"updater.app", "org.mozilla.updater"})
    policies = copied / "Contents/Resources/distribution/policies.json"
    policies.parent.mkdir(parents=True, exist_ok=True)
    policies.write_text(json.dumps({"policies": {"DisableAppUpdate": True, "DisableTelemetry": True}}))
    # Removing signed nested updaters invalidates the copy's bundle seal. Sign
    # only this disposable copy locally; the original retains Mozilla's seal.
    subprocess.run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", str(copied)],
                   check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(copied)],
                   check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return copied / binary.relative_to(bundle)


def run_process(binary, profile, timeout, visible):
    """Run only this marked disposable profile, rejecting stale success files."""
    if (profile / "sender-to-filter-test-profile").read_text() != "disposable\n":
        raise ValueError("Refusing an unmarked profile")
    result_path = profile / "native-result.json"
    result_path.unlink(missing_ok=True)
    environment = {**os.environ, "MOZ_NO_REMOTE": "1"}
    environment.pop("MOZ_APP_SILENT_START", None)
    command = [str(binary), "--no-remote", "--profile", str(profile)]
    if visible:
        environment.pop("MOZ_HEADLESS", None)
    else:
        environment["MOZ_HEADLESS"] = "1"
        command.append("--headless")
    with tempfile.TemporaryFile(mode="w+b") as log:
        process = subprocess.Popen(command, env=environment, stdout=log, stderr=subprocess.STDOUT)
        timed_out = False
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        log.seek(0)
        log_text = log.read().decode("utf-8", errors="replace")
    if result_path.exists():
        result = json.loads(result_path.read_text())
    else:
        result = {"ok": False, "checks": [], "error": "Native harness did not finish"}
        result["profile_files"] = sorted(p.name for p in profile.iterdir())
    result["timed_out"] = timed_out
    result["exit_code"] = process.returncode
    result["process_id"] = process.pid
    if timed_out or process.returncode != 0:
        result["ok"] = False
        result.setdefault("error", "Thunderbird did not exit successfully")
    return result, log_text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, help="Path to the Thunderbird executable")
    parser.add_argument("--output", default="test-results/native-check.json",
                        help="Result JSON path (default: test-results/native-check.json); logs and screenshots are saved alongside it")
    parser.add_argument("--timeout", type=int, default=60)
    parser.add_argument("--shared", action="store_true", help="Run shared-rule prerequisites and verify a real restart")
    parser.add_argument("--visible", action="store_true", help="Show the disposable-profile windows instead of using headless mode")
    args = parser.parse_args()
    if sys.platform == "darwin" and os.environ.get("CODEX_SANDBOX") == "seatbelt":
        parser.error("Thunderbird requires macOS application registration outside the Codex seatbelt sandbox. "
                     "Run this command with approved sandbox escalation or from a normal terminal; no profile was opened.")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    root = Path(__file__).resolve().parent.parent
    binary = Path(args.binary).expanduser().resolve(strict=True)
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((root / "manifest.json").read_text())
    manifest["background"]["scripts"].append("native/background.js")
    manifest["experiment_apis"]["nativeTest"] = {
        "schema": "native/schema.json",
        "parent": {"scopes": ["addon_parent"], "paths": [["nativeTest"]], "script": "native/implementation.js"},
    }
    with tempfile.TemporaryDirectory(prefix="sender-to-filter-test-") as temporary:
        test_binary = isolated_binary(binary, Path(temporary))
        profile = Path(temporary) / "profile"
        extensions = profile / "extensions"
        extensions.mkdir(parents=True)
        (profile / "sender-to-filter-test-profile").write_text("disposable\n")
        if args.shared:
            fixture_root = profile / "shared-fixtures"
            fixture_root.mkdir(mode=0o700)
            (fixture_root / "imap").mkdir(mode=0o700)
            (fixture_root / "imap-alias").symlink_to("imap", target_is_directory=True)
        preferences = {
            "extensions.autoDisableScopes": 0, "extensions.enabledScopes": 15,
            "extensions.startupScanScopes": 15, "mail.shell.checkDefaultClient": False,
            "mailnews.start_page.enabled": False, "mailnews.start_page.url": "about:blank",
            "mail.provider.enabled": False, "mail.rights.version": 1,
            "app.update.auto": False, "app.update.enabled": False,
            "network.online": False, "network.manage-offline-status": False,
            "datareporting.policy.dataSubmissionEnabled": False,
            "toolkit.telemetry.enabled": False,
            "datareporting.healthreport.uploadEnabled": False,
            "toolkit.telemetry.unified": False,
            "browser.region.network.url": "", "browser.region.update.enabled": False,
            "app.update.disabledForTesting": True, "extensions.update.enabled": False,
            "browser.dom.window.dump.enabled": True,
            "devtools.console.stdout.chrome": True,
            "devtools.console.stdout.content": True,
            "sender-to-filter.test.shared": args.shared,
        }
        (profile / "user.js").write_text("\n".join(
            f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in preferences.items()
        ) + "\n")
        addon = extensions / (manifest["browser_specific_settings"]["gecko"]["id"] + ".xpi")
        with zipfile.ZipFile(addon, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest))
            for component in ["background.js", "api", "lib", "options", "_locales", "icons"]:
                entry = root / component
                files = entry.rglob("*") if entry.is_dir() else [entry]
                for file in files:
                    if file.is_file():
                        archive.write(file, file.relative_to(root))
            for file in (root / "tests/native").iterdir():
                if file.is_file():
                    archive.write(file, "native/" + file.name)

        print("Running Thunderbird native checks with an isolated application and offline disposable profile…", flush=True)
        result, log_text = run_process(test_binary, profile, args.timeout, args.visible)
        result["isolated_application"] = test_binary != binary
        if args.shared and result["ok"]:
            if not result.get("shared", {}).get("requiresRestart"):
                result.update(ok=False, error="Shared seed phase did not request restart verification")
            else:
                print("Restarting the same disposable profile to verify saved shared rules…", flush=True)
                restarted, restart_log = run_process(test_binary, profile, args.timeout, args.visible)
                restarted["isolated_application"] = test_binary != binary
                log_text += "\n--- Shared restart verification ---\n" + restart_log
                restart_ok = restarted["ok"] and restarted.get("shared", {}).get("phase") == "restart"
                result = {"ok": bool(restart_ok), "version": result.get("version"),
                          "checks": result["checks"] + restarted["checks"], "runs": [result, restarted]}
                if not restart_ok:
                    result["error"] = "Shared restart verification failed"
        if not result["ok"]:
            extension_state = profile / "extensions.json"
            if extension_state.exists():
                installed = json.loads(extension_state.read_text()).get("addons", [])
                result["addon_state"] = [
                    {key: addon.get(key) for key in ["id", "active", "userDisabled", "appDisabled", "signedState", "visible"]}
                    for addon in installed if addon.get("id") == manifest["browser_specific_settings"]["gecko"]["id"]
                ]
        output.write_text(json.dumps(result, indent=2) + "\n")
        output.with_suffix(".log").write_text(log_text)
        screenshot = profile / "native-filter-tags.png"
        if screenshot.exists():
            output.with_suffix(".png").write_bytes(screenshot.read_bytes())
        shared_list_screenshot = profile / "native-shared-filter-list.png"
        if shared_list_screenshot.exists():
            output.with_name(output.stem + "-shared-list.png").write_bytes(shared_list_screenshot.read_bytes())
        shared_run_screenshot = profile / "native-shared-run.png"
        if shared_run_screenshot.exists():
            output.with_name(output.stem + "-shared-run.png").write_bytes(shared_run_screenshot.read_bytes())
        shared_space_screenshot = profile / "native-shared-space.png"
        if shared_space_screenshot.exists():
            output.with_name(output.stem + "-shared-space.png").write_bytes(shared_space_screenshot.read_bytes())
        print(json.dumps(result, indent=2))
        if not result["ok"]:
            print(log_text[-12000:])
        return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
