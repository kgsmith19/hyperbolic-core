/**
 * /tools route group placeholder. Registry-driven tool discovery from the
 * Toolbelt registry (docs/planning/05-a-hyperbolic-core.md section 4, TB-2)
 * ships in m3-04 -- explicitly out of scope for this issue.
 */
function ToolsPage() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
      <h2 className="text-xl font-semibold text-text">Tools</h2>
      <p className="text-sm text-text-secondary" data-testid="placeholder-note">
        Registry-driven tool discovery lands with m3-04. This is a placeholder page shell rendered
        inside the shared chrome.
      </p>
    </div>
  );
}

export default ToolsPage;
