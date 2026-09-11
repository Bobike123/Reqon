// Shown instead of the app when the build has no Supabase settings. Plain
// markup on purpose: nothing here may depend on the parts that are missing.
export function ConfigMissing({ names }: { names: readonly string[] }) {
  const local = ['localhost', '127.0.0.1'].includes(window.location.hostname)
  return (
    <main id="main-content" className="mx-auto max-w-xl px-4 py-12 text-slate-900">
      <h1 className="text-xl font-semibold text-balance">Paddock Control can’t reach its database</h1>
      <p className="mt-2 text-sm text-slate-700">
        This copy of the app was built without{' '}
        {names.map((name, i) => (
          <span key={name}>
            {i > 0 && ' and '}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">{name}</code>
          </span>
        ))}
        , so it does not know which Supabase project to use.
      </p>
      {local ? (
        <p className="mt-4 text-sm text-slate-700">
          Put both values in <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">.env.local</code>{' '}
          and restart <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">npm run dev</code>.
        </p>
      ) : (
        <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-slate-700">
          <li>
            In your host (Vercel: Settings → Environment Variables), add{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">VITE_SUPABASE_URL</code> and{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">VITE_SUPABASE_ANON_KEY</code>.
          </li>
          <li>Redeploy. The values are built into the site, so nothing changes until the next build.</li>
        </ol>
      )}
      <p className="mt-4 text-xs text-slate-600">
        Both values are in Supabase → Project Settings → API. Never use the secret or service_role key here.
      </p>
    </main>
  )
}
