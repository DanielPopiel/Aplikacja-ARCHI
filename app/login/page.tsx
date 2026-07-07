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
    <main className="flex min-h-dvh items-center justify-center p-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm ring-1 ring-[#E8E8F0]"
      >
        <h1 className="mb-1 text-xl font-bold text-[#26275f]">
          <span className="text-orange-500">✦</span> ARCHI
        </h1>
        <p className="mb-5 text-sm text-[#8a8ba8]">Podaj hasło, aby korzystać z aplikacji.</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Hasło"
          autoFocus
          className="mb-3 w-full rounded-xl border border-[#E8E8F0] bg-white px-3 py-2 text-[#26275f] outline-none focus:border-orange-400"
        />
        {error && <p className="mb-3 text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-xl bg-orange-500 py-2 font-semibold text-white transition-colors hover:bg-orange-400 disabled:opacity-50"
        >
          {busy ? "Logowanie…" : "Zaloguj"}
        </button>
      </form>
    </main>
  );
}
