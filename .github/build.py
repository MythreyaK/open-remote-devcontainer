#!/usr/bin/env python3
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass

# ── Data ──────────────────────────────────────────────────────

@dataclass
class Version:
    major: int
    minor: int
    patch: int
    pre: str | None = None

    @property
    def is_release(self) -> bool:
        return self.minor % 2 == 0

    @property
    def is_prerelease(self) -> bool:
        return not self.is_release

    def base(self) -> str:
        return f"{self.major}.{self.minor}.{self.patch}"

    def __str__(self) -> str:
        s = self.base()
        return f"{s}-{self.pre}" if self.pre else s

# ── Pure functions ────────────────────────────────────────────

def parse_version(s: str) -> Version:
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$", s)
    if not m:
        raise ValueError(f"Invalid version: {s!r}")
    return Version(int(m[1]), int(m[2]), int(m[3]), m[4])

def bump_patch(v: Version) -> Version:
    return Version(v.major, v.minor, v.patch + 1)

def sanitize_label(ref: str) -> str:
    return re.sub(r"[^0-9A-Za-z-]", "-", ref)

def format_dev_version(v: Version, label: str, sha: str, run: int = 1) -> str:
    bumped = bump_patch(v)
    return f"{bumped.base()}-{label}.{run}.{sha}"

def validate_tag(tag: str, pkg_ver: str, pkg_lock_ver: str) -> None:
    expected = tag.removeprefix("v")

    errors: list[str] = []
    if pkg_ver != expected:
        errors.append(f'package.json version "{pkg_ver}" does not match tag "{tag}"')
    if pkg_lock_ver != expected:
        errors.append(f'package-lock.json version "{pkg_lock_ver}" does not match tag "{tag}"')
    if errors:
        for e in errors:
            print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    print(f"Version OK: {expected}")

# ── Shell / git helpers ───────────────────────────────────────

def runCmd(cmd: list[str], *, env: dict[str, str] | None = None, capture: bool = False) -> str:
    merged = {**os.environ, **(env or {})}
    result = subprocess.run(
        cmd, capture_output=capture, text=True, env=merged,
    )
    if result.returncode != 0:
        if capture:
            print(f"stdout:\n [{result.stdout.strip()}]", file=sys.stderr)
            print(f"stderr:\n [{result.stderr.strip()}]", file=sys.stderr)
        raise RuntimeError(f"Command [{', '.join(cmd)}] exit {result.returncode}")
    else:
        if capture:
            print(f"[{', '.join(cmd)}]: {result.stdout.strip()}")
        return result.stdout.strip() if capture else ""

def git_short_sha(ref: str = "HEAD") -> str:
    return runCmd(["git", "rev-parse", "--short=7", ref], capture=True)

def git_log_timestamp(ref: str) -> str:
    return runCmd(["git", "log", "-1", "--format=%ct", ref], capture=True)

def git_branch_name() -> str:
    return runCmd(["git", "rev-parse", "--abbrev-ref", "HEAD"], capture=True)

def set_github_output(key: str, value: str) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as f:
            f.write(f"{key}={value}\n")
    print(f"    GITHUB_OUTPUT += {key}={value}")

# ── Build steps ───────────────────────────────────────────────

def get_package_ver() -> str:
    with open("package.json") as f:
        return json.load(f)["version"]

def set_package_ver(version: str) -> None:
    runCmd(["npm", "version", version, "--no-git-tag-version"])
    # with open("package.json") as f:
    #     pkg = json.load(f)
    # with open("package.json", "w") as f:
    #     json.dump(pkg, f, indent=2)
    #     f.write("\n")

def build_prod(env: dict[str, str] | None = None) -> None:
    runCmd(["npm", "run", "build:prod"], env=env)

def package_vsix(flags: list[str], env: dict[str, str]) -> str:
    runCmd(["npm", "run", "vsce", "--", *flags], env=env)
    return find_vsix()

def find_vsix() -> str:
    files = glob.glob("*.vsix")
    if not files:
        print("Error: no .vsix file found after packaging", file=sys.stderr)
        sys.exit(1)
    return files[0]

def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    digest = h.hexdigest()
    sha_path = f"{path}.sha256"
    with open(sha_path, "w") as f:
        f.write(f"{digest}  {path}\n")
    print(f"{digest}  {path}")
    return sha_path

def clean_artifacts() -> None:
    for pattern in ("*.vsix", "*.vsix.sha256"):
        for f in glob.glob(pattern):
            os.remove(f)

# ── Pre-steps ────────────────────────────────────────────────

def run_pre_steps(args: argparse.Namespace) -> None:
    if args.with_checkout:
        ref = getattr(args, "tag", None) or getattr(args, "branch", None)
        if not ref:
            print("Error: --with-checkout requires --tag or --branch", file=sys.stderr)
            sys.exit(1)
        status = runCmd(["git", "status", "--porcelain", "-uno"], capture=True)
        if status:
            print("Error: workspace is not clean:", file=sys.stderr)
            print(status, file=sys.stderr)
            sys.exit(1)
        runCmd(["git", "checkout", ref])

    if args.with_npm:
        runCmd(["npm", "ci"])
        runCmd(["npm", "run", "dts"])

# ── Shared build logic ───────────────────────────────────────

def _build_dev(label: str, sha: str, run_num: int = 1, epoch_ref: str = "HEAD") -> None:
    clean_artifacts()

    version = parse_version(get_package_ver())
    dev_version = format_dev_version(version, label, sha, run_num)
    print(f"Version: {dev_version}")

    set_package_ver(dev_version)

    epoch = git_log_timestamp(epoch_ref)
    build_env = {"SOURCE_DATE_EPOCH": epoch, "TZ": "UTC"}
    print(f"SOURCE_DATE_EPOCH: {epoch}")

    build_prod(build_env)
    vsix = package_vsix(["--pre-release"], build_env)
    sha_path = sha256_file(vsix)

    set_github_output("version", dev_version)
    set_github_output("vsix_file", vsix)
    set_github_output("vsix_sha256", sha_path)
    set_github_output("pre_release", "true")

# ── Entry points ──────────────────────────────────────────────

def cmd_ci(args: argparse.Namespace) -> None:
    run_pre_steps(args)
    if args.pr is not None:
        label = f"pr{args.pr}"
        ref = args.sha or "HEAD"
        sha = git_short_sha(ref)
    else:
        label = sanitize_label(args.branch)
        ref = "HEAD"
        sha = git_short_sha("HEAD")

    _build_dev(label, sha, args.run, epoch_ref=ref)

def validate_versions(args: argparse.Namespace) -> None:
    with open("package.json") as f:
        pkg_ver = json.load(f)["version"]
    with open("package-lock.json") as f:
        pkg_lock_ver = json.load(f)["version"]

    validate_tag(args.tag, pkg_ver, pkg_lock_ver)

def cmd_release(args: argparse.Namespace) -> None:
    run_pre_steps(args)
    validate_versions(args)

    clean_artifacts()

    version = parse_version(get_package_ver())

    epoch = git_log_timestamp(args.tag)
    build_env = {"SOURCE_DATE_EPOCH": epoch, "TZ": "UTC"}
    print(f"SOURCE_DATE_EPOCH: {epoch}")

    flags: list[str] = []
    if version.is_prerelease:
        flags = ["--pre-release"]
        print(f"Mode: pre-release ({version})")
    else:
        print(f"Mode: release ({version})")

    build_prod(build_env)
    vsix = package_vsix(flags, build_env)
    sha_path = sha256_file(vsix)

    set_github_output("version", str(version))
    set_github_output("vsix_file", vsix)
    set_github_output("vsix_sha256", sha_path)
    set_github_output("pre_release", "true" if version.is_prerelease else "false")

def cmd_local(args: argparse.Namespace) -> None:
    run_pre_steps(args)
    branch = git_branch_name()
    if branch == "HEAD":
        print("Error: detached HEAD — check out a branch first", file=sys.stderr)
        sys.exit(1)

    _build_dev(sanitize_label(branch), git_short_sha("HEAD"))

def cmd_test(_args: argparse.Namespace | None = None) -> None:
    # parse_version
    assert parse_version("0.7.0") == Version(0, 7, 0)
    assert parse_version("0.7.1-beta.1") == Version(0, 7, 1, "beta.1")
    assert parse_version("1.2.10") == Version(1, 2, 10)
    try:
        parse_version("not-a-version")
        assert False, "should have raised"
    except ValueError:
        pass

    # bump_patch (drops prerelease)
    assert bump_patch(Version(0, 7, 0)) == Version(0, 7, 1)
    assert bump_patch(Version(0, 7, 1, "beta.1")) == Version(0, 7, 2)
    assert bump_patch(Version(1, 2, 10)) == Version(1, 2, 11)
    assert bump_patch(Version(0, 8, 5)) == Version(0, 8, 6)

    # sanitize_label
    assert sanitize_label("main") == "main"
    assert sanitize_label("fix/auth") == "fix-auth"
    assert sanitize_label("fix.auth") == "fix-auth"
    assert sanitize_label("feat/foo.bar") == "feat-foo-bar"

    # format_dev_version (patch+1, run in prerelease)
    assert (
        format_dev_version(Version(0, 7, 0), "pr42", "a1b2c3d", 5)
        == "0.7.1-pr42.5.a1b2c3d"
    )
    assert (
        format_dev_version(Version(0, 7, 0), "dev", "a1b2c3d", 12)
        == "0.7.1-dev.12.a1b2c3d"
    )
    assert (
        format_dev_version(Version(0, 8, 0), "main", "f1e2d3c")
        == "0.8.1-main.1.f1e2d3c"
    )

    # is_prerelease (odd minor = pre)
    assert Version(0, 7, 0).is_prerelease is True
    assert Version(0, 8, 0).is_prerelease is False
    assert Version(0, 9, 0).is_prerelease is True
    assert Version(1, 0, 0).is_prerelease is False

    # validate_tag
    validate_tag("v0.7.0", "0.7.0", "0.7.0")
    try:
        validate_tag("v0.7.0", "0.8.0", "0.7.0")
        assert False, "should have raised"
    except SystemExit:
        pass

    # Version.__str__
    assert str(Version(0, 7, 0)) == "0.7.0"
    assert str(Version(0, 7, 1, "beta.1")) == "0.7.1-beta.1"
    assert Version(0, 7, 0).base() == "0.7.0"

    print("All tests passed")

# ── CLI ───────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build open-remote-devcontainer")
    parser.add_argument("--with-checkout", action="store_true", help="Checkout the ref from --tag or --branch (ensures clean workspace first)")
    parser.add_argument("--with-npm", action="store_true", help="Run npm ci && npm run dts")
    sub = parser.add_subparsers(dest="command", required=True)

    ci = sub.add_parser("ci", help="CI build (PR or branch)")
    ci_group = ci.add_mutually_exclusive_group(required=True)
    ci_group.add_argument("--pr", type=int, help="PR number")
    ci_group.add_argument("--branch", type=str, help="Branch name")
    ci.add_argument("--sha", type=str, help="PR head SHA (for provenance)")
    ci.add_argument("--run", type=int, required=True, help="Run number")

    release = sub.add_parser("release", help="Tagged release build")
    release.add_argument("--tag", required=True, type=str, help="Tag name (e.g., v0.8.0)")

    sub.add_parser("local", help="Local dev build (current branch)")

    sub.add_parser("test", help="Run self-tests")

    ver = sub.add_parser("version-check", help="Check tag, package.json, and package-lock.json versions match")
    ver.add_argument("--tag", required=True, type=str, help="Tag name (e.g., v0.8.0)")

    args = parser.parse_args()

    commands = {
        "ci": cmd_ci,
        "release": cmd_release,
        "local": cmd_local,
        "test": cmd_test,
        "version-check": validate_versions,
    }

    commands[args.command](args)
