# Interface cell

Owns: `src/api/**`, `tests/api/**`.

- Thin. No business logic.
- Calls kernel application services only; no direct DB access.
- DTOs are Pydantic models.
