import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type Branch, type ForkResponse } from '../api'
import { useAuth, useSelection } from '../store'
import AccessKeyPrompt from './AccessKeyPrompt'

interface Props { branch: Branch; stepIndex: number; onClose: () => void }

export default function ForkPopover({ branch, stepIndex, onClose }: Props) {
  const key = useAuth((s) => s.key)
  const qc = useQueryClient()
  const models = useQuery({ queryKey: ['models'], queryFn: api.models })
  const [model, setModel] = useState(branch.model_id)
  const [prompt, setPrompt] = useState(branch.task_prompt)
  const [count, setCount] = useState(1)
  const [result, setResult] = useState<ForkResponse | null>(null)
  const selectBranch = useSelection((s) => s.selectBranch)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const fork = useMutation({
    mutationFn: () => api.fork(branch.id, {
      step_index: stepIndex, model_id: model, count,
      edited_task_prompt: prompt !== branch.task_prompt ? prompt : undefined,
    }),
    onSuccess: async (res) => {
      setResult(res)
      await qc.invalidateQueries({ queryKey: ['session', branch.session_id] })
    },
  })

  return (
    <div className="absolute left-3 right-3 top-[64px] z-30 md:left-auto md:w-[440px] rounded border border-line bg-panel shadow-2xl" role="dialog" aria-label="Fork">
      <div className="pane-title">
        <span className="text-ink">Fork from step {stepIndex}</span>
        <button className="btn ml-auto" onClick={onClose}>Close <kbd>Esc</kbd></button>
      </div>
      <div className="p-3 space-y-3">
        {!key ? (
          <AccessKeyPrompt compact />
        ) : result ? (
          <div className="space-y-2 text-[12px]">
            <p className="text-ink">
              {result.branches.length === 1 ? 'Forked 1 branch' : `Forked ${result.branches.length} branches`} from step {result.fork_step_index}.
            </p>
            {result.snapped && (
              <p className="text-muted">
                Step {result.requested_step_index} is inside a tool turn, so the fork starts from step {result.fork_step_index}, the last point where the model's context was complete.
              </p>
            )}
            <div className="flex gap-2">
              <button className="btn btn-accent" onClick={() => { selectBranch(result.branches[0].id); onClose() }}>Watch the first one</button>
              <button className="btn" onClick={onClose}>Stay here</button>
            </div>
          </div>
        ) : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); fork.mutate() }}>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">Model</span>
              <select className="field mono" value={model} onChange={(e) => setModel(e.target.value)}>
                {(models.data ?? [{ id: branch.model_id, name: branch.model_id, cheap: false }]).map((m) => (
                  <option key={m.id} value={m.id}>{m.name}{m.cheap ? ' (cheap)' : ''}</option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">Task prompt {prompt !== branch.task_prompt && <span className="text-accent">edited</span>}</span>
              <textarea className="field min-h-[88px] resize-y" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </label>
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-muted">Copies</span>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button type="button" key={n} className={`btn mono ${count === n ? 'btn-accent' : ''}`} onClick={() => setCount(n)}>{n}</button>
                ))}
              </div>
              <span className="text-[11px] text-faint">{count > 1 ? 'same model and prompt, run side by side' : ''}</span>
            </div>
            {fork.error && <p className="text-[12px] text-bad">{(fork.error as Error).message}</p>}
            <div className="flex items-center gap-2">
              <button className="btn btn-accent" disabled={fork.isPending || !prompt.trim()}>{fork.isPending ? 'Forking…' : `Fork ${count > 1 ? `×${count}` : ''}`}</button>
              <span className="text-[11px] text-faint">Each copy runs up to 30 model calls.</span>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
