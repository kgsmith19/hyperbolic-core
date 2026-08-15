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
  const auth = useShellSession();

  return (
    <Routes>
      <Route path="/login" element={<LoginPage status={auth.status} onSignIn={auth.signIn} />} />
      <Route element={<ProtectedLayout auth={auth} onSignOut={auth.signOut} />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/acc/*" element={<AccPage />} />
        <Route path="/tools/*" element={<ToolsPage />} />
        <Route path="/prompts/*" element={<PromptsPage />} />
        <Route path="/ideas/*" element={<IdeasPage />} />
        <Route
          path="/settings"
          element={
            // Finding #77 (PR #8 security review): narrowing `auth.status`
            // directly here -- on the discriminated `AuthState` union
            // session.ts now returns -- is what lets TypeScript hand
            // SettingsPage a real, non-null `auth.session` with no cast.
            // The old `session as NonNullable<typeof session>` asserted
            // this same fact was true without the compiler ever checking
            // it. ProtectedLayout's own gate (computeGateDecision, mirrored
            // by its own `auth.status !== "signed-in"` narrowing check)
            // never renders this route's <Outlet/> content for any other
            // status, so the `else` branch below is never actually shown --
            // it exists only because <Routes> constructs every child
            // route's `element` expression on every render of <App>,
            // whatever the current status, so both arms of this ternary
            // must be valid elements.
            auth.status === "signed-in" ? (
              <SettingsPage session={auth.session} onSignOut={auth.signOut} />
            ) : (
              <NotFoundPage />
            )
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

export default App;
