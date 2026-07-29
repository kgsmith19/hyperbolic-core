import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import Login from "./Login";
import { supabase } from "../auth/supabase";
import { renderWithProviders, setupUser } from "../test-utils";

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
    const user = setupUser();
    signIn.mockResolvedValue({ data: {}, error: null } as never);
    renderLogin();
    await user.type(screen.getByLabelText(/email/i), "kyle@example.com");
    await user.type(screen.getByLabelText(/password/i), "hunter2!");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    expect(signIn).toHaveBeenCalledWith({
      email: "kyle@example.com",
      password: "hunter2!",
    });
    expect(await screen.findByText("home")).toBeInTheDocument();
  });

  it("shows the auth error on failure", async () => {
    const user = setupUser();
    signIn.mockResolvedValue({
      data: {},
      error: { message: "Invalid login credentials" },
    } as never);
    renderLogin();
    await user.type(screen.getByLabelText(/email/i), "kyle@example.com");
    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid login credentials",
    );
  });
});
