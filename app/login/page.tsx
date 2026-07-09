"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Logo from "@/components/Logo";

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
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-sm ring-1 ring-[#e8e6df]"
      >
        <div className="mb-1">
          <Logo variant="full" />
        </div>
        <p className="mb-5 text-sm text-[#8a887f]">Podaj hasło, aby korzystać z aplikacji.</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Hasło"
          autoFocus
          className="mb-3 w-full rounded-xl border border-[#e8e6df] bg-white px-3 py-2 text-[#1A1A1A] outline-none focus:border-[#b9a646]"
        />
        {error && <p className="mb-3 text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-xl bg-[#50344f] py-2 font-semibold text-white transition-colors hover:bg-[#684366] disabled:opacity-50"
        >
          {busy ? "Logowanie…" : "Zaloguj"}
        </button>
      </form>
    </main>
  );
}
