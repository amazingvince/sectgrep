"""Ensure packaging preserves the exact historical measurement evidence."""
import gzip
import hashlib
import json
from pathlib import Path
import unittest


RESULTS = Path(__file__).parent / "results"


class ReportArchiveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        manifest = json.loads((RESULTS / "archives.json").read_text(encoding="utf8"))
        cls.records = manifest["reports"]

    def test_all_archives_preserve_original_bytes(self):
        self.assertTrue(self.records)
        self.assertEqual(len({r["report"] for r in self.records}), len(self.records))
        self.assertEqual(
            {r["archive"] for r in self.records},
            {p.name for p in RESULTS.glob("*.json.gz")},
        )
        for record in self.records:
            with self.subTest(report=record["report"]):
                self.assertEqual(record["archive"], record["report"] + ".gz")
                archive = (RESULTS / record["archive"]).read_bytes()
                self.assertEqual(len(archive), record["archive_bytes"])
                self.assertEqual(hashlib.sha256(archive).hexdigest(), record["archive_sha256"])
                original = gzip.decompress(archive)
                self.assertEqual(len(original), record["original_bytes"])
                self.assertEqual(hashlib.sha256(original).hexdigest(), record["original_sha256"])
                self.assertIsInstance(json.loads(original), dict)

    def test_final_parity_bindings_still_resolve(self):
        parity = json.loads(
            (RESULTS / "needle-scale-final-parity-2026-09-05.json").read_text(encoding="utf8")
        )
        records = {r["report"]: r for r in self.records}
        reports = []
        for report, expected in parity["inputs"].items():
            original = gzip.decompress((RESULTS / records[report]["archive"]).read_bytes())
            self.assertEqual(hashlib.sha256(original).hexdigest(), expected, report)
            reports.append(json.loads(original))
        baseline = [row["result"] for row in reports[0]["rows"]]
        self.assertEqual(len(baseline), 12)
        for report in reports[1:]:
            self.assertEqual([row["result"] for row in report["rows"]], baseline)


if __name__ == "__main__":
    unittest.main()
