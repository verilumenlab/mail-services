"use server";

import { neonAuth } from "@/lib/auth/neon-server";
import { redirect } from "next/navigation";

export async function signUpWithEmail(
  _prevState: { error: string } | null,
  formData: FormData,
) {
  const email = String(formData.get("email") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email) return { error: "Email address must be provided." };
  if (!name) return { error: "Name must be provided." };
  if (password.length < 8) return { error: "Password must be at least 8 characters." };

  const { error } = await neonAuth.signUp.email({ email, name, password });
  if (error) return { error: error.message || "Failed to create account" };

  redirect("/auth/me");
}
