"""Profile the diagnostic suite: per-phase runtime, peak memory, and the
speedup from running all_diagnostics.AllDiagnostics.run_all()'s seven
phases concurrently instead of one after another.

Stdlib only: `time.perf_counter` for wall time, `tracemalloc` for memory
(cross-platform, unlike the Unix-only `resource` module -- this project's
primary target is Windows).

Usage:
    python tools/profile_diagnostics.py
    python tools/profile_diagnostics.py -f json
    python tools/profile_diagnostics.py --suite   # also time the test suite
"""
import argparse
import json
import subprocess
import sys
import time
import tracemalloc
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from netcheck import all_diagnostics  # noqa: E402


def _timed(fn):
    tracemalloc.start()
    t0 = time.perf_counter()
    fn()
    elapsed = time.perf_counter() - t0
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    return elapsed, peak


def profile_phases():
    """Time and memory-profile each phase individually, then the concurrent
    run_all(), so the report shows the actual speedup on this machine."""
    runner = all_diagnostics.AllDiagnostics()
    per_phase = {}
    for entry in all_diagnostics.PHASES:
        name = entry[0]
        elapsed, peak = _timed(lambda entry=entry: all_diagnostics.run_phase(entry))
        per_phase[name] = {"seconds": round(elapsed, 3), "peak_kb": round(peak / 1024, 1)}

    sequential_total = sum(p["seconds"] for p in per_phase.values())
    concurrent_elapsed, concurrent_peak = _timed(runner.run_all)

    return {
        "per_phase": per_phase,
        "sequential_total_seconds": round(sequential_total, 3),
        "run_all_concurrent_seconds": round(concurrent_elapsed, 3),
        "run_all_peak_kb": round(concurrent_peak / 1024, 1),
        "speedup_x": round(sequential_total / concurrent_elapsed, 2) if concurrent_elapsed else None,
    }


def profile_suite():
    """Time the full unittest suite as a subprocess (accurate wall time,
    isolated from this process's own import/profiling overhead)."""
    t0 = time.perf_counter()
    result = subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
        cwd=str(Path(__file__).resolve().parent.parent),
        capture_output=True, text=True, timeout=600,
    )
    elapsed = time.perf_counter() - t0
    return {
        "seconds": round(elapsed, 3),
        "passed": result.returncode == 0,
        "summary": result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "",
    }


def _print_text(report):
    print("\nPer-phase runtime and peak memory (each measured in isolation):\n")
    for name, stats in report["phases"]["per_phase"].items():
        print(f"  {name:<28} {stats['seconds']:>7.3f}s   {stats['peak_kb']:>9.1f} KB")
    print(f"\n  sequential total (sum of above):  {report['phases']['sequential_total_seconds']:.3f}s")
    print(f"  run_all() concurrent:              {report['phases']['run_all_concurrent_seconds']:.3f}s")
    print(f"  run_all() peak memory:             {report['phases']['run_all_peak_kb']:.1f} KB")
    if report["phases"]["speedup_x"]:
        print(f"  speedup from concurrency:          {report['phases']['speedup_x']}x")
    if "suite" in report:
        print(f"\nTest suite: {report['suite']['seconds']:.3f}s "
              f"({'passed' if report['suite']['passed'] else 'FAILED'})")
        if report["suite"]["summary"]:
            print(f"  {report['suite']['summary']}")
    print()


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("-f", "--format", choices=["text", "json"], default="text")
    p.add_argument("--suite", action="store_true", help="also time the full test suite")
    args = p.parse_args(argv)

    report = {"phases": profile_phases()}
    if args.suite:
        report["suite"] = profile_suite()

    if args.format == "json":
        print(json.dumps(report, indent=2))
    else:
        _print_text(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
