"""Joins the study's evidence per run and prints per-run rows and the per-preset 2 x 2 tables.

Inputs in results/: grid-<mode>.jsonl (capacity-measurement records), k6-points.jsonl (the
outcome-tagged request durations), orders-poll.jsonl (last reservation and confirmation per run)
and docker-stats.txt (container CPU samples).
Usage: python3 analyze.py results > results/summary.md
"""

import json
import statistics
import sys
from datetime import datetime
from pathlib import Path

CONTAINERS = ("api", "postgres", "redis")
MODES = {"redis": "demo", "baseline": "baseline"}


def ts(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def pct(values, q):
    if not values:
        return None
    values = sorted(values)
    return values[min(len(values) - 1, max(0, round(q * len(values) + 0.5) - 1))]


def load(results):
    records = []
    for mode in MODES:
        path = results / f"grid-{mode}.jsonl"
        if path.exists():
            records += [dict(json.loads(line), mode=mode) for line in path.read_text().splitlines()]
    points = []
    for line in (results / "k6-points.jsonl").read_text().splitlines():
        data = json.loads(line)["data"]
        end = ts(data["time"][:26] + "Z") if len(data["time"]) > 27 else ts(data["time"])
        points.append((end, data["value"], data["tags"].get("outcome")))
    polls = {}
    for line in (results / "orders-poll.jsonl").read_text().splitlines():
        row = json.loads(line)
        polls[row["runId"]] = row
    stats = []
    for line in (results / "docker-stats.txt").read_text().splitlines():
        parts = line.split()
        if len(parts) == 3 and parts[2].endswith("%"):
            stats.append((float(parts[0]), parts[1], float(parts[2][:-1])))
    return records, points, polls, stats


def analyze_run(record, points, polls, stats):
    start, end = ts(record["times"]["startedAt"]), ts(record["generator"]["k6CompletedAt"]) + 2
    mine = [p for p in points if start <= p[0] <= end]
    first_start = min(p[0] - p[1] / 1000 for p in mine)
    last_answer = max(p[0] for p in mine)
    req, resp = record["requests"], record["responses"]
    complete = (
        req["plannedRequests"] == req["startedRequests"] == req["completedRequests"]
        and req["interruptedRequests"] == 0
        and req["unstartedRequests"] == 0
        and resp["failedRequests"] == 0
    )
    stock = record["config"]["inventoryConfig"]["startingStock"]
    poll = polls.get(record["runId"], {})
    sold_out_s = (
        ts(poll["lastSecuredAt"]) - first_start if poll.get("orders") == stock else None
    )
    confirmed_s = (
        ts(poll["lastConfirmedAt"]) - first_start
        if poll.get("confirmed") == poll.get("orders") and poll.get("orders")
        else None
    )
    latency = {}
    for outcome in (None, "accepted", "sold_out", "failed"):
        values = [p[1] / 1000 for p in mine if outcome is None or p[2] == outcome]
        if values:
            latency[outcome or "all"] = {
                "n": len(values),
                "p50": pct(values, 0.5),
                "p95": pct(values, 0.95),
                "max": max(values),
            }
    cpu = {}
    for name in CONTAINERS:
        samples = [c for t, n, c in stats if n.endswith(f"-{name}-1") and first_start <= t <= last_answer]
        cpu[name] = (statistics.mean(samples), max(samples)) if samples else (None, None)
    return {
        "label": record["label"],
        "mode": MODES[record["mode"]],
        "runId": record["runId"],
        "status": record["status"],
        "deliveryStatus": record["deliveryStatus"],
        "failureReason": record["failureReason"],
        "complete": complete,
        "requests": req,
        "accepted": resp["acceptedResponses"],
        "soldOut": resp["soldOutResponses"],
        "failed": resp["failedRequests"],
        "recordP95": resp["p95LatencyMs"] / 1000,
        "latency": latency,
        "allAnsweredS": last_answer - first_start,
        "soldOutS": sold_out_s,
        "allConfirmedS": confirmed_s,
        "ordersPersisted": poll.get("orders"),
        "ordersConfirmed": poll.get("confirmed"),
        "cpuDuringTraffic": cpu,
    }


def fmt(values, digits=1):
    values = [v for v in values if v is not None]
    if not values:
        return "–"
    med = statistics.median(values)
    spread = f" ({min(values):.{digits}f}–{max(values):.{digits}f})" if len(values) > 1 else ""
    return f"{med:.{digits}f}{spread}"


def table(preset, rows):
    cells = [(m, e) for m in ("demo", "baseline") for e in ("erp", "noerp")]
    header = ["", *[f"{m}, {'preset ERP' if e == 'erp' else 'no ERP'}" for m, e in cells]]
    lines = [f"### {preset}", "", "| " + " | ".join(header) + " |", "|" + "---|" * len(header)]

    def row(name, get, digits=1):
        out = [name]
        for m, e in cells:
            runs = [r for r in rows if r["mode"] == m and r["label"].startswith(f"{preset}-{e}-")]
            out.append(fmt([get(r) for r in runs], digits) if runs else "–")
        lines.append("| " + " | ".join(out) + " |")

    def lat(outcome, key):
        return lambda r: r["latency"].get(outcome, {}).get(key)

    out = ["complete runs"]
    for m, e in cells:
        runs = [r for r in rows if r["mode"] == m and r["label"].startswith(f"{preset}-{e}-")]
        out.append(f"{sum(r['complete'] for r in runs)}/{len(runs)}")
    lines.append("| " + " | ".join(out) + " |")
    row("accepted", lambda r: r["accepted"], 0)
    row("sold out", lambda r: r["soldOut"], 0)
    row("failed", lambda r: r["failed"], 0)
    row("interrupted + unstarted", lambda r: r["requests"]["interruptedRequests"] + r["requests"]["unstartedRequests"], 0)
    for outcome, name in (("all", "all"), ("accepted", "accepted"), ("sold_out", "sold out")):
        for key in ("p50", "p95", "max"):
            row(f"{name} {key} (s)", lat(outcome, key), 2)
    row("all buyers answered (s)", lambda r: r["allAnsweredS"])
    row("stock sold out (s)", lambda r: r["soldOutS"])
    row("all orders confirmed (s)", lambda r: r["allConfirmedS"])
    for name in CONTAINERS:
        row(f"{name} CPU % mean", lambda r, n=name: r["cpuDuringTraffic"][n][0], 0)
        row(f"{name} CPU % max", lambda r, n=name: r["cpuDuringTraffic"][n][1], 0)
    return "\n".join(lines)


def main():
    results = Path(sys.argv[1])
    records, points, polls, stats = load(results)
    rows = [analyze_run(r, points, polls, stats) for r in records]
    (results / "runs-analyzed.json").write_text(json.dumps(rows, indent=1))
    presets = []
    for r in rows:
        preset = r["label"].rsplit("-", 2)[0]
        if preset not in presets:
            presets.append(preset)
    print("Times are from the first request's start. CPU is over the traffic window (first request to last answer), 100% = one core.\n")
    for preset in presets:
        print(table(preset, [r for r in rows if r["label"].startswith(preset + "-")]) + "\n")
    print("### Per run\n")
    print("| run | mode | status / delivery | complete | accepted | sold out | failed | p95 (s) | answered (s) | sold out (s) | confirmed (s) |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        f = lambda v: "–" if v is None else f"{v:.1f}"
        print(
            f"| {r['label']} | {r['mode']} | {r['status']}/{r['deliveryStatus']}"
            f"{' (' + r['failureReason'] + ')' if r['failureReason'] else ''} | {r['complete']} | {r['accepted']} | {r['soldOut']} | {r['failed']} | "
            f"{r['latency']['all']['p95']:.2f} | {f(r['allAnsweredS'])} | {f(r['soldOutS'])} | {f(r['allConfirmedS'])} |"
        )


main()
