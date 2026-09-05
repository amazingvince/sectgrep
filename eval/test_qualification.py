import unittest
from qualification import validate_tasks, score, prerequisites, report, verify_freeze, digest
import tempfile
import json
from pathlib import Path


class QualificationTests(unittest.TestCase):
    def test_heldout_requires_unchanged_recipe_bindings(self):
        with self.assertRaisesRegex(ValueError, "requires"):
            verify_freeze(None)
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "recipe.txt"
            source.write_text("frozen", encoding="utf-8")
            frozen = Path(root) / "freeze.json"
            frozen.write_text(json.dumps(dict(tuning_sha256="checked", topic_review_sha256="checked", recipe_bindings={str(source): digest(source)})), encoding="utf-8")
            self.assertEqual(verify_freeze(frozen), digest(frozen))
            source.write_text("changed", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "changed"):
                verify_freeze(frozen)

    def setUp(self):
        self.task = dict(id="one", split="smoke", domain="lending", kind="locate", query="income", relevant=["D:a@2026-01-01"], supporting=["D:b@2026-01-01"], no_answer=False)

    def test_primary_and_required_context_have_separate_recall(self):
        result = dict(hits=[dict(expr="D:a@2026-01-01")], supporting_context=[dict(expr="D:b@2026-01-01", body="exception")])
        self.assertEqual(score(self.task, result)["support_recall"], 1)
        self.assertEqual(score(self.task, result)["recall_at_5"], 1)
        result["hits"][0]["expr"] = "D:a@2025-01-01"
        self.assertEqual(score(self.task, result)["recall_at_5"], 0)

    def test_split_leakage_rejected(self):
        second = {**self.task, "id": "two", "split": "heldout", "query": " INCOME "}
        with self.assertRaisesRegex(ValueError, "leakage"):
            validate_tasks([self.task, second])

    def test_no_answer_must_have_no_gold(self):
        with self.assertRaisesRegex(ValueError, "no-answer"):
            validate_tasks([{**self.task, "no_answer": True}])

    def test_missing_labels_and_measurements_cannot_pass(self):
        self.assertGreater(len(prerequisites([self.task], {})), 10)
        self.assertFalse(report([self.task], [], {})["qualified"])

    def test_work_ids_cannot_hide_wrong_revision(self):
        with self.assertRaisesRegex(ValueError, "revision"):
            validate_tasks([{**self.task, "relevant": ["D:a"]}])

    def test_no_answer_scores_abstention_not_empty_hit_list(self):
        task = {**self.task, "no_answer": True, "relevant": [], "supporting": []}
        self.assertEqual(score(task, {"hits": [], "abstained": False})["no_answer_correct"], 0)
        self.assertEqual(score(task, {"hits": [{"expr": "D:a@2026-01-01"}], "abstained": True})["no_answer_correct"], 1)

    def test_timing_only_tasks_cannot_supply_quality_labels(self):
        task = {**self.task, "timing_only": True, "relevant": [], "supporting": []}
        validate_tasks([task])
        self.assertIsNone(score(task, {"hits": []})["recall_at_5"])
        with self.assertRaisesRegex(ValueError, "timing-only"):
            validate_tasks([{**task, "split": "heldout"}])


if __name__ == "__main__":
    unittest.main()
