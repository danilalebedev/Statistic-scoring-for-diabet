"""Literature-informed, explicitly scenario-based annual workload model.

No local patient data or fitted Moscow risks are included. NumPy is the sole
third-party dependency. Closed-form conditional moments are integrated by
Gauss-Hermite quadrature; predictive quantiles come from seeded simulation.
"""
from __future__ import annotations

from copy import deepcopy
from functools import lru_cache
import math
from pathlib import Path
import time

import numpy as np

MODEL_VERSION = "1.1.0"
GROUPS = [
    {"id": "t1_lt5", "type": "СД1", "duration": "<5 лет", "label": "СД1 · <5 лет"},
    {"id": "t1_5_9", "type": "СД1", "duration": "5–9 лет", "label": "СД1 · 5–9 лет"},
    {"id": "t1_10_19", "type": "СД1", "duration": "10–19 лет", "label": "СД1 · 10–19 лет"},
    {"id": "t1_ge20", "type": "СД1", "duration": "≥20 лет", "label": "СД1 · ≥20 лет"},
    {"id": "t2_lt5", "type": "СД2", "duration": "<5 лет", "label": "СД2 · <5 лет"},
    {"id": "t2_5_9", "type": "СД2", "duration": "5–9 лет", "label": "СД2 · 5–9 лет"},
    {"id": "t2_10_19", "type": "СД2", "duration": "10–19 лет", "label": "СД2 · 10–19 лет"},
    {"id": "t2_ge20", "type": "СД2", "duration": "≥20 лет", "label": "СД2 · ≥20 лет"},
]
INTERVENTIONS = [
    {"id": "prp", "name": "ПРЛК", "unit": "сеансов"},
    {"id": "dme", "name": "ИВВ при ДМО", "unit": "инъекций"},
    {"id": "vit", "name": "Витрэктомия", "unit": "операций"},
]
DME_MOMENT_PRESETS = [
    {"id": "IRIS2024", "label": "IRIS · 3,9 ± 2,8 на глаз", "mean": 3.9, "sd": 2.8, "source_id": "IRIS2024", "note": "Первый год в реальной практике США; SD индивидуальных количеств инъекций используется напрямую."},
    {"id": "Peto2022", "label": "Peto · 7,7 ± 1,9 на глаз", "mean": 7.7, "sd": 1.9, "source_id": "Peto2022", "note": "Первый год наблюдаемой подгруппы; не безусловное среднее всех вошедших. Разброс ниже пуассоновского."},
    {"id": "DRAKO2023", "label": "DRAKO · 6,4 ± 2,1 на глаз", "mean": 6.4, "sd": 2.1, "source_id": "DRAKO2023", "note": "Наблюдаемая группа ранее не леченных в первый год; отбор по полноте наблюдения."},
]

SOURCE_DETAILS = [
    {"id": "LANDSCAPE2022", "title": "LANDSCAPE · Франция · 2022", "url": "https://doi.org/10.3390/pharmaceutics14112330", "finding": "Новые ПРЛК: 3,12 на 1000 взрослых с диабетом в 2018 г.; начало лечения ДМО: 3,73 на 1000 соответствующей диабетической популяции.", "limitation": "Нет восьми групп по типу и стажу. ДМО: возраст <80 лет и диагностические исключения, анти-VEGF и стероидные импланты. Перенос на все возрасты и выбранную схему инъекций — допущение."},
    {"id": "SOURCE2026", "title": "SOURCE · Ophthalmology Science · 2026", "url": "https://doi.org/10.1016/j.xops.2026.101181", "finding": "Среди получивших ПРЛК после диагноза ПДР: 2,42 сеанса на человека за первый год, SD 1,51; 13 центров США.", "limitation": "Условная кратность лечения, не риск ПРЛК среди всех пациентов с диабетом. Не множитель на глаз."},
    {"id": "IRIS2024", "title": "IRIS · Ophthalmology Retina · 2024", "url": "https://doi.org/10.1016/j.oret.2024.05.017", "finding": "190 345 глаз: после начала анти-VEGF терапии ДМО в первый год 3,9 инъекции на глаз, SD 2,8.", "limitation": "Реальное оказанное лечение, возможное недолечивание, цензурирование. Перенос опубликованных годовых моментов в модель курса и календарного входа — отдельное допущение."},
    {"id": "Vaideanu2014", "title": "Vaideanu · Ophthalmic Epidemiology · 2014", "url": "https://doi.org/10.3109/09286586.2014.906628", "finding": "Северо-восток Англии: в 2010 г. 1,03 первой учитываемой витрэктомии на 1000 зарегистрированных пациентов с диабетом.", "limitation": "Первый глаз, старый период лечения, нет восьми групп. При расчётном полном знаменателе диабетической популяции — 0,77 на 1000, доступен альтернативный сценарий частоты."},
    {"id": "DRAKO2023", "title": "DRAKO · Eye · 2023", "url": "https://doi.org/10.1038/s41433-023-02409-y", "finding": "У ранее не леченных: 6,4 инъекции первого года, SD 2,1. Во втором году инъекции получили 73,9% наблюдаемой группы; среди получавших 3,7, SD 2,3.", "limitation": "Профиль сравнения кратности, не популяционный риск. Во втором году среднее исключает нули; нельзя подставлять 3,7 всем пациентам."},
    {"id": "Peto2022", "title": "Peto · Diabetic Medicine · 2022", "url": "https://doi.org/10.1111/dme.14746", "finding": "В наблюдаемой подгруппе 7,7 инъекции на глаз первого года, SD 1,9.", "limitation": "Нет минимального срока наблюдения всей когорты; моменты нельзя считать безусловными для всех вошедших. Доступен только как сценарий чувствительности кратности."},
    {"id": "Ostri2014", "title": "Ostri · Acta Ophthalmologica · 2014", "url": "https://doi.org/10.1111/aos.12249", "finding": "СД1: 3980 пациентов, кумулятивная витрэктомия 1,6% за 5 лет и 2,9% за 10 лет.", "limitation": "Не превращается автоматически в годовую вероятность и не используется для восьми коэффициентов."},
    {"id": "Moorfields2021", "title": "Moorfields · Eye · 2021/2022", "url": "https://doi.org/10.1038/s41433-021-01646-3", "finding": "Пример помесячного прогноза оказанных инъекций с трендом и календарной сезонностью.", "limitation": "Все показания, не только ДМО. Биологическая сезонность для Москвы в прототипе не задана."},
    {"id": "DIARET_SK_2019", "title": "DIARET SK · PLOS ONE · 2019", "url": "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0223788", "finding": "4014 обследованных: ПДР и ДМО совместно по СД1/СД2 и стажу. В методике показаны восемь нужных групп; 10–19 лет объединены из двух исходных строк с указанием способа расчёта.", "limitation": "Распространённость при обследовании без последующего наблюдения, не годовой риск лечения. Группа ≥20 лет дополнительно набиралась. В трёх строках ДМО СД2 число случаев противоречит процентам; эти числители не используются для оценки риска или CI."},
    {"id": "Stokholm2024_DiaBase_T1", "title": "DiaBase · СД1 · Acta Ophthalmologica · 2024", "url": "https://onlinelibrary.wiley.com/doi/full/10.1111/aos.16707", "finding": "16 999 пациентов с СД1: прогрессирование в ПДР по стажу <10, 10–20 и >20 лет — 0,5%, 2,9% и 3,8% между первым и последним обследованием в период 2013–2018.", "limitation": "Другие границы стажа и переменная длительность наблюдения; это не годовые ПРЛК. Пересекается с другими анализами DiaBase, поэтому выборки нельзя складывать как независимые."},
    {"id": "Grauslund2023_DiaBase_T2", "title": "DiaBase · СД2 · Acta Ophthalmologica · 2023", "url": "https://onlinelibrary.wiley.com/doi/full/10.1111/aos.15264", "finding": "153 238 пациентов с СД2: прогрессирование в ПДР по стажу <10, 10–20 и >20 лет — 0,1%, 0,4% и 1,1% между первым и последним обследованием в период 2013–2018.", "limitation": "Нельзя разделить <10 лет на <5 и 5–9 по опубликованной таблице. Не годовой риск вмешательства; пересечение регистра с другими работами не увеличивает независимую выборку."},
    {"id": "Kyto2011_FinnDiane", "title": "FinnDiane · Diabetes Care · 2011", "url": "https://doi.org/10.2337/dc10-2391", "finding": "3781 пациент с СД1, 1219 первых лазерных лечений: кумулятивная частота существенно зависит от стажа и календарной эпохи диагноза.", "limitation": "Лазер объединяет ПДР, макулярный отёк и тяжёлую НПДР. Кривые выживаемости не дают готовые восемь годовых вероятностей ПРЛК; требуется разделение исходов и учёт цензурирования."},
    {"id": "Bek_2024", "title": "Bek · Acta Ophthalmologica · 2024", "url": "https://doi.org/10.1111/aos.16637", "finding": "19 279 пациентов, 1665 первых лечений ДМО и 1530 первых ПРЛК. Многостадийная модель Кокса учитывает стаж, меняющиеся факторы риска и конкурирующую смерть.", "limitation": "Лечение ДМО объединяет макулярный лазер и интравитреальное лечение. Тип диабета исключён авторами из-за непоследовательной регистрации; полной таблицы СД1/СД2 × стаж для ИВВ нет."},
    {"id": "Nevill2021_PRP_NPDR", "title": "Nevill · Eye · 2021/2022", "url": "https://www.nature.com/articles/s41433-021-01471-8", "finding": "Годовая частота первой ПРЛК 6,4% (95% CI 4,1–9,9%) у пациентов с уже имеющейся НПДР уровней ETDRS 47–53.", "limitation": "Условный риск в группе с выраженной ретинопатией; не риск среди всех пациентов с диабетом. Подтверждает необходимость знать исходную стадию поражения."},
    {"id": "Kern_open_data_2020", "title": "Moorfields / Dryad · открытые данные · 2020", "url": "https://datadryad.org/dataset/doi:10.5061/dryad.pzgmsbcfw", "finding": "Обезличенные CSV и R-код: 1964 пациента, 2614 глаз, реальные повторные инъекции и сроки наблюдения.", "limitation": "В опубликованном словаре нет типа и стажа диабета, нет знаменателя нелеченых пациентов. Полезно для кратности среди леченных, не для восьми вероятностей начала лечения."},
]


def default_config():
    # Exact, unrounded scenario matrix from the supplied DOCX, converted to /1000.
    original = [
        (1, 1, .05), (3, 4, .1), (10, 15, .4), (25, 35, 1.25),
        (1.5, 6, .1), (4, 12, .2), (9, 22, .5), (16, 32, 1),
    ]
    expert = {g["id"]: dict(zip(("prp", "dme", "vit"), row)) for g, row in zip(GROUPS, original)}
    return {
        "model_version": MODEL_VERSION,
        "model_name": "Стратифицированная биномиальная модель пациентов с составным распределением числа процедур",
        "dme_moment_presets": deepcopy(DME_MOMENT_PRESETS),
        "groups": deepcopy(GROUPS), "interventions": deepcopy(INTERVENTIONS),
        "profiles": [
            {"id": "expert_annual", "title": "По группам из СД.docx · годовая потребность", "description": "Основной групповой расчёт: годовые вероятности из присланной матрицы по типу и стажу, включая продолжающееся лечение. Там, где статьи не дают годовой стратификации, используются присланные данные. Кратность и её SD берутся из выбранных исследований с явно указанными допущениями переноса.", "risks_per_1000": expert},
        ],
        "defaults": {
            "profile": "expert_annual", "populations": {g["id"]: 1000 for g in GROUPS},
            "risks_per_1000": deepcopy(expert), "coverage": .95,
            "iterations": 50000, "seed": 20261016,
            "uncertainty_cv": {k["id"]: 0. for k in INTERVENTIONS},
            "capture": {k["id"]: 1. for k in INTERVENTIONS},
            "procedures": {"prp": {"mean": 2.42, "sd": 1.51}, "dme": {"mean": 3.9, "sd": 2.8, "bilateral_probability": .2, "moment_source": "IRIS2024"}, "vit": {"repeat_probability": .05}},
            "include_comparison": False,
        },
        "sources": deepcopy(SOURCE_DETAILS),
    }


def _number(value, label, low, high, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{label}: требуется число.")
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"{label}: допустимый диапазон {low}–{high}.")
    if integer and int(value) != value:
        raise ValueError(f"{label}: требуется целое число.")
    return int(value) if integer else float(value)


def validate(payload):
    if not isinstance(payload, dict):
        raise ValueError("Настройки должны быть JSON-объектом.")
    try:
        p = deepcopy(payload)
        if p["profile"] != "expert_annual":
            raise ValueError("Доступен только исходный годовой сценарий. Выберите сценарий на основе СД.docx.")
        p["coverage"] = _number(p["coverage"], "Уровень вероятности", .5, .999)
        p["iterations"] = _number(p["iterations"], "Число симуляций", 1000, 200000, True)
        p["seed"] = _number(p["seed"], "Seed", 0, 2**32 - 1, True)
        for group in GROUPS:
            gid = group["id"]
            p["populations"][gid] = _number(p["populations"][gid], f"Численность {group['label']}", 0, 80000000, True)
            for spec in INTERVENTIONS:
                kid = spec["id"]
                p["risks_per_1000"][gid][kid] = _number(p["risks_per_1000"][gid][kid], f"Частота {group['label']}, {spec['name']}", 0, 1000)
        for spec in INTERVENTIONS:
            kid = spec["id"]
            p["uncertainty_cv"][kid] = _number(p["uncertainty_cv"][kid], f"CV интенсивности {spec['name']}", 0, 2)
            p["capture"][kid] = _number(p["capture"][kid], f"Доля направлений {spec['name']}", 0, 1)
        for kid in ("prp", "dme"):
            pp = p["procedures"][kid]
            pp["mean"] = _number(pp["mean"], f"Средняя кратность {kid}", 1, 30)
            pp["sd"] = _number(pp["sd"], f"SD кратности {kid}", 0, 30)
        p["procedures"]["dme"]["bilateral_probability"] = _number(p["procedures"]["dme"]["bilateral_probability"], "Вероятность лечения второго глаза", 0, 1)
        p["procedures"]["vit"]["repeat_probability"] = _number(p["procedures"]["vit"]["repeat_probability"], "Вероятность одной дополнительной витрэктомии", 0, 1)
        if sum(p["populations"][g["id"]] for g in GROUPS) > 80000000:
            raise ValueError("Общая численность не должна превышать 80 000 000 человек.")
        if not isinstance(p.get("include_comparison", False), bool):
            raise ValueError("include_comparison должен быть логическим значением.")
        # An old saved annual scenario may contain the former comparison flag.
        # Keep its entered risks but never add a different treatment endpoint.
        p["include_comparison"] = False
        dme = p["procedures"]["dme"]
        matched = next((item for item in DME_MOMENT_PRESETS if abs(dme["mean"] - item["mean"]) < 1e-10 and abs(dme["sd"] - item["sd"]) < 1e-10), None)
        dme["moment_source"] = matched["id"] if matched else "custom"
        return p
    except (KeyError, TypeError, AttributeError) as exc:
        raise ValueError("Не хватает обязательных настроек или нарушена структура сценария.") from exc


@lru_cache(maxsize=256)
def _positive_pmf(mean, sd):
    """Construct an explicit positive integer distribution with given moments.

    For v>mean-1: shifted NB. Otherwise a mixture of shifted Poisson and
    two neighbouring integer values, both components with the same mean.
    This is a modelling choice, not a recovered empirical distribution.
    """
    x, variance = mean - 1, sd * sd
    fraction = x - math.floor(x)
    minimum = fraction * (1 - fraction)
    if variance < minimum - 1e-9:
        raise ValueError(f"Среднее {mean:g} и SD {sd:g} несовместимы с целым числом процедур: минимальная дисперсия {minimum:.6g}.")
    if x < 1e-12:
        if variance > 1e-9:
            raise ValueError("При среднем 1 положительное целое число процедур всегда равно 1; SD должен быть 0.")
        return np.array([0., 1.]), "фиксированная 1 процедура", 0.
    if variance <= x + 1e-10:
        mixture = 0. if abs(x - minimum) < 1e-12 else max(0., min(1., (variance - minimum) / (x - minimum)))
        if mixture <= 1e-12:
            result = np.zeros(math.ceil(mean) + 1)
            result[math.floor(mean)] += 1 - fraction
            result[math.ceil(mean)] += fraction
            return result, "два соседних целых значения", 0.
        values = [math.exp(-x)]
        cumulative = values[0]
        for j in range(1, 10001):
            values.append(values[-1] * x / j)
            cumulative += values[-1]
            if j > x and 1 - cumulative < 1e-13:
                break
        base = np.r_[0., np.asarray(values)]
        result = mixture * base
        result[math.floor(mean)] += (1 - mixture) * (1 - fraction)
        result[math.ceil(mean)] += (1 - mixture) * fraction
        family = "1 + Пуассон" if mixture > 1 - 1e-10 else "смесь положительных целочисленных распределений"
    else:
        shape = x * x / (variance - x)
        success = x / variance
        values = [math.exp(shape * math.log(success))]
        cumulative = values[0]
        for j in range(1, 10001):
            values.append(values[-1] * (j - 1 + shape) / j * (1 - success))
            cumulative += values[-1]
            if j > mean and 1 - cumulative < 1e-13:
                break
        result = np.r_[0., np.asarray(values)]
        family = "1 + отрицательное биномиальное"
    tail = max(0., 1 - float(result.sum()))
    if tail > 1e-10:
        raise ValueError("Слишком тяжёлый хвост распределения кратности: уменьшите SD или увеличьте среднее.")
    # Record the numerical tail; normalisation only removes sub-1e-10 error.
    result = result / result.sum()
    support = np.arange(len(result))
    actual_mean = float(support @ result)
    actual_variance = float(((support - actual_mean)**2) @ result)
    if abs(actual_mean - mean) > 1e-6 or abs(actual_variance - variance) > 1e-5:
        raise ValueError("Не удалось достаточно точно представить распределение кратности с указанными моментами.")
    return result, family, tail


def _course(spec, parameters):
    kid = spec["id"]
    pp = parameters["procedures"][kid]
    if kid == "vit":
        repeat = pp["repeat_probability"]
        full = np.array([0., 1 - repeat, repeat])
        mean, variance = 1 + repeat, repeat * (1 - repeat)
        family, tail = "1 + Бернулли дополнительной операции", 0.
    else:
        eye, family, tail = _positive_pmf(pp["mean"], pp["sd"])
        mean, variance = pp["mean"], pp["sd"]**2
        full = eye
        if kid == "dme":
            b = pp["bilateral_probability"]
            two_eyes = np.convolve(eye, eye)
            full = b * two_eyes
            full[:len(eye)] += (1 - b) * eye
            mean, variance = (1 + b) * mean, (1 + b) * variance + b * (1 - b) * mean**2
    period, period_mean, period_variance = full, mean, variance
    period = period / period.sum()
    return {
        "pmf": period, "course_mean": mean, "course_variance": variance,
        "period_mean": period_mean, "period_variance": period_variance,
        "distribution_family": family, "truncated_mass_bound": tail,
    }


@lru_cache(maxsize=1)
def _quadrature():
    nodes, weights = np.polynomial.hermite.hermgauss(96)
    return math.sqrt(2) * nodes, weights / math.sqrt(math.pi)


def _hazard_curve(means, cv):
    nodes, weights = _quadrature()
    if cv == 0:
        return np.asarray(means), np.asarray(means)[:, None], np.array([1.]), np.array([1.]), 0.
    sigma = math.sqrt(math.log1p(cv * cv))
    factor = np.exp(sigma * nodes - sigma * sigma / 2)
    hazards = []
    curves = []
    for probability in means:
        if probability == 0 or probability == 1:
            hazards.append(0. if probability == 0 else math.inf)
            curves.append(np.full(len(weights), probability))
            continue
        low, high = 0., max(1., -math.log1p(-probability))
        while float(weights @ (-np.expm1(-high * factor))) < probability:
            high *= 2
        for _ in range(65):
            midpoint = (low + high) / 2
            if float(weights @ (-np.expm1(-midpoint * factor))) < probability:
                low = midpoint
            else:
                high = midpoint
        hazard = (low + high) / 2
        hazards.append(hazard)
        curves.append(-np.expm1(-hazard * factor))
    return np.asarray(hazards), np.asarray(curves), weights, factor, sigma


def _random_sum(rng, patients, pmf):
    """Exact multinomial composition of a finite positive-count PMF.

    All patients in a draw remain individual independent draws from K.
    Do not multiply patient count by one randomly drawn course length.
    """
    active = np.flatnonzero(pmf > 0)
    if len(active) == 1:
        return patients * int(active[0])
    remaining = patients.copy()
    remaining_mass = 1.
    output = np.zeros_like(patients)
    for value in active[:-1]:
        conditional = float(np.clip(pmf[value] / remaining_mass, 0, 1))
        counts = rng.binomial(remaining, conditional)
        output += counts * int(value)
        remaining -= counts
        remaining_mass -= float(pmf[value])
        if not np.any(remaining):
            return output
    output += remaining * int(active[-1])
    return output


def _summary(samples, mean, variance, coverage):
    alpha = (1 - coverage) / 2
    low, high, upper = np.quantile(samples, [alpha, 1 - alpha, coverage], method="inverted_cdf")
    variance = max(0., float(variance))
    return {
        "mean": float(mean), "variance": variance, "sd": math.sqrt(variance),
        "interval": {"lower": int(low), "upper": int(high)}, "upper_quantile": int(upper),
        "zero_probability": float(np.mean(samples == 0)),
        "simulation_mean": float(samples.mean()), "simulation_variance": float(samples.var()),
    }


def _forecast_one(payload):
    started = time.perf_counter()
    p = validate(payload)
    n = np.asarray([p["populations"][g["id"]] for g in GROUPS], dtype=np.int64)
    count = p["iterations"]
    outputs = []
    streams = np.random.SeedSequence(p["seed"]).spawn(len(INTERVENTIONS))
    for spec, stream in zip(INTERVENTIONS, streams):
        kid = spec["id"]
        rng = np.random.default_rng(stream)
        marginal_p = np.asarray([p["risks_per_1000"][g["id"]][kid] / 1000 for g in GROUPS])
        cv, capture = p["uncertainty_cv"][kid], p["capture"][kid]
        hazards, clinical_curves, weights, _, sigma = _hazard_curve(marginal_p, cv)
        clinical_means = clinical_curves @ weights
        if not np.allclose(clinical_means, marginal_p, atol=1e-11, rtol=0):
            raise ArithmeticError("Проверка калибровки вероятностей не пройдена.")
        curves = capture * clinical_curves
        mean_q = capture * marginal_p
        conditional_binomial = np.maximum(0., curves * (1 - curves))
        conditional_variance = n[:, None] * conditional_binomial
        conditional_means = n[:, None] * curves
        group_means = n * mean_q
        centered = conditional_means - group_means[:, None]
        group_variances = conditional_variance @ weights + (centered**2) @ weights
        total_mean = float(group_means.sum())
        total_cond_mean = conditional_means.sum(axis=0)
        total_variance = float(conditional_variance.sum(axis=0) @ weights + ((total_cond_mean - total_mean)**2) @ weights)
        course = _course(spec, p)
        km, kv = course["period_mean"], course["period_variance"]

        if cv == 0:
            sampled_p = np.repeat(marginal_p[:, None], count, axis=1)
        else:
            h = rng.lognormal(-sigma * sigma / 2, sigma, count)
            sampled_p = np.zeros((len(GROUPS), count))
            for index, probability in enumerate(marginal_p):
                if probability == 1:
                    sampled_p[index] = 1
                elif probability > 0:
                    sampled_p[index] = -np.expm1(-hazards[index] * h)
        sampled_q = np.clip(capture * sampled_p, 0, 1)
        patients = rng.binomial(n[:, None], sampled_q)
        procedures = _random_sum(rng, patients, course["pmf"])
        rows = []
        for index, group in enumerate(GROUPS):
            rows.append({
                **deepcopy(group), "n": int(n[index]),
                "risk_per_1000": float(marginal_p[index] * 1000),
                "patients": _summary(patients[index], group_means[index], group_variances[index], p["coverage"]),
                "procedures": _summary(procedures[index], group_means[index] * km, group_means[index] * kv + group_variances[index] * km * km, p["coverage"]),
            })
        outputs.append({
            **deepcopy(spec), "course_mean": course["course_mean"], "course_variance": course["course_variance"],
            "period_mean": km, "period_variance": kv,
            "distribution_family": course["distribution_family"], "truncated_mass_bound": course["truncated_mass_bound"],
            "patients": _summary(patients.sum(axis=0), total_mean, total_variance, p["coverage"]),
            "procedures": _summary(procedures.sum(axis=0), total_mean * km, total_mean * kv + total_variance * km * km, p["coverage"]),
            "groups": rows,
            "parameter_variance_patients": float(((total_cond_mean - total_mean)**2) @ weights),
            "event_variance_patients": float(conditional_variance.sum(axis=0) @ weights),
            "variance_components": {
                "patients": {"event": float(conditional_variance.sum(axis=0) @ weights), "parameter": float(((total_cond_mean - total_mean)**2) @ weights)},
                "procedures": {
                    "course": float(total_mean * kv),
                    "patients": float(km * km * (conditional_variance.sum(axis=0) @ weights)),
                    "parameter": float(km * km * (((total_cond_mean - total_mean)**2) @ weights)),
                },
            },
        })
    warnings = [
        "Прогнозные интервалы условны на выбранные источники и допущения; модель не проверена на данных Москвы или конкретной больницы.",
        "CV интенсивности — настраиваемая неопределённость переноса, а не оценённый по публикациям доверительный интервал.",
        "При CV=0 показаны условные прогнозные интервалы при фиксированных рисках. Опубликованные SD индивидуального количества процедур уже включены как SD²; это не неопределённость годовой вероятности вмешательства.",
        "Средние и SD кратности, доля второго глаза, повторной операции и направлений заданы как фиксированные сценарные параметры; неопределённость самих этих параметров исследуется их изменением, а не отдельными априорными распределениями.",
        "Пациенты разных вмешательств могут совпадать. Общий итог уникальных людей по трём вмешательствам не рассчитывается.",
        "Квантили оценены симуляцией; при изменении seed или числа симуляций границы могут немного изменяться. Средние и дисперсии вычисляются отдельно интегрированием модели.",
        "Сезонные месячные коэффициенты не заданы. Результат относится ко всему 12-месячному периоду.",
    ]
    warnings[:0] = [
        "Групповые годовые частоты из СД.docx — экспертные сценарии, а не измеренные вероятности. Исходная сводная ошибка витрэктомии не используется.",
        "Распределения кратности первого года из исследований переносятся на всех пациентов с годовым лечением как редактируемое допущение.",
    ]
    return {
        "meta": {
            "profile": p["profile"], "coverage": p["coverage"], "iterations": count, "seed": p["seed"],
            "population_total": int(n.sum()), "elapsed_seconds": round(time.perf_counter() - started, 3),
            "model_version": MODEL_VERSION,
            "timing_label": "Годовой контингент · полный 12-месячный период",
            "interval_kind": "marginal_central_predictive", "quadrature_nodes": 96,
            "model_name": default_config()["model_name"],
        },
        "warnings": warnings, "parameters": p, "interventions": outputs,
    }


def forecast(payload):
    """Forecast the editable original annual scenario only."""
    return _forecast_one(payload)
