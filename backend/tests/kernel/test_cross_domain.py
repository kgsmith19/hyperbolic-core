"""Acceptance 2: cross-domain query through kernel services only."""

from datetime import UTC, datetime
from uuid import UUID

from kernel.access import AccessContext
from kernel.services import find, get_entity


def test_workouts_in_range_joined_to_performer(
    seeded: dict[str, UUID], ctx: AccessContext
) -> None:
    start = datetime(2026, 7, 19, tzinfo=UTC)
    end = datetime(2026, 7, 21, tzinfo=UTC)

    workouts = [
        w
        for w in find(ctx, type_name="workout")
        if start <= datetime.fromisoformat(w.attributes["started_at"]) <= end
    ]
    assert [w.id for w in workouts] == [seeded["run"]]

    performers: list[str] = []
    for workout in workouts:
        view = get_entity(ctx, workout.id)
        for edge in view.edges_out:
            if edge.relation == "performed_by":
                person = get_entity(ctx, edge.to_entity)
                performers.append(person.entity.attributes["full_name"])
    assert performers == ["Kyle Smith"]
