import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

/**
 * userEvent without its per-keystroke real-timer wait. Those waits are real
 * wall-clock time: under fork-pool/filesystem contention a few multi-character
 * `type()` calls are enough to blow any test's timeout, whatever it asserts.
 */
export const setupUser = () => userEvent.setup({ delay: null });

export function renderWithProviders(ui: ReactNode, { route = "/" } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}
