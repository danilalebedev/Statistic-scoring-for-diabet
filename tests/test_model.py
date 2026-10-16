"""Independent numerical checks of the calculator's published model contract.

Expected values below come from compound-distribution identities rather than
from the calculator's internal probability helpers.  Counts in these tests are
synthetic; none are estimates for Moscow.
"""

from copy import deepcopy
import math
import unittest

from calculator.model import default_config, forecast


GROUP_IDS = (
    "t1_lt5", "t1_5_9", "t1_10_19", "t1_ge20",
    "t2_lt5", "t2_5_9", "t2_10_19", "t2_ge20",
)
INTERVENTION_IDS = ("prp", "dme", "vit")


def make_payload():
    config = default_config()
    payload = deepcopy(config["defaults"])
    payload["profile"] = "expert_annual"
    payload["risks_per_1000"] = deepcopy(config["profiles"][0]["risks_per_1000"])
    payload["uncertainty_cv"] = dict.fromkeys(INTERVENTION_IDS, 0.5)
    payload["include_comparison"] = False
    payload["iterations"] = 2000
    payload["seed"] = 314159
    return payload


def by_id(result):
    return {item["id"]: item for item in result["interventions"]}


def set_all_risks(payload, per_1000):
    for group in GROUP_IDS:
        for intervention in INTERVENTION_IDS:
            payload["risks_per_1000"][group][intervention] = per_1000


def set_all_uncertainties(payload, cv):
    payload["uncertainty_cv"] = dict.fromkeys(INTERVENTION_IDS, cv)


class ProbabilityModelTests(unittest.TestCase):
    def assertAlmostExact(self, actual, expected):
        self.assertTrue(math.isfinite(actual), repr(actual))
        self.assertAlmostEqual(actual, expected, delta=1e-8)

    def assertZeroSummary(self, summary):
        for field in ("mean", "variance", "sd", "simulation_mean", "simulation_variance"):
            self.assertEqual(summary[field], 0, field)
        self.assertEqual(summary["interval"]["lower"], 0)
        self.assertEqual(summary["interval"]["upper"], 0)
        self.assertEqual(summary["upper_quantile"], 0)
        self.assertEqual(summary["zero_probability"], 1)

    def test_zero_population_has_no_patients_or_procedures(self):
        payload = make_payload()
        payload["populations"] = dict.fromkeys(GROUP_IDS, 0)
        for item in forecast(payload)["interventions"]:
            self.assertZeroSummary(item["patients"])
            self.assertZeroSummary(item["procedures"])
            for group in item["groups"]:
                self.assertZeroSummary(group["patients"])
                self.assertZeroSummary(group["procedures"])

    def test_zero_risk_has_no_patients_or_procedures(self):
        payload = make_payload()
        set_all_risks(payload, 0)
        for item in forecast(payload)["interventions"]:
            self.assertZeroSummary(item["patients"])
            self.assertZeroSummary(item["procedures"])

    def test_zero_capture_has_no_hospital_load(self):
        payload = make_payload()
        payload["capture"] = dict.fromkeys(INTERVENTION_IDS, 0)
        for item in forecast(payload)["interventions"]:
            self.assertZeroSummary(item["patients"])
            self.assertZeroSummary(item["procedures"])

    def test_partial_capture_thins_patients_before_procedure_counts(self):
        payload = make_payload()
        set_all_uncertainties(payload, 0)
        set_all_risks(payload, 100)
        payload["populations"] = dict.fromkeys(GROUP_IDS, 100)
        payload["capture"] = dict.fromkeys(INTERVENTION_IDS, 0.25)
        result = by_id(forecast(payload))
        # Independent capture of 25% of indicated patients changes p=.1 to
        # q=.025, without changing the positive procedure-count distribution.
        expected_patients = 800 * 0.025
        expected_patient_variance = 800 * 0.025 * 0.975
        expected_vit_mean = expected_patients * 1.05
        expected_vit_variance = (
            expected_patients * 0.0475
            + expected_patient_variance * 1.05**2
        )
        for item in result.values():
            self.assertAlmostExact(item["patients"]["mean"], expected_patients)
            self.assertAlmostExact(item["patients"]["variance"], expected_patient_variance)
        self.assertAlmostExact(result["vit"]["procedures"]["mean"], expected_vit_mean)
        self.assertAlmostExact(result["vit"]["procedures"]["variance"], expected_vit_variance)

    def test_fixed_rates_match_independent_compound_moment_fixtures(self):
        payload = make_payload()
        payload["populations"] = dict.fromkeys(GROUP_IDS, 1000)
        set_all_uncertainties(payload, 0)
        # Original eight-group annual rates. Independent compound moments:
        # E U=sum(N_g p_g), Var U=sum(N_g p_g(1-p_g)),
        # E W=E U * E K, Var W=E U * Var K + Var U * (E K)^2.
        fixtures = {
            "prp": (69.5, 68.40975, 168.19, 559.1018099),
            "dme": (127, 123.845, 594.36, 4216.385928),
            "vit": (3.6, 3.596965, 3.78, 4.1366539125),
        }
        result = by_id(forecast(payload))
        for name, (patient_mean, patient_var, procedure_mean, procedure_var) in fixtures.items():
            with self.subTest(intervention=name):
                self.assertAlmostExact(result[name]["patients"]["mean"], patient_mean)
                self.assertAlmostExact(result[name]["patients"]["variance"], patient_var)
                self.assertAlmostExact(result[name]["procedures"]["mean"], procedure_mean)
                self.assertAlmostExact(result[name]["procedures"]["variance"], procedure_var)

    def test_one_procedure_per_patient_makes_load_equal_patient_count(self):
        payload = make_payload()
        payload["procedures"]["prp"] = {"mean": 1, "sd": 0}
        payload["procedures"]["dme"] = {
            "mean": 1, "sd": 0, "bilateral_probability": 0,
        }
        payload["procedures"]["vit"] = {"repeat_probability": 0}
        for item in forecast(payload)["interventions"]:
            for field in ("mean", "variance", "simulation_mean", "simulation_variance"):
                self.assertAlmostExact(item["procedures"][field], item["patients"][field])
            self.assertEqual(item["procedures"]["interval"], item["patients"]["interval"])

    def test_certain_intervention_and_full_year_keep_patient_count_deterministic(self):
        payload = make_payload()
        payload["profile"] = "expert_annual"
        payload["populations"] = dict.fromkeys(GROUP_IDS, 7)
        set_all_risks(payload, 1000)
        payload["procedures"]["vit"]["repeat_probability"] = 0.05
        result = by_id(forecast(payload))
        for item in result.values():
            self.assertAlmostExact(item["patients"]["mean"], 56)
            self.assertAlmostExact(item["patients"]["variance"], 0)
            self.assertEqual(item["patients"]["interval"], {"lower": 56, "upper": 56})
        self.assertAlmostExact(result["vit"]["procedures"]["mean"], 56 * 1.05)
        self.assertAlmostExact(result["vit"]["procedures"]["variance"], 56 * 0.05 * 0.95)

    def test_full_year_keeps_all_scheduled_repeat_operations(self):
        payload = make_payload()
        payload["populations"] = dict.fromkeys(GROUP_IDS, 10)
        set_all_risks(payload, 1000)
        # Every indicated patient receives two operations within the annual
        # scenario. There is no new-entry calendar truncation in this version.
        payload["procedures"]["vit"]["repeat_probability"] = 1
        result = by_id(forecast(payload))["vit"]
        self.assertAlmostExact(result["patients"]["mean"], 80)
        self.assertAlmostExact(result["procedures"]["mean"], 160)
        self.assertAlmostExact(result["procedures"]["variance"], 0)

    def test_shared_rate_uncertainty_survives_splitting_identical_population(self):
        split = make_payload()
        set_all_risks(split, 40)
        split["populations"] = dict.fromkeys(GROUP_IDS, 1000)
        pooled = deepcopy(split)
        pooled["populations"] = dict.fromkeys(GROUP_IDS, 0)
        pooled["populations"][GROUP_IDS[0]] = 8000
        split_result = by_id(forecast(split))
        pooled_result = by_id(forecast(pooled))
        for intervention in INTERVENTION_IDS:
            for outcome in ("patients", "procedures"):
                for field in ("mean", "variance"):
                    with self.subTest(intervention=intervention, outcome=outcome, field=field):
                        self.assertAlmostExact(
                            split_result[intervention][outcome][field],
                            pooled_result[intervention][outcome][field],
                        )
            total_var = split_result[intervention]["patients"]["variance"]
            separate_variances = sum(g["patients"]["variance"] for g in split_result[intervention]["groups"])
            self.assertGreater(total_var, separate_variances)

    def test_uncertainty_preserves_entered_marginal_means(self):
        payload = make_payload()
        set_all_uncertainties(payload, 1.5)
        for i, group in enumerate(GROUP_IDS):
            payload["populations"][group] = 100 + i
            for j, intervention in enumerate(INTERVENTION_IDS):
                payload["risks_per_1000"][group][intervention] = 0.5 + 25 * i + 3 * j
        result = by_id(forecast(payload))
        for intervention in INTERVENTION_IDS:
            expected_total = 0
            for group in result[intervention]["groups"]:
                expected = payload["populations"][group["id"]] * payload["risks_per_1000"][group["id"]][intervention] / 1000
                self.assertAlmostExact(group["patients"]["mean"], expected)
                expected_total += expected
            self.assertAlmostExact(result[intervention]["patients"]["mean"], expected_total)

    def test_group_expected_counts_add_to_totals(self):
        payload = make_payload()
        result = forecast(payload)
        for intervention in result["interventions"]:
            for outcome in ("patients", "procedures"):
                self.assertAlmostExact(
                    intervention[outcome]["mean"],
                    sum(group[outcome]["mean"] for group in intervention["groups"]),
                )

    def test_seed_reproduces_simulation(self):
        payload = make_payload()
        first = by_id(forecast(payload))
        second = by_id(forecast(deepcopy(payload)))
        for intervention in INTERVENTION_IDS:
            self.assertEqual(first[intervention]["patients"], second[intervention]["patients"])
            self.assertEqual(first[intervention]["procedures"], second[intervention]["procedures"])

    def test_coverage_changes_quantiles_but_not_distribution_moments(self):
        payload = make_payload()
        payload["coverage"] = 0.80
        narrower = by_id(forecast(payload))
        payload["coverage"] = 0.99
        wider = by_id(forecast(payload))
        for intervention in INTERVENTION_IDS:
            for outcome in ("patients", "procedures"):
                for field in ("mean", "variance", "simulation_mean", "simulation_variance"):
                    self.assertAlmostExact(narrower[intervention][outcome][field], wider[intervention][outcome][field])
                self.assertLessEqual(wider[intervention][outcome]["interval"]["lower"], narrower[intervention][outcome]["interval"]["lower"])
                self.assertGreaterEqual(wider[intervention][outcome]["interval"]["upper"], narrower[intervention][outcome]["interval"]["upper"])

    def test_monte_carlo_matches_analytic_moments(self):
        payload = make_payload()
        payload["iterations"] = 50000
        payload["populations"] = dict.fromkeys(GROUP_IDS, 40)
        set_all_risks(payload, 100)
        set_all_uncertainties(payload, 0.35)
        for item in forecast(payload)["interventions"]:
            for outcome in ("patients", "procedures"):
                summary = item[outcome]
                with self.subTest(intervention=item["id"], outcome=outcome):
                    self.assertAlmostEqual(summary["simulation_mean"], summary["mean"], delta=summary["mean"] * 0.02)
                    self.assertAlmostEqual(summary["simulation_variance"], summary["variance"], delta=summary["variance"] * 0.03)

    def test_only_original_stratified_scenario_is_offered(self):
        config = default_config()
        profiles = {profile["id"]: profile for profile in config["profiles"]}
        self.assertEqual(set(profiles), {"expert_annual"})
        expert = profiles["expert_annual"]["risks_per_1000"]
        self.assertEqual(set(expert), set(GROUP_IDS))
        self.assertGreater(len({tuple(expert[group][j] for j in INTERVENTION_IDS) for group in GROUP_IDS}), 1)

    def test_default_uses_original_matrix_without_an_alternate_estimate(self):
        payload = deepcopy(default_config()["defaults"])
        payload["iterations"] = 1000
        result = forecast(payload)
        self.assertEqual(result["meta"]["profile"], "expert_annual")
        expected = {"prp": (69.5, 168.19), "dme": (127, 594.36), "vit": (3.6, 3.78)}
        for item in result["interventions"]:
            self.assertAlmostExact(item["patients"]["mean"], expected[item["id"]][0])
            self.assertAlmostExact(item["procedures"]["mean"], expected[item["id"]][1])
            self.assertEqual(item["variance_components"]["patients"]["parameter"], 0)
        self.assertNotIn("comparison", result)

    def test_legacy_comparison_flag_does_not_add_another_estimate(self):
        payload = make_payload()
        payload["include_comparison"] = True
        result = forecast(payload)
        self.assertFalse(result["parameters"]["include_comparison"])
        self.assertNotIn("comparison", result)

    def test_old_literature_scenario_is_rejected_without_reinterpreting_its_risks(self):
        payload = make_payload()
        payload["profile"] = "literature_new"
        with self.assertRaisesRegex(ValueError, "исходный годовой сценарий"):
            forecast(payload)

    def test_published_injection_sd_is_used_without_poisson_inflation(self):
        payload = make_payload()
        payload["profile"] = "expert_annual"
        set_all_uncertainties(payload, 0)
        payload["procedures"]["dme"].update(mean=7.7, sd=1.9)
        result = by_id(forecast(payload))["dme"]
        # K = K_eye + Bernoulli(.2)*K_other; independent eye counts.
        course_mean = 1.2 * 7.7
        course_variance = 1.2 * 1.9**2 + 0.2 * 0.8 * 7.7**2
        expected_variance = result["patients"]["mean"] * course_variance + result["patients"]["variance"] * course_mean**2
        self.assertAlmostExact(result["procedures"]["variance"], expected_variance)
        self.assertAlmostExact(result["variance_components"]["procedures"]["course"], result["patients"]["mean"] * course_variance)

    def test_arbitrary_population_size_and_total_limit(self):
        payload = make_payload()
        payload["populations"] = dict.fromkeys(GROUP_IDS, 0)
        payload["populations"][GROUP_IDS[0]] = 12345
        self.assertEqual(forecast(payload)["meta"]["population_total"], 12345)
        payload["populations"][GROUP_IDS[0]] = 80000000
        payload["populations"][GROUP_IDS[1]] = 1
        with self.assertRaisesRegex(ValueError, "80 000 000"):
            forecast(payload)

    def test_invalid_values_raise_value_error(self):
        mutations = [
            ("negative population", lambda p: p["populations"].__setitem__(GROUP_IDS[0], -1)),
            ("fractional population", lambda p: p["populations"].__setitem__(GROUP_IDS[0], 2.5)),
            ("boolean population", lambda p: p["populations"].__setitem__(GROUP_IDS[0], True)),
            ("negative risk", lambda p: p["risks_per_1000"][GROUP_IDS[0]].__setitem__("prp", -1)),
            ("risk over one", lambda p: p["risks_per_1000"][GROUP_IDS[0]].__setitem__("prp", 1001)),
            ("NaN risk", lambda p: p["risks_per_1000"][GROUP_IDS[0]].__setitem__("prp", float("nan"))),
            ("boolean risk", lambda p: p["risks_per_1000"][GROUP_IDS[0]].__setitem__("prp", True)),
            ("NaN uncertainty", lambda p: p["uncertainty_cv"].__setitem__("prp", float("nan"))),
            ("negative uncertainty", lambda p: p["uncertainty_cv"].__setitem__("prp", -0.1)),
            ("infinite capture", lambda p: p["capture"].__setitem__("prp", float("inf"))),
            ("capture over one", lambda p: p["capture"].__setitem__("prp", 1.01)),
            ("zero iterations", lambda p: p.__setitem__("iterations", 0)),
            ("invalid coverage", lambda p: p.__setitem__("coverage", 1.1)),
            ("invalid profile", lambda p: p.__setitem__("profile", "not_a_profile")),
            ("invalid bilateral", lambda p: p["procedures"]["dme"].__setitem__("bilateral_probability", -0.2)),
            ("invalid repeat", lambda p: p["procedures"]["vit"].__setitem__("repeat_probability", 1.2)),
        ]
        for label, mutate in mutations:
            with self.subTest(label=label):
                payload = make_payload()
                mutate(payload)
                with self.assertRaises(ValueError):
                    forecast(payload)


if __name__ == "__main__":
    unittest.main()
