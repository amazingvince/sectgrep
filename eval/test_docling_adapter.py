import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("docling_adapter", Path(__file__).parent / "adapters/docling_adapter.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class CoverageTests(unittest.TestCase):
    def test_only_successful_full_page_processing_is_complete(self):
        self.assertEqual(adapter.coverage("success", None, 3, [1, 2, 3]), "complete")
        for status, requested, total, actual in [
            ("partial_success", None, 3, [1, 2, 3]),
            ("failure", None, 3, []),
            ("success", (1, 2), 3, [1, 2]),
            ("success", None, 3, [1, 3]),
            ("success", None, 3, [1, 1, 3]),
            ("success", None, 0, []),
        ]:
            with self.subTest(status=status, requested=requested, actual=actual):
                self.assertEqual(adapter.coverage(status, requested, total, actual), "partial")


if __name__ == "__main__":
    unittest.main()
