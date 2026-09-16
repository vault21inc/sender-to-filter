#!/usr/bin/env python3
"""Run native filter checks in a new, offline, disposable Thunderbird profile."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, help="Path to the Thunderbird executable")
    parser.add_argument("--output", default="dist/native-check.json")
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()
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
        profile = Path(temporary) / "profile"
        extensions = profile / "extensions"
        extensions.mkdir(parents=True)
        (profile / "sender-to-filter-test-profile").write_text("disposable\n")
        preferences = {
            "extensions.autoDisableScopes": 0, "extensions.enabledScopes": 15,
            "extensions.startupScanScopes": 15, "mail.shell.checkDefaultClient": False,
            "mailnews.start_page.enabled": False, "mailnews.start_page.url": "about:blank",
            "mail.provider.enabled": False, "mail.rights.version": 1,
            "app.update.auto": False, "app.update.enabled": False,
            "network.online": False, "network.manage-offline-status": False,
            "datareporting.policy.dataSubmissionEnabled": False,
            "toolkit.telemetry.enabled": False,
            "browser.dom.window.dump.enabled": True,
            "devtools.console.stdout.chrome": True,
            "devtools.console.stdout.content": True,
        }
        (profile / "user.js").write_text("\n".join(
            f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in preferences.items()
        ) + "\n")
        addon = extensions / (manifest["browser_specific_settings"]["gecko"]["id"] + ".xpi")
        with zipfile.ZipFile(addon, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", json.dumps(manifest))
            for component in ["background.js", "api", "_locales", "icons"]:
                entry = root / component
                files = entry.rglob("*") if entry.is_dir() else [entry]
                for file in files:
                    if file.is_file():
                        archive.write(file, file.relative_to(root))
            for file in (root / "tests/native").iterdir():
                if file.is_file():
                    archive.write(file, "native/" + file.name)

        print("Running Thunderbird native checks in an offline disposable profile…", flush=True)
        environment = {**os.environ, "MOZ_HEADLESS": "1", "MOZ_NO_REMOTE": "1"}
        with tempfile.TemporaryFile(mode="w+b") as log:
            process = subprocess.Popen([str(binary), "--headless", "--no-remote", "--profile", str(profile)],
                                       env=environment, stdout=log, stderr=subprocess.STDOUT)
            timed_out = False
            try:
                process.wait(timeout=args.timeout)
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
        result_path = profile / "native-result.json"
        if result_path.exists():
            result = json.loads(result_path.read_text())
        else:
            result = {"ok": False, "checks": [], "error": "Native harness did not finish", "timed_out": timed_out,
                      "exit_code": process.returncode}
            result["profile_files"] = sorted(p.name for p in profile.iterdir())
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
        print(json.dumps(result, indent=2))
        if not result["ok"]:
            print(log_text[-12000:])
        return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
