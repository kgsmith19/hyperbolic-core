import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import Login from "./Login";
import { supabase } from "../auth/supabase";
import { renderWithProviders } from "../test-utils";

vi.mock("../auth/supabase", () => ({
  supabase: { auth: { signInWithPassword: vi.fn() } },
}));

const signIn = vi.mocked(supabase.auth.signInWithPassword);

function renderLogin() {
  renderWithProviders(
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<p>home</p>} />
    </Routes>,
    { route: "/login" },
  );
}

describe("Login", () => {
  it("navigates home on successful sign-in", async () => {
    signIn.mockResolvedValue({ data: {}, error: null } as never);
    renderLogin();
    await userEvent.type(screen.getByLabelText(/email/i), "kyle@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "hunter2!");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(signIn).toHaveBeenCalledWith({
      email: "kyle@example.com",
      password: "hunter2!",
    });
    expect(await screen.findByText("home")).toBeInTheDocument();
  });

  it("shows the auth error on failure", async () => {
    signIn.mockResolvedValue({
      data: {},
      error: { message: "Invalid login credentials" },
    } as never);
    renderLogin();
    await userEvent.type(screen.getByLabelText(/email/i), "kyle@example.com");
    await userEvent.type(screen.getByLabelText(/password/i), "wrong");
    await userEvent.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid login credentials",
    );
  });
});
