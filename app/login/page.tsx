"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Logowanie nie powiodło się");
        return;
      }
      router.push("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-neutral-950 p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-neutral-800 bg-neutral-900 p-6"
      >
        <h1 className="mb-1 text-xl font-semibold text-white">ARCHI</h1>
        <p className="mb-5 text-sm text-neutral-400">Podaj hasło, aby korzystać z aplikacji.</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Hasło"
          autoFocus
          className="mb-3 w-full rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-white outline-none focus:border-emerald-500"
        />
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-lg bg-emerald-600 py-2 font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? "Logowanie…" : "Zaloguj"}
        </button>
      </form>
    </main>
  );
}
