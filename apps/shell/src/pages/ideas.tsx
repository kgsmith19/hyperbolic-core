/**
 * /ideas route group (m3-07, docs/planning/05-h-idea-intake.md section 8).
 * Mounted at "/ideas/*" (app.tsx), so this component owns its own nested
 * routing for the list, new-idea editor, and existing-idea editor.
 */
import { Route, Routes } from "react-router";
import IdeasListPage from "./ideas/list";
import IdeaEditorPage from "./ideas/editor";

function IdeasPage() {
  return (
    <Routes>
      <Route index element={<IdeasListPage />} />
      <Route path="new" element={<IdeaEditorPage mode="create" />} />
      <Route path=":id" element={<IdeaEditorPage mode="edit" />} />
    </Routes>
  );
}

export default IdeasPage;
