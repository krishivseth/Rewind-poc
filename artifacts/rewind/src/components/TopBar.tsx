import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { api } from '../api'
import { fmtTokens } from '../lib/steps'

export default function TopBar({ children }: { children?: ReactNode }) {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 30_000 })
  const s = stats.data
  const pct = s ? Math.min(100, Math.round((s.tokens_used_today / s.daily_token_cap) * 100)) : 0
  return (
    <header className="flex h-10 shrink-0 items-center gap-4 border-b border-line bg-panel px-3">
      <Link to="/" className="flex items-center gap-2 mono text-[11px] uppercase tracking-[.2em] text-ink hover:text-accent">
        <span className="inline-block h-2 w-2 bg-accent" />rewind
      </Link>
      {children}
      {s && (
        <span className="mono text-[11px] text-faint flex items-center gap-2 shrink-0" title={`${s.tokens_used_today.toLocaleString()} of ${s.daily_token_cap.toLocaleString()} tokens spent today`}>
          <span className="inline-block h-1.5 w-16 rounded-sm bg-line overflow-hidden">
            <span className="block h-full" style={{ width: `${pct}%`, background: pct > 80 ? 'var(--color-bad)' : 'var(--color-muted)' }} />
          </span>
          {fmtTokens(s.tokens_used_today)} / {fmtTokens(s.daily_token_cap)} today
        </span>
      )}
    </header>
  )
}
