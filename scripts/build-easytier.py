"""Build the opt-in Windows UDP underlay, without Npcap/Packet.dll.

Run from any directory: python scripts/build-easytier.py
Pinned source + the patches below are the component's source recipe.
This builds the auxiliary component only; it does not build PastePanda's installer.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache/easytier-product-build"
SOURCE_URL = "https://codeload.github.com/EasyTier/EasyTier/zip/refs/tags/v2.6.4"
SOURCE_SHA = "b08ecc378b7ad679b3f4188fa5b9f6417670b5e3c1e5f53b2f19d06c021814cb"
PROTOC_URL = "https://github.com/protocolbuffers/protobuf/releases/download/v26.0-rc1/protoc-26.0-rc-1-win64.zip"
PROTOC_SHA = "61d80fdd57b9ea1072625085cbad085dd00310652ea494b8e38c6b76c9ee0516"
PNET_SHA = "e79e70ec0be163102a332e1d2d5586d362ad76b01cec86f830241f2b6452a7b7"


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def archive(url, sha, path, destination):
    if not path.exists():
        with urllib.request.urlopen(url, timeout=90) as response, path.open("wb") as output:
            shutil.copyfileobj(response, output)
    if digest(path) != sha:
        raise RuntimeError(f"Archive hash mismatch: {path}")
    # Reject paths escaping the dedicated extraction directory before writing files.
    with zipfile.ZipFile(path) as source:
        for name in source.namelist():
            (destination / name).resolve().relative_to(destination.resolve())
        source.extractall(destination)


def patch_manifests(source):
    path = source / "Cargo.toml"
    value = path.read_text(encoding="utf-8")
    value, count = re.subn(r"(?m)^members\s*=\s*\[[\s\S]*?\]", 'members = ["easytier", "easytier-rpc-build"]', value, count=1)
    if count != 1:
        raise RuntimeError("Pinned workspace members not found")
    value, count = re.subn(r"(?m)^default-members\s*=\s*\[[\s\S]*?\]", 'default-members = ["easytier"]', value, count=1)
    if count != 1:
        raise RuntimeError("Pinned default members not found")
    value += '\n[profile.underlay-prototype]\ninherits = "release"\nlto = false\ncodegen-units = 16\n'
    path.write_text(value, encoding="utf-8")
    path = source / "easytier/build.rs"
    value = path.read_text(encoding="utf-8")
    if "thunk::thunk();" not in value:
        raise RuntimeError("Pinned Windows compatibility hook not found")
    # PastePanda targets Windows 10+, so the legacy OS compatibility thunk is unused.
    path.write_text(value.replace("thunk::thunk();", "// PastePanda prototype: Windows 10+; no legacy compatibility thunk."), encoding="utf-8")
    path = source / "easytier/src/common/constants.rs"
    value, count = re.subn(r'pub const EASYTIER_VERSION: &str = git_version::git_version!\([\s\S]*?\);',
                          'pub const EASYTIER_VERSION: &str = "2.6.4-pp-underlay";',
                          path.read_text(encoding="utf-8"), count=1)
    if count != 1:
        raise RuntimeError("Pinned version constant not found")
    # An extracted archive must not accidentally report the containing app's Git ID.
    path.write_text(value, encoding="utf-8")
    patch_capture_backend(source)
    patch_punch_pacing(source)


def patch_punch_pacing(source):
    folder = source / "easytier/src/connector/udp_hole_punch"
    path = folder / "common.rs"
    value = path.read_text(encoding="utf-8")
    edits = [
        ("    let mut sent_packets = 0;", "    #[cfg(windows)]\n    let mut pace = super::windows_pace::WindowsPunchPace::new();\n    let mut sent_packets = 0;"),
        ("    while sent_packets < max_packets {", "    while sent_packets < max_packets {\n        #[cfg(windows)]\n        pace.tick().await;"),
        ("        tokio::time::sleep(Duration::from_millis(1)).await;", "        #[cfg(not(windows))]\n        tokio::time::sleep(Duration::from_millis(1)).await;"),
    ]
    if any(value.count(old) != 1 for old, _ in edits) or "windows_pace" in value:
        raise RuntimeError("Pinned Windows punch pacing not found")
    for old, new in edits:
        value = value.replace(old, new)
    module = folder / "mod.rs"
    modules = module.read_text(encoding="utf-8")
    if modules.count("pub(crate) mod common;") != 1 or "mod windows_pace;" in modules:
        raise RuntimeError("Pinned Windows punch pacing module not found")
    path.write_text(value, encoding="utf-8")
    module.write_text(modules.replace("pub(crate) mod common;", "#[cfg(windows)]\nmod windows_pace;\npub(crate) mod common;"), encoding="utf-8")
    shutil.copyfile(ROOT / "scripts/easytier/windows_punch_pace.rs", folder / "windows_pace.rs")


def patch_capture_backend(source):
    path = CACHE / "pnet_datalink-0.35.0.crate"
    if not path.exists():
        urllib.request.urlretrieve("https://static.crates.io/crates/pnet_datalink/pnet_datalink-0.35.0.crate", path)
    if digest(path) != PNET_SHA:
        raise RuntimeError("pnet_datalink source hash mismatch")
    vendor = source / "vendor"
    vendor.mkdir(exist_ok=True)
    with tarfile.open(path) as package:
        package.extractall(vendor, filter="data")
    crate = vendor / "pnet_datalink-0.35.0"
    path = crate / "src/lib.rs"
    value = path.read_text(encoding="utf-8")
    old = '#[cfg(windows)]\n#[path = "winpcap.rs"]\nmod backend;\n\n#[cfg(windows)]\npub mod winpcap;'
    if old not in value:
        raise RuntimeError("Pinned capture backend not found")
    # This UDP-only build deliberately rejects capture instead of loading a driver.
    # EasyTier already uses network-interface for Windows address enumeration.
    value = value.replace(old, '''#[cfg(windows)]
mod backend {
    use super::{Channel, NetworkInterface};
    use std::io;
    pub type Config = super::Config;
    impl From<&Config> for Config { fn from(value: &Config) -> Self { *value } }
    pub fn channel(_: &NetworkInterface, _: Config) -> io::Result<Channel> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "Capture disabled in UDP underlay"))
    }
    pub fn interfaces() -> Vec<NetworkInterface> { Vec::new() }
}''')
    path.write_text(value, encoding="utf-8")
    path = crate / "src/bindings/mod.rs"
    value = path.read_text(encoding="utf-8")
    path.write_text(value.replace('#[cfg(windows)]\npub mod winpcap;', '// Windows packet capture is not compiled in the UDP underlay.'), encoding="utf-8")
    path = source / "Cargo.toml"
    with path.open("a", encoding="utf-8") as output:
        output.write('\n[patch.crates-io]\npnet_datalink = { path = "vendor/pnet_datalink-0.35.0" }\n')


def main():
    if os.name != "nt":
        raise RuntimeError("This recipe targets Windows x86_64")
    CACHE.mkdir(parents=True, exist_ok=True)
    archive(SOURCE_URL, SOURCE_SHA, CACHE / "easytier-source-v2.6.4.zip", CACHE)
    archive(PROTOC_URL, PROTOC_SHA, CACHE / "protoc-26.0-rc-1-win64.zip", CACHE / "protoc")
    source = CACHE / "EasyTier-2.6.4"
    patch_manifests(source)
    env = os.environ.copy()
    env.update({
        "LIBCLANG_PATH": str(ROOT / "src-tauri/.libclang"),
        "PROTOC": str(CACHE / "protoc/bin/protoc.exe"),
        "CARGO_TARGET_DIR": str(CACHE / "target"),
        "CARGO_BUILD_JOBS": "4",
        "CARGO_NET_GIT_FETCH_WITH_CLI": "true",
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "url.git@github.com:.insteadOf",
        "GIT_CONFIG_VALUE_0": "https://github.com/",
    })
    subprocess.run(["cargo", "build", "--manifest-path", str(source / "Cargo.toml"),
                    "--package", "easytier", "--bin", "easytier-core", "--bin", "easytier-cli",
                    "--no-default-features", "--features", "wireguard,smoltcp,socks5,websocket",
                    "--profile", "underlay-prototype"], env=env, check=True)
    assets = CACHE / "target/underlay-prototype"
    # Running from the isolated build folder verifies no sibling Packet.dll is needed.
    versions = {}
    for name in ["easytier-core.exe", "easytier-cli.exe"]:
        result = subprocess.run([str(assets / name), "--version"], cwd=assets,
                                capture_output=True, text=True, timeout=15, check=True)
        versions[name] = result.stdout.strip()
    output = ROOT / "src-tauri/resources/easytier/windows-x86_64"
    output.mkdir(parents=True, exist_ok=True)
    for name in versions:
        shutil.copy2(assets / name, output / name)
    provenance = {"source": SOURCE_URL, "source_sha256": SOURCE_SHA,
                  "features": ["wireguard", "smoltcp", "socks5", "websocket"], "default_features": False,
                  "recipe": "scripts/build-easytier.py", "versions": versions,
                  "windows_punch_pace_sha256": digest(ROOT / "scripts/easytier/windows_punch_pace.rs"),
                  "pnet_datalink_source_sha256": PNET_SHA,
                  "sha256": {name: digest(output / name) for name in versions}}
    (output / "build.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(provenance, indent=2))


if __name__ == "__main__":
    main()
