# Kernel cell

Owns: `src/kernel/**`, `supabase/migrations/**`, `tests/kernel/**`.

- Pure domain core; side effects live at the edges.
- Every public service is typed (Pydantic v2) and validates its inputs.
- Migrations are kernel-only; review every migration against invariant 1
  before it lands.
- The projection rebuild test must pass before any kernel merge.
- Every kernel behavior change lands with a test in `tests/kernel/`.
