import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router";

import { supabase } from "./auth/supabase";
import { useSession } from "./auth/useSession";
import HealthDot from "./components/HealthDot";
import Login from "./pages/Login";

// Login is the only page on the first-paint path, so it stays eager and the
// authenticated pages split into their own chunks — the initial bundle no
// longer grows with every page added to the app.
const Approvals = lazy(() => import("./pages/Approvals"));
const Browse = lazy(() => import("./pages/Browse"));
const Capture = lazy(() => import("./pages/Capture"));
const Chat = lazy(() => import("./pages/Chat"));
const EntityDetail = lazy(() => import("./pages/EntityDetail"));
const Tomorrow = lazy(() => import("./pages/Tomorrow"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1 } },
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="flex items-center gap-4 border-b border-zinc-200 bg-white px-4 py-2">
        <Link to="/" className="font-semibold">
          lifeos
        </Link>
        <nav className="flex gap-3 text-sm">
          <Link to="/" className="hover:underline">
            Browse
          </Link>
          <Link to="/capture" className="hover:underline">
            Capture
          </Link>
          <Link to="/chat" className="hover:underline">
            Chat
          </Link>
          <Link to="/tomorrow" className="hover:underline">
            Tomorrow
          </Link>
          <Link to="/approvals" className="hover:underline">
            Approvals
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <HealthDot />
          <button
            onClick={() => void supabase.auth.signOut()}
            className="text-sm text-zinc-500 hover:underline"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-3xl p-4">{children}</main>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();
  if (loading) return null;
  if (!session) return <Navigate to="/login" replace />;
  // The shell stays put while a route chunk arrives — the nav never blinks.
  return (
    <Shell>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
        {children}
      </Suspense>
    </Shell>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <Browse />
              </RequireAuth>
            }
          />
          <Route
            path="/capture"
            element={
              <RequireAuth>
                <Capture />
              </RequireAuth>
            }
          />
          <Route
            path="/chat"
            element={
              <RequireAuth>
                <Chat />
              </RequireAuth>
            }
          />
          <Route
            path="/tomorrow"
            element={
              <RequireAuth>
                <Tomorrow />
              </RequireAuth>
            }
          />
          <Route
            path="/entities/:id"
            element={
              <RequireAuth>
                <EntityDetail />
              </RequireAuth>
            }
          />
          <Route
            path="/approvals"
            element={
              <RequireAuth>
                <Approvals />
              </RequireAuth>
            }
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
