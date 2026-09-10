import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { api, isLive } from '../api'
import BranchTree from '../components/BranchTree'
import CompareView from '../components/CompareView'
import DeleteSession from '../components/DeleteSession'
import { resolveStep } from '../lib/compare'
import DiffView from '../components/DiffView'
import ForkPopover from '../components/ForkPopover'
import { useSessionEvents } from '../hooks/useBranchEvents'
import { useAuth } from '../store'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import ContextDrawer from '../components/ContextDrawer'
import FileTree from '../components/FileTree'
import FileViewer from '../components/FileViewer'
import Scrubber from '../components/Scrubber'
import StepCard from '../components/StepCard'
import TopBar from '../components/TopBar'
import { fmtTokens, shortModel } from '../lib/steps'
import { useSelection } from '../store'

export default function SessionPage() {
  const { id } = useParams<{ id: string }>()
  const sel = useSelection()
  const [file, setFile] = useState<string | null>(null)
  const [fileDiff, setFileDiff] = useState(false)
  const [params, setParams] = useSearchParams()
  const deepLinked = useRef(false)
  const [rightWidth, setRightWidth] = useState<number>(() => { try { return Number(localStorage.getItem('rewind.rightPane')) || 0 } catch { return 0 } })
  const [viewport, setViewport] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setViewport(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // a remembered width must leave the centre pane at least 560px; below that fall back to the default split
  const effectiveRight = rightWidth && viewport - rightWidth >= 800 ? rightWidth : 0

  const sessionQ = useQuery({
    queryKey: ['session', id],
    queryFn: () => api.session(id!),
    refetchInterval: (q) => (q.state.data?.branches.some((b) => isLive(b.status)) ? 15000 : false),
  })
  const session = sessionQ.data
  const branches = session?.branches ?? []

  // default to the root branch, or honour ?branch=&step= once
  useEffect(() => {
    if (!session) return
    const wantBranch = params.get('branch')
    const wantStep = params.get('step')
    if (wantBranch && !deepLinked.current) {
      deepLinked.current = true
      if (branches.some((b) => b.id === wantBranch)) {
        sel.selectBranch(wantBranch)
        if (wantStep !== null) sel.setStep(Number(wantStep))
      }
      setParams({}, { replace: true })
      return
    }
    if (!sel.branchId || !branches.some((b) => b.id === sel.branchId)) {
      sel.selectBranch(session.root_branch_id ?? branches[0]?.id ?? '')
    }
  }, [session, branches, sel, params, setParams])

  const branch = branches.find((b) => b.id === sel.branchId) ?? null
  const live = !!branch && isLive(branch.status)
  useSessionEvents(session?.id, branches)
  const key = useAuth((s) => s.key)
  const qc = useQueryClient()
  const cancel = useMutation({ mutationFn: (id: string) => api.cancel(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['session', id] }) })
  const other = sel.diffMode && sel.diffOther ? branches.find((b) => b.id === sel.diffOther) ?? null : null

  const stepsQ = useQuery({
    queryKey: ['steps', sel.branchId],
    queryFn: () => api.steps(sel.branchId!),
    enabled: !!sel.branchId,
  })
  const steps = stepsQ.data ?? []
  const lastIndex = steps.length - 1
  const index = resolveStep(sel.stepIndex, lastIndex, live).index
  const step = lastIndex >= 0 ? steps[index] : undefined

  const filesQ = useQuery({
    queryKey: ['files', sel.branchId, index],
    queryFn: () => api.files(sel.branchId!, index),
    enabled: !!sel.branchId && index >= 0,
  })

  // when the step changes, prefer showing a file that changed at that step
  useEffect(() => {
    if (!step) return
    if (step.files_changed.length > 0) setFile(step.files_changed[0])
  }, [step])

  const setStep = useCallback((i: number) => {
    if (lastIndex < 0) return
    sel.setStep(resolveStep(i, lastIndex, live).stored)
  }, [lastIndex, live, sel])

  const compareParent = sel.compareParent ? branches.find((b) => b.id === sel.compareParent) ?? null : null
  const compareForks = compareParent ? branches.filter((b) => b.parent_branch_id === compareParent.id).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)) : []

  // resizable right pane
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const move = (ev: PointerEvent) => {
      const w = Math.max(320, Math.min(window.innerWidth - 700, window.innerWidth - ev.clientX))
      setRightWidth(w)
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      setRightWidth((w) => { try { localStorage.setItem('rewind.rightPane', String(w)) } catch { /* private mode */ } return w })
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      switch (e.key) {
        case 'ArrowLeft': e.preventDefault(); setStep(index - 1); break
        case 'ArrowRight': e.preventDefault(); setStep(index + 1); break
        case 'Home': e.preventDefault(); setStep(0); break
        case 'End': e.preventDefault(); sel.setStep(null); break
        case 'f': case 'F': sel.setForkOpen(!sel.forkOpen); break
        case 'd': case 'D': sel.setDiffMode(!sel.diffMode); break
        case 'c': case 'C': sel.setContextOpen(!sel.contextOpen); break
        case 'Escape': if (sel.compareParent) sel.setCompareParent(null); break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, setStep, sel])

  const changedHere = useMemo(() => !!file && !!step && step.files_changed.includes(file), [file, step])

  if (sessionQ.error) return <Shell title="Session"><p className="p-4 text-bad">Could not load session: {(sessionQ.error as Error).message}</p></Shell>
  if (!session) return <Shell title="Session"><p className="p-4 text-muted">Loading…</p></Shell>

  return (
    <Shell title={session.title} subtitle={session.repo_slug} branch={branch ? `${shortModel(branch.model_id)}   ${fmtTokens(branch.total_input_tokens + branch.total_output_tokens)} tokens` : undefined}
      extra={<DeleteSession sessionId={session.id} branchCount={branches.length} compact />}>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* left: branches */}
        <aside className="md:w-[240px] shrink-0 border-b md:border-b-0 md:border-r border-line bg-panel flex flex-col max-h-[30vh] md:max-h-none">
          <div className="pane-title">Branches <span className="text-faint">{branches.length}</span></div>
          <div className="min-h-0 flex-1 overflow-auto">
            <BranchTree branches={branches} selected={sel.branchId} diffOther={sel.diffOther} onSelect={sel.selectBranch} onShiftSelect={sel.toggleDiffWith}
              onCompare={(id) => sel.setCompareParent(sel.compareParent === id ? null : id)} comparing={sel.compareParent} />
          </div>
        </aside>

        {/* center: scrubber + step */}
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col border-b md:border-b-0 md:border-r border-line">
          {branch && (
            <Scrubber
              steps={steps} index={Math.max(0, index)} forkStepIndex={branch.fork_step_index} live={live} onChange={setStep}
              actions={
                <>
                  <button className="btn btn-accent" disabled={steps.length === 0} onClick={() => sel.setForkOpen(!sel.forkOpen)} title="Fork from this step (F)">Fork here</button>
                  {live && key && (
                    <button className="btn" disabled={cancel.isPending} onClick={() => cancel.mutate(branch.id)}>Cancel</button>
                  )}
                </>
              }
            />
          )}
          {sel.forkOpen && branch && step && (
            <ForkPopover branch={branch} stepIndex={step.index} onClose={() => sel.setForkOpen(false)} />
          )}
          {compareParent && compareForks.length > 1 ? (
            <CompareView parent={compareParent} forks={compareForks} all={branches}
              onPick={(bid, i) => { sel.selectBranch(bid); sel.setStep(i) }} onExit={() => sel.setCompareParent(null)} />
          ) : sel.diffMode && branch && other ? (
            <DiffView a={branch} aSteps={steps} aIndex={Math.max(0, index)} b={other} bIndex={sel.diffOtherStep} onBIndex={sel.setDiffOtherStep} onExit={() => sel.setDiffMode(false)} />
          ) : sel.diffMode && branch ? (
            <div className="flex flex-1 items-center justify-center text-[12px] text-muted">Diff mode. Shift-click another branch in the tree to compare against it.</div>
          ) : step ? (
            <StepCard step={step} onOpenContext={() => sel.setContextOpen(true)} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[12px] text-muted">
              {branch?.status === 'queued' ? 'Queued. Steps appear when the branch starts.' : stepsQ.isLoading ? 'Loading steps…' : 'No steps yet.'}
            </div>
          )}
          {branch?.error && (
            <div className="border-t border-line px-4 py-1.5 text-[11px] text-bad">{branch.status}: {branch.error}</div>
          )}
          {sel.contextOpen && branch && step && (
            <ContextDrawer branchId={branch.id} index={step.index} onClose={() => sel.setContextOpen(false)} />
          )}
        </main>

        {/* right: files */}
        <div
          className={`hidden md:block w-1 shrink-0 cursor-col-resize bg-line hover:bg-accent active:bg-accent ${(sel.diffMode && other) || compareParent ? 'md:hidden' : ''}`}
          onPointerDown={startResize} title="Drag to resize" role="separator" aria-orientation="vertical"
        />
        <aside
          className={`shrink-0 flex flex-col bg-panel min-h-[40vh] md:min-h-0 ${(sel.diffMode && other) || compareParent ? 'hidden' : ''} ${effectiveRight ? '' : 'md:w-[44%] xl:w-[46%]'}`}
          style={effectiveRight ? { width: effectiveRight } : undefined}
        >
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <div className="md:w-[190px] shrink-0 border-b md:border-b-0 md:border-r border-line flex flex-col max-h-[30vh] md:max-h-none">
              <div className="pane-title">Files {filesQ.data && <span className="mono text-faint">{filesQ.data.commit.slice(0, 8)}</span>}</div>
              <div className="min-h-0 flex-1 overflow-auto">
                {filesQ.data && <FileTree files={filesQ.data.files} selected={file} onSelect={setFile} />}
                {filesQ.isLoading && <p className="px-3 py-2 text-[12px] text-muted">Loading…</p>}
                {filesQ.error && <p className="px-3 py-2 text-[12px] text-bad">{(filesQ.error as Error).message}</p>}
              </div>
            </div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg">
              {branch && index >= 0 && (
                <FileViewer branchId={branch.id} index={index} path={file} diff={fileDiff} onToggleDiff={() => setFileDiff((d) => !d)} changedHere={changedHere} />
              )}
            </div>
          </div>
        </aside>
      </div>
    </Shell>
  )
}

function Shell({ title, subtitle, branch, extra, children }: { title: string; subtitle?: string; branch?: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <span className="text-[13px] text-ink truncate">{title}</span>
        {subtitle && <span className="mono text-[11px] text-muted">{subtitle}</span>}
        <span className="ml-auto flex items-center gap-3">
          {branch && <span className="mono text-[11px] text-faint hidden md:inline whitespace-pre">{branch}</span>}
          {extra}
        </span>
      </TopBar>
      {children}
    </div>
  )
}
