/**
 * /prompts route group placeholder. Real content (Prompt Organizer surface)
 * is owned by docs/planning/05-d-prompt-organizer.md -- out of scope here.
 */
function PromptsPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
      <h2 className="text-xl font-semibold text-text">Prompts</h2>
      <p className="text-sm text-text-secondary" data-testid="placeholder-note">
        Prompt Organizer content lands per docs/planning/05-d-prompt-organizer.md. This is a
        placeholder page shell rendered inside the shared chrome.
      </p>
    </div>
  );
}

export default PromptsPage;
