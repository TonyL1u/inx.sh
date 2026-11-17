import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={
        'inline-flex h-10 items-center justify-center rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 ' +
        className
      }
      {...props}
    />
  );
}

export function Field({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      <input className="h-10 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10 dark:border-zinc-700 dark:bg-zinc-900 dark:focus:border-zinc-300" {...props} />
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export function ErrorText({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
      {children}
    </p>
  );
}

export function AuthCard({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-2">
          <p className="text-sm font-semibold tracking-wide text-zinc-500">映界 INX Connect</p>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">{description}</p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">{children}</div>
      </div>
    </main>
  );
}

export function Placeholder({ title, description }: { title: string; description: string }) {
  return (
    <section className="space-y-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="rounded-xl border border-dashed border-zinc-300 px-6 py-16 text-center text-sm text-zinc-500 dark:border-zinc-700">{description}</div>
    </section>
  );
}
