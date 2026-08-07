# Contributing

## Standards

This project follows PDD (Property-Driven Development), SDD
(Specification-Driven Development), and TDD with hard red-green gates. In
practice:

1. **Write the test first.** Add it to the relevant `tests/test_*.py`, run
   it, and confirm it fails for the right reason (missing function, wrong
   value — not a typo).
2. **Write the minimum code to pass it.** No speculative features, no
   handling for scenarios the task doesn't call for.
3. **Run the full suite before committing.** `python -m unittest discover -s
   tests -t .` — every commit in this repo's history is green.

No pip dependencies, ever — see `AGENTS.md`. If a feature seems to need a
package, find the standard-library path or leave it out of scope.

## Adding a new diagnostic module

Follow the shape every existing hypothesis-specific module already uses
(`wifi_diagnostics.py`, `modem_diagnostics.py`, etc. — see `API.md` for the
full list):

1. **Pick which hypothesis it addresses.** Check the canonical 15-item list
   in `TROUBLESHOOTING.md` first — if it's genuinely new ground, it's an
   addition alongside the 15 (like Phases 16-21), not hypothesis #16. Number
   things honestly: several existing modules cite a `#N` hypothesis in their
   docstring that doesn't match the canonical list (a documentation bug from
   an earlier session, only partly cleaned up) — don't repeat that mistake.
2. **Write pure functions over data, plus a thin `*Diagnostics` class.**
   Free functions (`get_wan_ip()`, `is_cgnat_ip(ip)`, ...) should take plain
   values and return plain values/dicts, so tests can call them directly
   with no mocking. The class wraps them into the `hypothesis`/detail-keys
   dict shape `all_diagnostics.py` expects (see any existing
   `run_phase_NN_*` method for the shape).
3. **Every measured field is `state: ok | fail | unavailable` — never
   collapse `unavailable` into `fail`.** A missing credential, absent
   binary, or unreachable device is `unavailable`. This is the single most
   enforced rule in the codebase (`test_environ.py`, `test_diagnose.py`) —
   the whole point of the three-state model is that the ranking engine
   refuses to cite `unavailable` as evidence of a fault.
4. **Any command-output parsing takes a string, returns a dict, and ships a
   captured fixture in `tests/fixtures/`.** Never shell out inside a test.
   This is what makes a new platform backend additive instead of a rewrite.
5. **Any subprocess/PowerShell call with a caller-supplied value must not
   build the command by string interpolation** — a value containing a quote
   character can escape the string and append arbitrary commands. Pass
   values as command arguments (an argv list, or `-Args`), never interpolate
   into a shell string.
6. **Wire it into `all_diagnostics.py`** — add a `run_phase_NN_<name>`
   method following the existing pattern, add it to `run_all()`, and update
   `get_quick_diagnosis()` if it deserves a one-line summary.
7. **Test the class the same way `test_all_diagnostics.py` tests the
   others:** assert the return type, and assert the specific keys the
   diagnosis needs (`hypothesis`, plus one entry per method).

## Adding a fix

Local OS-level fixes live in `tools/fix_*.sh`, orchestrated by
`tools/run_fixes.sh` — each supports `--dry-run` and prints what it would
change before touching anything. A fix that touches the router or modem
goes through the authenticated HTTP flow in `environ._asus_login`/
`_asus_get` — never a hardcoded raw request, and never Basic Auth against
ASUS gear (it silently "succeeds" without proving anything actually
changed).

## Documentation

- New public function or class → a one-line docstring stating what it
  returns, not what it does internally (the code already says that).
- New module → add it to the module map and the right section of `API.md`.
- New hypothesis or symptom → add a row to `TROUBLESHOOTING.md`.
- Changed CLI behavior → update `QUICKSTART.md`.

Run `python tools/documentation_check.py . -i medium` before committing —
it catches missing docstrings and leftover template placeholders (`[TBD]`,
`[TODO]`).

## Code quality gates

Same checks CI runs, runnable locally:

```bash
python tools/code_simplification.py netcheck -i medium   # function length / complexity
python tools/security_review.py . -i high                 # secrets, injection, unsafe calls
python tools/documentation_check.py . -i medium            # docstrings, README, no scaffolding
```

See `tools/README.md` for intensity levels and what each rule catches.

## Git workflow

1. Branch from `main`.
2. Add the failing test, then the code that makes it pass.
3. `python -m unittest discover -s tests -t .` — must be green.
4. Commit with a message describing *why*, not just *what*.
5. Push and open a pull request.

## Pull request checklist

- [ ] Test added before the code, and it failed first for the right reason
- [ ] Full suite passes locally
- [ ] No `state: fail` reported for something merely `unavailable`
- [ ] No pip dependency introduced
- [ ] No shell string built by interpolating a caller-supplied value
- [ ] Docs updated (`API.md`, `TROUBLESHOOTING.md`, or `QUICKSTART.md` as applicable)
