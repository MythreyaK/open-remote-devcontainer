#!/usr/bin/env python3
"""Open VSX publishing from CI (publish.yml).

inspect: writes the release vsix's sha256, size, version and a file diff against the previous
         release to the run summary for the approver; sha256 -> job output.
publish: re-checks the vsix against inspect's sha256, then trusted publishing: GitHub OIDC ID
         token -> short-lived Open VSX token -> upload. Same requests as ovsx 1.2.0's
         `publish --trusted-publishing` (lib/oidc.js, trusted-publishing.js, registry.js).
         stdlib only: no npm code runs while the OIDC token can be requested. Pre-release comes
         from the vsix manifest (vsce --pre-release); ovsx ignores the flag for a prepackaged vsix.
"""

import os
import re
import sys
import json
import zipfile
import hashlib
import argparse
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from typing import Never

from build import parse_version, runCmd, set_github_output

REGISTRY = "https://open-vsx.org"

def fail(msg: str) -> Never:
    print(f"::error::{msg}")
    raise RuntimeError(f"::error::{msg}")

def release_key(tag: str) -> tuple[int, int, int] | None:
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        return None
    v = parse_version(tag[1:])
    return (v.major, v.minor, v.patch)

def gh(*args: str, capture: bool = True) -> str:
    return runCmd(["gh", *args, "--repo", os.environ["GITHUB_REPOSITORY"]], capture=capture)

def download_vsix(tag: str) -> str:
    d = tempfile.mkdtemp(dir=os.environ.get("RUNNER_TEMP"))
    gh("release", "download", tag, "--pattern", "*.vsix", "--dir", d, capture=False)
    files = os.listdir(d)

    if len(files) != 1:
        fail(f"Expected exactly one .vsix in release {tag}, found {len(files)}")

    return os.path.join(d, files[0])

def file_sha256(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()

def vsix_files(path: str) -> dict[str, int]:
    with zipfile.ZipFile(path) as z:
        return {i.filename: i.file_size for i in z.infolist()}

def vsix_package_json(path: str) -> dict:
    with zipfile.ZipFile(path) as z:
        return json.loads(z.read("extension/package.json"))

def name_size_diff(old: dict[str, int], new: dict[str, int]) -> list[str]:
    return ([f"- {n}" for n in sorted(old.keys() - new.keys())]
            + [f"+ {n}" for n in sorted(new.keys() - old.keys())]
            + [f"~ {n}  {old[n]} -> {new[n]}" for n in sorted(old.keys() & new.keys()) if old[n] != new[n]])

# vsix file names end up in the summary: no control chars, no backticks breaking the fences
def clean(s: str) -> str:
    return "".join(c if c.isprintable() else "?" for c in s).replace("`", "'")

# errors print the path only: the publish URL carries the token as a query parameter
def http(url: str, data: bytes | None = None, headers: dict[str, str] | None = None) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="GET" if data is None else "POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        fail(f"{urllib.parse.urlsplit(url).path}: HTTP {e.code}: {e.read().decode(errors='replace')[:2000]}")

# ── Commands ──────────────────────────────────────────────────

def cmd_inspect(args: argparse.Namespace) -> int:
    tag, ref_type = args.tag, os.environ.get("GITHUB_REF_TYPE")
    if ref_type != "tag" or release_key(tag) is None:
        fail(f"Run this from a release tag (vX.Y.Z), not {ref_type} '{tag}'")

    path = download_vsix(tag)
    version: str = vsix_package_json(path)["version"]
    if version != tag[1:]:
        fail(f"vsix package.json version '{version}' does not match tag {tag}")
    sha = file_sha256(path)
    pre_release = json.loads(gh("release", "view", tag, "--json", "isPrerelease"))["isPrerelease"]

    tags = [r["tagName"] for r in json.loads(gh("release", "list", "--exclude-drafts", "--limit", "100", "--json", "tagName"))]
    prev = max((t for t in tags if (k := release_key(t)) and k < release_key(tag)), key=release_key, default=None)
    if prev:
        diff = name_size_diff(vsix_files(download_vsix(prev)), vsix_files(path)) or ["(same files and sizes)"]
    else:
        diff = ["(no previous release)"]

    summary = [
        f"## Open VSX publish: {tag}",
        "",
        "Compare with local builds before approving:",
        "",
        "| | |",
        "|---|---|",
        f"| sha256 | `{sha}` |",
        f"| size | {os.path.getsize(path)} bytes |",
        f"| file | `{clean(os.path.basename(path))}` |",
        f"| version | {clean(version)} |",
        f"| pre-release | {str(pre_release).lower()} |",
        f"| commit | `{os.environ['GITHUB_SHA']}` |",
        "",
        f"### Files vs {prev or 'previous release'} (full list: build-package, vsce package log)",
        "```", *map(clean, diff), "```",
    ]

    with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
        f.write("\n".join(summary) + "\n")

    set_github_output("sha256", sha)
    return 0

def cmd_publish(args: argparse.Namespace) -> int:
    # must be the exact file shown in inspect's summary
    path = download_vsix(args.tag)
    got = file_sha256(path)

    if got != args.sha256:
        fail(f"vsix changed since inspect: {got} != {args.sha256}")

    print(f"{path}: OK {got}")

    pkg = vsix_package_json(path)
    namespace, extension = pkg["publisher"], pkg["name"]

    # 1. GitHub OIDC ID token, audience = registry (the request URL already has a query)
    u = urllib.parse.urlsplit(os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"])
    q = urllib.parse.urlencode(urllib.parse.parse_qsl(u.query) + [("audience", REGISTRY)])

    id_token = http(u._replace(query=q).geturl(), headers={
        "Authorization": f"Bearer {os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']}",
        "Accept": "application/json"}
    ).get("value")

    if not id_token:
        fail("GitHub Actions did not return an OIDC ID token")

    print(f"::add-mask::{id_token}")

    # 2. exchange it for a short-lived token that can publish this one extension
    r = http(f"{REGISTRY}/api/-/trusted-publishing/token",
             json.dumps({"namespace": namespace, "extension": extension, "token": id_token}).encode(),
             {"Content-Type": "application/json"})

    if r.get("error") or not r.get("value"):
        fail(f"token exchange for {namespace}.{extension}: {r.get('error') or 'no token returned'}; "
             f"check {REGISTRY}/user-settings/trusted-publishers")

    print(f"::add-mask::{r['value']}")
    print(f"Trusted publishing token issued for {namespace}.{extension}, expires {r.get('expiresTimestamp')}")

    # 3. publish
    with open(path, "rb") as f:
        ext = http(f"{REGISTRY}/api/-/publish?" + urllib.parse.urlencode({"token": r["value"]}),
                   f.read(), {"Content-Type": "application/octet-stream"})

    if ext.get("error"):
        fail(ext["error"])

    print(f"Published {ext.get('namespace')}.{ext.get('name')} v{ext.get('version')} ({ext.get('targetPlatform')})")

    if ext.get("warning"):
        print(f"::warning::{ext['warning']}")

    return 0

def cmd_test(_args: argparse.Namespace | None = None) -> int:
    assert release_key("v0.10.2") == (0, 10, 2)
    assert release_key("v0.7.1-beta.1") is None
    assert release_key("dev") is None
    assert release_key("v0.10.0") > release_key("v0.9.9")

    assert name_size_diff({"a": 1, "b": 2, "c": 3}, {"b": 2, "c": 4, "d": 5}) == ["- a", "+ d", "~ c  3 -> 4"]
    assert name_size_diff({"a": 1}, {"a": 1}) == []

    assert clean("we`ird\x07name") == "we'ird?name"
    print("All tests passed")
    return 0

# ── CLI ───────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Open VSX publishing from CI")
    sub = parser.add_subparsers(dest="command", required=True)

    insp = sub.add_parser("inspect", help="Summarize the release vsix for the approver")
    insp.add_argument("--tag", required=True, type=str, help="Release tag (e.g., v0.8.0)")

    pub = sub.add_parser("publish", help="Verify the release vsix and publish it (trusted publishing)")
    pub.add_argument("--tag", required=True, type=str, help="Release tag (e.g., v0.8.0)")
    pub.add_argument("--sha256", required=True, type=str, help="sha256 from inspect")

    sub.add_parser("test", help="Run self-tests")

    args = parser.parse_args()
    dispatch = {
        "inspect": cmd_inspect,
        "publish": cmd_publish,
        "test": cmd_test
    }

    sys.exit(dispatch[args.command](args))
