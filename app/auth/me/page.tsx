import Link from "next/link";
import { neonAuth } from "@/lib/auth/neon-server";

export const dynamic = "force-dynamic";

export default async function NeonAuthMePage() {
  const { data: session } = await neonAuth.getSession();
  const user = session?.user;

  if (!user) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-canvas px-4">
        <h1 className="text-2xl font-semibold text-fg">Not signed in</h1>
        <div className="flex gap-3 text-accent-strong">
          <Link href="/auth/sign-up" className="underline">
            Sign up
          </Link>
          <Link href="/auth/sign-in" className="underline">
            Sign in
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 bg-canvas px-4">
      <h1 className="text-2xl font-semibold text-fg">Signed in</h1>
      <p className="text-muted">Name: {user.name}</p>
      <p className="text-muted">Email: {user.email}</p>
      <p className="text-subtle text-sm">User id: {user.id}</p>
    </main>
  );
}
