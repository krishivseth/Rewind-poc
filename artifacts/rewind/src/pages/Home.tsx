import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, isLive } from '../api'
import DeleteSession from '../components/DeleteSession'
import { KIND_COLOR } from '../lib/steps'
import NewSessionForm from '../components/NewSessionForm'
import TopBar from '../components/TopBar'
import TreeSketch from '../components/TreeSketch'
import { shortModel } from '../lib/steps'
import { useAuth } from '../store'

export default function Home() {
  const q = useQuery({
    queryKey: ['sessions'], queryFn: api.sessions,
    refetchInterval: (query) => (query.state.data?.some((s) => s.branches.some((b) => isLive(b.status))) ? 4000 : 30000),
  })
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const search = useQuery({ queryKey: ['search', submitted], queryFn: () => api.search(submitted), enabled: submitted.length >= 2 })
  const key = useAuth((s) => s.key)
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const publicMode = !key && stats.data?.public_writes === 'cheap'
  // the session with the most branches is the best first thing to open
  const featured = q.data && q.data.length ? [...q.data].sort((a, b) => b.branch_count - a.branch_count)[0] : undefined
  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <span className="text-[13px] text-muted">Sessions</span>
        <form className="flex items-center gap-1 ml-2" onSubmit={(e) => { e.preventDefault(); setSubmitted(query.trim()) }}>
          <input className="field w-64 py-1" placeholder="Search tool output, arguments, notes" value={query} onChange={(e) => setQuery(e.target.value)} />
          {submitted && <button type="button" className="btn" onClick={() => { setQuery(''); setSubmitted('') }}>Clear</button>}
        </form>
        <span className="ml-auto flex items-center gap-2">
          {key && <span className="text-[11px] text-faint">key entered</span>}
          <button className="btn btn-accent" onClick={() => setCreating((c) => !c)}>{key || publicMode ? 'New session' : 'Enter access key'}</button>
        </span>
      </TopBar>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[820px] p-4 space-y-3">
          <section className="border border-line bg-panel px-5 py-4 space-y-2">
            <p className="text-[15px] text-ink">Rewind records a coding agent step by step, so you can scrub back to any moment, see exactly what the model saw, and fork from there.</p>
            <p className="text-[13px] text-muted">
              Open a session, drag the scrubber, press <kbd>C</kbd> for the model's context, then <kbd>F</kbd> to fork it with another model or prompt and watch both runs side by side.
              Under a branch with forks, "compare" lines them up and marks where they diverged.
            </p>
            <p className="text-[13px] text-muted flex flex-wrap items-center gap-x-3 gap-y-1">
              {featured && <Link to={`/sessions/${featured.id}`} className="btn btn-accent">Start here: {featured.title}</Link>}
              {publicMode && <span>Visitors can start sessions and forks on {stats.data?.cheap_model?.split('/').pop()} without a key.</span>}
            </p>
          </section>
          {creating && <NewSessionForm onClose={() => setCreating(false)} />}
          {submitted.length >= 2 && (
            <div className="border border-line rounded bg-panel">
              <div className="pane-title">
                <span className="text-ink">Results for "{submitted}"</span>
                {search.data && <span className="text-faint">{search.data.results.length}{search.data.results.length === 50 ? '+' : ''}</span>}
              </div>
              {search.isLoading && <p className="p-3 text-[12px] text-muted">Searching…</p>}
              {search.error && <p className="p-3 text-[12px] text-bad">{(search.error as Error).message}</p>}
              {search.data?.results.length === 0 && <p className="p-3 text-[12px] text-muted">Nothing matched. Search is a plain substring match over tool output, tool arguments, model text and notes.</p>}
              <ul>
                {search.data?.results.map((h, i) => (
                  <li key={i} className="border-t border-line">
                    <Link to={`/sessions/${h.session_id}?branch=${h.branch_id}&step=${h.step_index}`} className="block px-3 py-2 hover:bg-raised">
                      <div className="flex items-center gap-2 text-[11px] mono text-muted">
                        <span className="inline-block h-1.5 w-1.5 rounded-sm" style={{ background: KIND_COLOR[h.kind] }} />
                        <span className="text-ink">{h.session_title}</span>
                        <span>{shortModel(h.model_id)}</span>
                        <span>step {h.step_index}</span>
                        {h.tool_name && <span>{h.tool_name}</span>}
                      </div>
                      <pre className="mt-1 mono text-[11px] text-muted whitespace-pre-wrap break-words line-clamp-3">{h.snippet}</pre>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {q.isLoading && <p className="text-muted text-[12px]">Loading…</p>}
          {q.error && <p className="text-bad text-[12px]">Could not load sessions: {(q.error as Error).message}</p>}
          {q.data?.length === 0 && (
            <div className="border border-line rounded bg-panel p-6 text-[12px] text-muted">
              No sessions yet. Start one to record an agent run, then fork it from any step.
            </div>
          )}
          {q.data && q.data.length > 0 && (
            <p className="text-[12px] text-muted">
              {q.data.length} session{q.data.length === 1 ? '' : 's'}, {q.data.reduce((n, s) => n + s.branch_count, 0)} branches
              {(() => { const r = q.data.reduce((n, s) => n + s.branches.filter((b) => isLive(b.status)).length, 0); return r ? `, ${r} running` : '' })()}
            </p>
          )}
          <ul className="space-y-2">
            {q.data?.map((s) => {
              const live = s.branches.filter((b) => isLive(b.status)).length
              return (
                <li key={s.id} className="relative">
                  <Link to={`/sessions/${s.id}`} className="grid grid-cols-[1fr_auto] items-center gap-6 border border-line rounded bg-panel px-4 py-3 hover:border-muted">
                    <div className="min-w-0 space-y-1">
                      <div className="text-[14px] text-ink truncate" title={s.title}>{s.title}</div>
                      <div className="mono text-[11px] text-muted flex gap-4">
                        <span>{s.repo_slug}</span>
                        <span>{s.model_id ? shortModel(s.model_id) : ''}</span>
                        <span className="text-faint">{s.branch_count} branch{s.branch_count === 1 ? '' : 'es'}</span>
                        {live > 0 && <span className="text-accent">{live} running</span>}
                        <span className="text-faint">{new Date(s.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                      </div>
                    </div>
                    <TreeSketch branches={s.branches} width={240} />
                  </Link>
                  {/* sibling of the link, not a child: buttons inside anchors are invalid and click-through prone */}
                  <div className="absolute right-4 bottom-3 flex items-center">
                    <DeleteSession sessionId={s.id} branchCount={s.branch_count} compact onDone={() => void q.refetch()} />
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      </div>
    </div>
  )
}
