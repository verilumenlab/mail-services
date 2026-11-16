"use server";

import { neonAuth } from "@/lib/auth/neon-server";
import { redirect } from "next/navigation";

export async function signInWithEmail(
  _prevState: { error: string } | null,
  formData: FormData,
) {
  const { error } = await neonAuth.signIn.email({
    email: String(formData.get("email") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
  });

  if (error) return { error: error.message || "Failed to sign in. Try again." };
  redirect("/auth/me");
}
