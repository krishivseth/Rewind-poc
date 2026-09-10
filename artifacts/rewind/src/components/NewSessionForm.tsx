import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth, useSelection } from '../store'
import AccessKeyPrompt from './AccessKeyPrompt'

export default function NewSessionForm({ onClose }: { onClose: () => void }) {
  const key = useAuth((s) => s.key)
  const repos = useQuery({ queryKey: ['repos'], queryFn: api.repos })
  const models = useQuery({ queryKey: ['models'], queryFn: api.models })
  const [repoId, setRepoId] = useState('')
  const [modelId, setModelId] = useState('')
  const [task, setTask] = useState('')
  const [title, setTitle] = useState('')
  const nav = useNavigate()
  const qc = useQueryClient()
  const selectBranch = useSelection((s) => s.selectBranch)

  const repo = repos.data?.find((r) => r.id === (repoId || repos.data?.[0]?.id))
  const model = modelId || models.data?.find((m) => m.cheap)?.id || models.data?.[0]?.id || ''

  const create = useMutation({
    mutationFn: () => api.createSession({
      repo_id: repo!.id, model_id: model, task_prompt: task.trim(),
      title: title.trim() || `${repo!.slug}: ${task.trim().slice(0, 60)}`,
    }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['sessions'] })
      selectBranch(res.root_branch_id)
      nav(`/sessions/${res.id}`)
    },
  })

  return (
    <div className="border border-line rounded bg-panel">
      <div className="pane-title"><span className="text-ink">New session</span><button className="btn ml-auto" onClick={onClose}>Close</button></div>
      <div className="p-3">
        {!key ? <AccessKeyPrompt compact /> : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (repo && task.trim()) create.mutate() }}>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-[11px] text-muted">Repository</span>
                <select className="field mono" value={repo?.id ?? ''} onChange={(e) => setRepoId(e.target.value)}>
                  {repos.data?.map((r) => <option key={r.id} value={r.id}>{r.slug}</option>)}
                </select>
                {repo && <p className="text-[11px] text-faint">{repo.description}</p>}
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] text-muted">Model</span>
                <select className="field mono" value={model} onChange={(e) => setModelId(e.target.value)}>
                  {models.data?.map((m) => <option key={m.id} value={m.id}>{m.name}{m.cheap ? ' (cheap)' : ''}</option>)}
                </select>
              </label>
            </div>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">Task for the agent</span>
              <textarea className="field min-h-[80px] resize-y" placeholder="Make all tests pass" value={task} onChange={(e) => setTask(e.target.value)} autoFocus />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">Title <span className="text-faint">optional</span></span>
              <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={repo && task ? `${repo.slug}: ${task.slice(0, 60)}` : ''} />
            </label>
            {create.error && <p className="text-[12px] text-bad">{(create.error as Error).message}</p>}
            <div className="flex items-center gap-3">
              <button className="btn btn-accent" disabled={create.isPending || !repo || !task.trim()}>{create.isPending ? 'Starting…' : 'Start session'}</button>
              <span className="text-[11px] text-faint">Runs up to 30 model calls, then stops. Fork it from any step afterwards.</span>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
