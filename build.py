#!/usr/bin/env python3

import argparse
import glob
import hashlib
import json
import os
import subprocess
import sys


def run(cmd, *, capture=False, env=None):
    merged = {**os.environ, **(env or {})}
    result = subprocess.run(cmd, capture_output=capture, text=True, env=merged, check=True)
    return result.stdout.strip() if capture else None


def git_log_timestamp(ref):
    return run(["git", "log", "-1", "--format=%ct", ref], capture=True)


def git_short_sha(ref):
    return run(["git", "rev-parse", "--short=7", ref], capture=True)


def clean():
    for pattern in ("*.vsix", "*.vsix.sha256"):
        for f in glob.glob(pattern):
            os.remove(f)


def restore_package_files():
    for f in ("package.json", "package-lock.json"):
        subprocess.run(["git", "restore", f], capture_output=True)


def checkout_ref(ref):
    print(f"Checking out: {ref}")
    run(["git", "checkout", ref])


def bump_nightly_version(ref):
    with open("package.json") as f:
        pkg = json.load(f)
    parts = pkg["version"].split(".")
    parts[2] = str(int(parts[2]) + 1)
    short_sha = git_short_sha(ref)
    version = f"{'.'.join(parts)}-{short_sha}"
    run(["npm", "version", version, "--no-git-tag-version"], capture=True)
    normalize_package_json()
    return version


def normalize_package_json():
    with open("package.json") as f:
        pkg = json.load(f)
    with open("package.json", "w") as f:
        json.dump(pkg, f, indent=2)
        f.write("\n")


def package_vsix(vsce_flags, env):
    run(["npm", "run", "vsce:package", "--", *vsce_flags], env=env)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def find_vsix():
    files = glob.glob("*.vsix")
    if not files:
        print("Error: no .vsix file found after packaging", file=sys.stderr)
        sys.exit(1)
    return files[0]


def build(mode, ref):
    clean()

    if ref != "HEAD":
        checkout_ref(ref)

    restore_package_files()

    env = {
        "SOURCE_DATE_EPOCH": git_log_timestamp(ref),
        "TZ": "UTC",
    }

    vsce_flags = []

    if mode == "release":
        print(f"Mode: release ({ref})")

    elif mode == "pre-release":
        print(f"Mode: pre-release ({ref})")
        vsce_flags = ["--pre-release"]

    elif mode == "nightly":
        version = bump_nightly_version(ref)
        vsce_flags = ["--pre-release"]
        print(f"Mode: nightly ({version})")

    print(f"SOURCE_DATE_EPOCH: {env['SOURCE_DATE_EPOCH']}")

    package_vsix(vsce_flags, env)

    vsix = find_vsix()
    digest = sha256_file(vsix)
    with open(f"{vsix}.sha256", "w") as f:
        f.write(f"{digest}  {vsix}\n")
    print(f"{digest}  {vsix}")

    if mode == "nightly":
        # restore package versions
        print("Built nightly, restoring package files")
        restore_package_files()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build open-remote-devcontainer")

    group = parser.add_mutually_exclusive_group()
    group.add_argument("--release", metavar="TAG", help="Release build from a tag")
    group.add_argument("--pre-release", metavar="TAG", help="Pre-release build from a tag")
    group.add_argument("--nightly", nargs="?", const="HEAD", default=None, metavar="COMMIT",
                       help="Nightly build from HEAD or a specific commit")

    args = parser.parse_args()

    if args.release:
        build("release", args.release)

    elif args.pre_release:
        build("pre-release", args.pre_release)

    elif args.nightly is not None:
        build("nightly", args.nightly)

    else:
        print(args)
        parser.print_help()
