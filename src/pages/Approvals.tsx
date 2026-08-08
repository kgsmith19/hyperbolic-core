// The C4 approval loop (ADR 018): review a proposed dispute draft, approve or
// reject it. A proposal's draft text is readable in this listing only while
// it is "proposed" — the backend never renders `body` for a decided one, on
// purpose (an ungated re-render would be a second door around the receipt
// gate). So an approved proposal's letter comes only from the gated
// GET .../draft, fetched below, and a rejected or withdrawn one shows no
// letter at all: there is nothing left to authorise.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";

import {
  approveProposal,
  getApprovedDraft,
  listProposals,
  rejectProposal,
  type ProposalView,
} from "../api/client";
import { Empty } from "../components/BriefingSections";

function GatedDraft({ proposalId }: { proposalId: string }) {
  // Exercises the gate on every view, not just once: an authority receipt
  // expires after 7 days, and re-checking is how that becomes visible.
  const draft = useQuery({
    queryKey: ["draft", proposalId],
    queryFn: () => getApprovedDraft(proposalId),
  });
  if (draft.isPending) return <p className="text-sm text-zinc-400">Loading…</p>;
  if (draft.isError)
    return <p className="text-sm text-red-600">{String(draft.error)}</p>;
  return (
    <p className="whitespace-pre-wrap rounded bg-zinc-50 p-2 text-sm text-zinc-700">
      {draft.data.body}
    </p>
  );
}

function Proposal({ view }: { view: ProposalView }) {
  const queryClient = useQueryClient();
  const onDecided = () =>
    void queryClient.invalidateQueries({ queryKey: ["proposals"] });
  const approve = useMutation({
    mutationFn: () =>
      approveProposal(view.proposal_id, view.draft_digest ?? ""),
    onSuccess: onDecided,
  });
  const reject = useMutation({
    mutationFn: () => rejectProposal(view.proposal_id),
    onSuccess: onDecided,
  });

  return (
    <li className="rounded-lg border border-zinc-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{view.kind}</span>
        <span className="text-zinc-500 uppercase">{view.state}</span>
        {view.unresolved_count > 0 && (
          <span className="text-amber-600">
            {view.unresolved_count} unresolved
          </span>
        )}
        {view.subject_ids.map((id) => (
          <Link
            key={id}
            to={`/entities/${id}`}
            className="text-blue-700 hover:underline"
          >
            {id.slice(0, 8)}
          </Link>
        ))}
      </div>

      {view.state === "proposed" && (
        <>
          <p className="mt-2 whitespace-pre-wrap text-sm text-zinc-700">
            {view.body}
          </p>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => approve.mutate()}
              disabled={approve.isPending}
              className="rounded bg-zinc-900 px-3 py-1 text-sm text-white disabled:opacity-50"
            >
              Approve
            </button>
            <button
              onClick={() => reject.mutate()}
              disabled={reject.isPending}
              className="rounded border border-red-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50"
            >
              Reject
            </button>
          </div>
          {(approve.error ?? reject.error) && (
            <p className="mt-2 text-sm text-red-600">
              {String(approve.error ?? reject.error)}
            </p>
          )}
        </>
      )}

      {view.state === "approved" && (
        <div className="mt-2">
          <GatedDraft proposalId={view.proposal_id} />
        </div>
      )}
    </li>
  );
}

export default function Approvals() {
  const proposals = useQuery({
    queryKey: ["proposals"],
    queryFn: listProposals,
  });

  if (proposals.isPending)
    return <p className="text-sm text-zinc-500">Loading…</p>;
  if (proposals.isError)
    return <p className="text-sm text-red-600">{String(proposals.error)}</p>;

  // Proposals awaiting a decision lead; already-decided ones (approved,
  // rejected, withdrawn) trail as history. A stable sort keeps each group in
  // the order the API returned it.
  const ordered = [...proposals.data].sort(
    (a, b) => Number(b.state === "proposed") - Number(a.state === "proposed"),
  );

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Approvals</h1>
      {ordered.length === 0 ? (
        <Empty>Nothing proposed — no drafts waiting on a decision.</Empty>
      ) : (
        <ul className="space-y-2">
          {ordered.map((view) => (
            <Proposal key={view.proposal_id} view={view} />
          ))}
        </ul>
      )}
    </div>
  );
}
