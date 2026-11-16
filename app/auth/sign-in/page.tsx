"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signInWithEmail } from "./actions";

export default function NeonSignInPage() {
  const [state, formAction, isPending] = useActionState(signInWithEmail, null);

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <form action={formAction} className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-line bg-panel p-6">
        <h1 className="text-xl font-semibold text-fg">Sign in</h1>
        <p className="text-sm text-muted">Neon Managed Better Auth.</p>

        <label className="flex flex-col gap-1 text-sm text-fg">
          Email
          <input name="email" type="email" required className="rounded-md border border-line bg-canvas px-3 py-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm text-fg">
          Password
          <input name="password" type="password" required className="rounded-md border border-line bg-canvas px-3 py-2" />
        </label>

        {state?.error ? <p className="text-sm text-red-500">{state.error}</p> : null}

        <button type="submit" disabled={isPending} className="rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
          {isPending ? "Signing in…" : "Sign in"}
        </button>

        <p className="text-sm text-muted">
          Need an account?{" "}
          <Link href="/auth/sign-up" className="text-accent-strong underline">
            Sign up
          </Link>
        </p>
      </form>
    </main>
  );
}
