"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signUpWithEmail } from "./actions";

export default function NeonSignUpPage() {
  const [state, formAction, isPending] = useActionState(signUpWithEmail, null);

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <form action={formAction} className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-line bg-panel p-6">
        <h1 className="text-xl font-semibold text-fg">Create account</h1>
        <p className="text-sm text-muted">Email and password via Neon Managed Better Auth.</p>

        <label className="flex flex-col gap-1 text-sm text-fg">
          Name
          <input name="name" type="text" required className="rounded-md border border-line bg-canvas px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm text-fg">
          Email
          <input name="email" type="email" required className="rounded-md border border-line bg-canvas px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm text-fg">
          Password
          <input name="password" type="password" required minLength={8} className="rounded-md border border-line bg-canvas px-3 py-2" />
        </label>

        {state?.error ? <p className="text-sm text-red-500">{state.error}</p> : null}

        <button type="submit" disabled={isPending} className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
          {isPending ? "Creating account…" : "Sign up"}
        </button>

        <p className="text-sm text-muted">
          Already have an account?{" "}
          <Link href="/auth/sign-in" className="text-accent-strong underline">
            Sign in
          </Link>
        </p>
      </form>
    </main>
  );
}
