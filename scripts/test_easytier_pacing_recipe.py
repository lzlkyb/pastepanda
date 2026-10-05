"""The pinned patch changes Windows pacing only and fails closed on source drift."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("underlay_build", ROOT / "scripts/build-easytier.py")
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)

COMMON = """before
    let mut sent_packets = 0;
    let mut cur_port_idx = port_start_idx;
    while sent_packets < max_packets {
        let port = ports[cur_port_idx % ports.len()];
        cur_port_idx = cur_port_idx.wrapping_add(1);
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
after
"""

class PacingRecipeTests(unittest.TestCase):
    def fixture(self, folder, common=COMMON):
        source = Path(folder)
        path = source / "easytier/src/connector/udp_hole_punch"
        path.mkdir(parents=True)
        (path / "mod.rs").write_text("pub(crate) mod common;\n", encoding="utf-8")
        (path / "common.rs").write_text(common, encoding="utf-8")
        return source, path

    def test_windows_pace_keeps_non_windows_sleep_and_packet_loop(self):
        with tempfile.TemporaryDirectory() as folder:
            source, path = self.fixture(folder)
            recipe.patch_punch_pacing(source)
            patched = (path / "common.rs").read_text(encoding="utf-8")
            self.assertIn('#[cfg(not(windows))]\n        tokio::time::sleep(Duration::from_millis(1)).await;', patched)
            restored = patched.replace('    #[cfg(windows)]\n    let mut pace = super::windows_pace::WindowsPunchPace::new();\n', '')
            restored = restored.replace('        #[cfg(windows)]\n        pace.tick().await;\n', '')
            restored = restored.replace('        #[cfg(not(windows))]\n', '')
            self.assertEqual(restored, COMMON)
            self.assertEqual((path / "windows_pace.rs").read_bytes(),
                             (ROOT / "scripts/easytier/windows_punch_pace.rs").read_bytes())

    def test_changed_upstream_pacing_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            source, _ = self.fixture(folder, COMMON.replace('from_millis(1)', 'from_millis(2)'))
            with self.assertRaisesRegex(RuntimeError, "Pinned.*pacing"):
                recipe.patch_punch_pacing(source)

if __name__ == "__main__":
    unittest.main()
