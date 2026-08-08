import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import StartWork from "./pages/StartWork";
import Guards from "./pages/Guards";
import Spending from "./pages/Spending";
import Kernel from "./pages/Kernel";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 10_000, retry: 1 } },
});

// Dark mode: explicit choice persisted; default follows the OS.
const dark = () => document.documentElement.classList.contains("dark");
if (localStorage.theme === "dark" || (!localStorage.theme && matchMedia("(prefers-color-scheme: dark)").matches)) {
  document.documentElement.classList.add("dark");
}
function ThemeToggle() {
  return (
    <Button variant="ghost" size="icon" aria-label="toggle theme" onClick={() => {
      document.documentElement.classList.toggle("dark");
      localStorage.theme = dark() ? "dark" : "light";
    }}>
      <Sun className="size-4 dark:hidden" /><Moon className="size-4 hidden dark:block" />
    </Button>
  );
}

const tabs = [
  { to: "/", label: "Start work" },
  { to: "/guards", label: "Guards" },
  { to: "/spending", label: "Spending" },
  { to: "/kernel", label: "Kernel" },
];

function Shell() {
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <header className="mb-6 flex items-center gap-1">
        <h1 className="mr-4 text-lg font-semibold tracking-tight">Command Center</h1>
        <nav className="flex gap-1">
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.to === "/"} className={({ isActive }) =>
              cn("rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                 isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground")}>
              {t.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto"><ThemeToggle /></div>
      </header>
      <Routes>
        <Route path="/" element={<StartWork />} />
        <Route path="/guards" element={<Guards />} />
        <Route path="/spending" element={<Spending />} />
        <Route path="/kernel" element={<Kernel />} />
      </Routes>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter><Shell /></BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
