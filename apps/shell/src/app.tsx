import { Route, Routes } from "react-router";
import ProtectedLayout from "./components/protected-layout";
import { useShellSession } from "./lib/session";
import LoginPage from "./pages/login";
import HomePage from "./pages/home";
import AccPage from "./pages/acc";
import ToolsPage from "./pages/tools";
import PromptsPage from "./pages/prompts";
import IdeasPage from "./pages/ideas";
import SettingsPage from "./pages/settings";
import NotFoundPage from "./pages/not-found";

/**
 * Route tree (docs/planning/05-a-hyperbolic-core.md section 4): every route
 * except /login is a child of ProtectedLayout, which is the single login
 * gate (SH-2a/SH-2b) every one of them passes through -- this issue's own
 * risk note calls that gate "the single auth chokepoint for every zone".
 * /login is the one route that must render for a signed-out operator, so it
 * sits outside the gate.
 */
function App() {
  const { status, session, signIn, signOut } = useShellSession();

  return (
    <Routes>
      <Route path="/login" element={<LoginPage status={status} onSignIn={signIn} />} />
      <Route element={<ProtectedLayout status={status} session={session} onSignOut={signOut} />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/acc/*" element={<AccPage />} />
        <Route path="/tools/*" element={<ToolsPage />} />
        <Route path="/prompts/*" element={<PromptsPage />} />
        <Route path="/ideas/*" element={<IdeasPage />} />
        <Route
          path="/settings"
          element={
            // Non-null assertion: ProtectedLayout's own gate (see
            // computeGateDecision) never renders its <Outlet/> -- and
            // therefore never mounts this element -- for any status other
            // than "signed-in", at which point `session` is always a real
            // PlatformSession, never null. React.createElement below merely
            // builds the element descriptor; it isn't rendered unless that
            // invariant holds.
            <SettingsPage session={session as NonNullable<typeof session>} onSignOut={signOut} />
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export default App;
