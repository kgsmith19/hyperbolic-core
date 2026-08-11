import { useState, type SubmitEvent } from "react";
import { Link } from "react-router";

import { streamChat, type ChatCitations } from "../api/client";

type Turn = {
  role: "user" | "assistant";
  content: string;
  citations?: ChatCitations;
};

export default function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || pending !== null) return;
    setDraft("");
    setError(null);
    const before = turns;
    const history = [...before, { role: "user" as const, content: question }];
    setTurns(history);
    setPending("");

    let text = "";
    let failed = false;
    let citations: ChatCitations | undefined;
    try {
      await streamChat(
        history.map(({ role, content }) => ({ role, content })),
        (frame) => {
          if (frame.type === "text") {
            text += frame.delta;
            setPending(text);
          } else if (frame.type === "tool") {
            setActivity(`checking ${frame.name}…`);
          } else if (frame.type === "done") {
            citations = frame.citations;
          } else {
            failed = true;
            setError(frame.detail);
          }
        },
      );
    } catch (requestError) {
      failed = true;
      setError(String(requestError));
    } finally {
      setPending(null);
      setActivity(null);
    }

    // Only a real answer may enter the history. An error frame (or a stream
    // that ends with no text) would otherwise leave an empty assistant turn
    // behind, and /chat rejects empty content — every later send would 422.
    if (!failed && text) {
      setTurns([...history, { role: "assistant", content: text, citations }]);
      return;
    }
    // Nothing usable came back: roll the turn back out of the history and hand
    // the question back to the box. A transient failure must not eat what the
    // owner typed — there is no undo for that.
    setTurns(before);
    setDraft(question);
    if (!failed) setError("No answer came back — ask again.");
  }

  return (
    <div className="space-y-4">
      <ol className="space-y-3">
        {turns.map((turn, index) => (
          <li key={index} className={turn.role === "user" ? "text-right" : ""}>
            <div
              className={`inline-block max-w-[85%] whitespace-pre-wrap rounded-lg border px-3 py-2 text-left text-sm ${
                turn.role === "user"
                  ? "border-zinc-300 bg-zinc-100"
                  : "border-zinc-200 bg-white"
              }`}
            >
              {turn.content}
              {turn.citations && turn.citations.entity_ids.length > 0 && (
                <p className="mt-2 border-t border-zinc-100 pt-1 text-xs text-zinc-500">
                  Sources:{" "}
                  {turn.citations.entity_ids.map((id) => (
                    <Link
                      key={id}
                      to={`/entities/${id}`}
                      className="mr-1 text-blue-700 hover:underline"
                    >
                      {id.slice(0, 8)}
                    </Link>
                  ))}
                  {turn.citations.event_ids.length > 0 &&
                    `· ${turn.citations.event_ids.length} events`}
                </p>
              )}
            </div>
          </li>
        ))}
        {pending !== null && (
          <li>
            <div className="inline-block max-w-[85%] whitespace-pre-wrap rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm">
              {pending || "…"}
            </div>
          </li>
        )}
      </ol>
      {activity && <p className="text-xs text-zinc-500">{activity}</p>}
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <form onSubmit={(event) => void onSubmit(event)} className="flex gap-2">
        <input
          name="question"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask about your data…"
          autoComplete="off"
          className="flex-1 rounded border border-zinc-300 px-2 py-1.5"
        />
        <button
          type="submit"
          disabled={pending !== null}
          className="rounded bg-zinc-900 px-3 text-white disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}
