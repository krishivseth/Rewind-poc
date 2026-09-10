import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ClerkProvider, Show, SignIn, SignUp, UserButton, useAuth, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Braces,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Copy,
  GitBranch,
  GitCompare,
  History,
  Layers3,
  LoaderCircle,
  MessageSquare,
  Play,
  Plus,
  Search,
  Server,
  Settings2,
  Split,
  TerminalSquare,
  X,
  Zap,
} from 'lucide-react';
import {
  getGetDiffQueryKey,
  getGetSessionQueryKey,
  getGetStepContextQueryKey,
  getListBranchStepsQueryKey,
  getListReposQueryKey,
  getListSessionsQueryKey,
  getListStepFilesQueryKey,
  getReadFileAtStepQueryKey,
  useCreateSession,
  useForkBranch,
  useGetDiff,
  useGetSession,
  useGetStepContext,
  useHealthCheck,
  useListBranchSteps,
  useListRepos,
  useListSessions,
  useListStepFiles,
  useReadFileAtStep,
} from '@workspace/api-client-react';
import { Link, Redirect, Route, Switch, Router as WouterRouter, useLocation, useParams } from 'wouter';

const queryClient = new QueryClient();

const cx = (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' ');
const formatNumber = (value?: number | null) => new Intl.NumberFormat('en-US').format(value ?? 0);
const formatDate = (value?: string) => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const shortHash = (value?: string | null) => value ? value.slice(0, 8) : '--------';
const kindTone: Record<string, string> = {
  user: 'text-sky-300 bg-sky-400/10 border-sky-400/20',
  assistant: 'text-violet-300 bg-violet-400/10 border-violet-400/20',
  tool_call: 'text-amber-300 bg-amber-400/10 border-amber-400/20',
  tool_result: 'text-teal-300 bg-teal-400/10 border-teal-400/20',
};
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

function stripBase(path: string) {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#20d4c3',
    colorForeground: '#e5edf2',
    colorMutedForeground: '#7f8a96',
    colorDanger: '#ff7b86',
    colorBackground: '#10171b',
    colorInput: '#0b1016',
    colorInputForeground: '#e5edf2',
    colorNeutral: '#2a3941',
    fontFamily: '"IBM Plex Mono", monospace',
    borderRadius: '0px',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#10171b] border border-[#2a3941] rounded-none w-[440px] max-w-full overflow-hidden',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'font-mono text-[#e5edf2]',
    headerSubtitle: 'font-mono text-[#7f8a96]',
    socialButtonsBlockButtonText: 'font-mono text-[#e5edf2]',
    formFieldLabel: 'font-mono text-[#a9b7c0]',
    footerActionLink: 'font-mono text-[#20d4c3]',
    footerActionText: 'font-mono text-[#7f8a96]',
    dividerText: 'font-mono text-[#7f8a96]',
    formButtonPrimary: 'font-mono uppercase tracking-wider bg-[#20d4c3] text-[#071012] hover:bg-[#54e0d2]',
    formFieldInput: 'font-mono bg-[#0b1016] text-[#e5edf2] border-[#2a3941]',
    socialButtonsBlockButton: 'font-mono bg-[#0b1016] border-[#2a3941] hover:bg-[#152127]',
    dividerLine: 'bg-[#2a3941]',
    alert: 'bg-[#35191d] border-[#71333c]',
    alertText: 'font-mono text-[#ffb0b7]',
    otpCodeFieldInput: 'font-mono bg-[#0b1016] text-[#e5edf2] border-[#2a3941]',
    main: 'bg-[#10171b]',
  },
};

function AppShell({ children }: { children: ReactNode }) {
  return <div className="min-h-[100dvh] bg-background text-foreground">{children}</div>;
}

function StatusDot({ status, pulse = false }: { status?: string; pulse?: boolean }) {
  return <span className={cx('inline-block h-1.5 w-1.5 rounded-full', status === 'failed' ? 'bg-red-400' : status === 'done' ? 'bg-teal-400' : status === 'queued' ? 'bg-amber-300' : 'bg-sky-300', pulse && 'pulse-dot')} />;
}

function Brand() {
  return (
    <Link href="/" data-testid="link-brand" className="group flex items-center gap-2.5">
      <span className="relative grid h-7 w-7 place-items-center border border-primary/50 bg-primary/10 text-primary">
        <span className="absolute h-3 w-3 border border-primary group-hover:rotate-90 transition-transform" />
        <span className="h-1.5 w-1.5 bg-primary" />
      </span>
      <span className="font-mono text-[13px] font-semibold tracking-[.22em] text-foreground">REWIND</span>
    </Link>
  );
}

function TopBar({ health }: { health?: string }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border/80 bg-[#0d1118]/95 px-4 sm:px-6">
      <div className="flex items-center gap-5">
        <Brand />
        <span className="hidden h-4 w-px bg-border sm:block" />
        <span className="hidden font-mono text-[10px] uppercase tracking-[.22em] text-muted-foreground sm:block">trajectory debugger</span>
      </div>
      <div className="flex items-center gap-3 text-[10px] font-mono uppercase tracking-wider">
        <span className="hidden items-center gap-2 text-muted-foreground md:flex"><Server className="h-3.5 w-3.5 text-primary" /> api {health === 'ok' ? 'online' : health ? health : 'checking'}</span>
        <span className="h-3.5 w-px bg-border" />
        <Show when="signed-in"><UserButton appearance={{ elements: { userButtonAvatarBox: 'h-6 w-6' } }} /></Show>
        <button type="button" data-testid="button-settings" className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Settings"><Settings2 className="h-4 w-4" /></button>
      </div>
    </header>
  );
}

function EmptyState({ icon: Icon, title, body, action }: { icon: typeof Search; title: string; body: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center border border-dashed border-border/80 bg-card/30 px-6 text-center">
      <div className="mb-3 grid h-9 w-9 place-items-center border border-primary/30 bg-primary/5 text-primary"><Icon className="h-4 w-4" /></div>
      <p className="font-mono text-xs text-foreground">{title}</p>
      <p className="mt-2 max-w-xs text-[11px] leading-relaxed text-muted-foreground">{body}</p>
      {action}
    </div>
  );
}

function QueryError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3 border border-red-400/20 bg-red-400/5 p-3 text-[11px] text-red-200">
      <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
      <span>Unable to read this slice of the session.</span>
      <button type="button" data-testid="button-retry" onClick={onRetry} className="ml-auto border border-red-400/30 px-2 py-1 font-mono text-[10px] uppercase text-red-200 hover:bg-red-400/10">Retry</button>
    </div>
  );
}

function Home() {
  const { data: repos, isLoading: reposLoading } = useListRepos({ query: { queryKey: getListReposQueryKey() } });
  const sessionsQuery = useListSessions({ query: { queryKey: getListSessionsQueryKey() } });
  const healthQuery = useHealthCheck();
  const createSession = useCreateSession();
  const [, setLocation] = useLocation();
  const [showNew, setShowNew] = useState(false);
  const [repoId, setRepoId] = useState('');
  const [title, setTitle] = useState('');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [modelId, setModelId] = useState('anthropic/claude-sonnet-4');
  const repositoryList = useMemo(() => repos ?? [], [repos]);
  const sessionList = sessionsQuery.data ?? [];

  useEffect(() => {
    if (!repoId && repositoryList[0]?.id) setRepoId(repositoryList[0].id);
  }, [repoId, repositoryList]);

  const submitNewSession = () => {
    if (!repoId || !title.trim() || !taskPrompt.trim() || createSession.isPending) return;
    createSession.mutate({ data: { repoId, title: title.trim(), taskPrompt: taskPrompt.trim(), modelId } }, {
      onSuccess: (session) => {
        queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
        setShowNew(false);
        setTitle('');
        setTaskPrompt('');
        setLocation(`/sessions/${session.id}`);
      },
    });
  };

  return (
    <AppShell>
      <TopBar health={healthQuery.data?.status} />
      <main className="mx-auto max-w-[1440px] px-4 py-8 sm:px-8 lg:px-12">
        <div className="fade-up flex flex-col justify-between gap-6 border-b border-border/70 pb-7 sm:flex-row sm:items-end">
          <div>
            <div className="mb-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.24em] text-primary"><History className="h-3.5 w-3.5" /> session archive</div>
            <h1 className="font-mono text-2xl tracking-tight text-foreground sm:text-3xl">Find the moment it changed.</h1>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">Inspect agent trajectories as source history. Move through exact repository states, replay context, and branch without guessing.</p>
          </div>
          <button type="button" data-testid="button-new-session" onClick={() => setShowNew((value) => !value)} className="flex h-10 items-center justify-center gap-2 border border-primary/60 bg-primary px-4 font-mono text-[11px] font-semibold uppercase tracking-wider text-primary-foreground transition-transform hover:-translate-y-0.5 active:translate-y-0"><Plus className="h-4 w-4" /> New session</button>
        </div>

        {showNew && (
          <section className="fade-up mt-6 border border-primary/30 bg-[#101a1d]/90 p-5 shadow-[0_0_0_1px_rgba(76,218,197,.04)]" data-testid="panel-new-session">
            <div className="mb-5 flex items-center justify-between"><div><p className="font-mono text-xs text-primary">initialize trajectory</p><p className="mt-1 text-[11px] text-muted-foreground">A new session starts a clean agent run against the selected repository.</p></div><button type="button" data-testid="button-close-new-session" onClick={() => setShowNew(false)}><X className="h-4 w-4 text-muted-foreground hover:text-foreground" /></button></div>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block"><span className="mb-2 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">repository</span><select data-testid="select-repository" value={repoId} onChange={(event) => setRepoId(event.target.value)} className="h-10 w-full border border-input bg-background px-3 font-mono text-xs text-foreground outline-none focus:border-primary">{reposLoading && <option value="">Loading repositories…</option>}{repositoryList.map((repo) => <option key={repo.id} value={repo.id}>{repo.slug} — {repo.name}</option>)}</select></label>
              <label className="block"><span className="mb-2 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">model</span><select data-testid="select-model" value={modelId} onChange={(event) => setModelId(event.target.value)} className="h-10 w-full border border-input bg-background px-3 font-mono text-xs text-foreground outline-none focus:border-primary"><option value="anthropic/claude-sonnet-4">Claude Sonnet</option><option value="openai/gpt-4o-mini">GPT-4o mini</option><option value="google/gemini-2.5-flash">Gemini Flash</option><option value="moonshotai/kimi-k2">Kimi K2</option><option value="deepseek/deepseek-chat-v3-0324">DeepSeek V3</option></select></label>
              <label className="block md:col-span-2"><span className="mb-2 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">session title</span><input data-testid="input-session-title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. untangle event replay race" className="h-10 w-full border border-input bg-background px-3 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-primary" /></label>
              <label className="block md:col-span-2"><span className="mb-2 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">task prompt</span><textarea data-testid="input-task-prompt" value={taskPrompt} onChange={(event) => setTaskPrompt(event.target.value)} placeholder="Describe the change you want the coding agent to make…" rows={3} className="w-full resize-none border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-primary" /></label>
            </div>
            {createSession.isError && <p className="mt-3 text-[11px] text-red-300">Session could not be started. Check the server and try again.</p>}
            <div className="mt-5 flex justify-end gap-2"><button type="button" data-testid="button-cancel-session" onClick={() => setShowNew(false)} className="border border-border px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground">Cancel</button><button type="button" data-testid="button-create-session" disabled={!repoId || !title.trim() || !taskPrompt.trim() || createSession.isPending} onClick={submitNewSession} className="flex items-center gap-2 bg-primary px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40">{createSession.isPending && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />} Start run <ArrowRight className="h-3.5 w-3.5" /></button></div>
          </section>
        )}

        <section className="mt-8">
          <div className="mb-3 flex items-center justify-between"><div className="flex items-center gap-3"><h2 className="font-mono text-xs uppercase tracking-[.2em] text-foreground">recent sessions</h2><span className="border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{sessionList.length}</span></div><span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">newest first</span></div>
          {sessionsQuery.isLoading ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((item) => <div key={item} className="h-36 animate-pulse border border-border bg-card/60" />)}</div> : sessionsQuery.isError ? <QueryError onRetry={() => sessionsQuery.refetch()} /> : sessionList.length === 0 ? <EmptyState icon={TerminalSquare} title="No trajectories yet" body="Start a session to create your first inspectable agent run." action={<button type="button" data-testid="button-empty-new-session" onClick={() => setShowNew(true)} className="mt-4 flex items-center gap-2 border border-primary/40 px-3 py-2 font-mono text-[10px] uppercase text-primary hover:bg-primary/10"><Plus className="h-3 w-3" /> start a session</button>} /> : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{sessionList.map((session, index) => <SessionCard key={session.id} session={session} index={index} />)}</div>}
        </section>
      </main>
    </AppShell>
  );
}

function SessionCard({ session, index }: { session: any; index: number }) {
  const repoQuery = useListRepos({ query: { queryKey: getListReposQueryKey(), staleTime: 300000 } });
  const repo = repoQuery.data?.find((item) => item.id === session.repoId);
  const activeBranch = session.branches?.find((branch: any) => branch.status === 'running') ?? session.branches?.[0];
  return (
    <Link href={`/sessions/${session.id}`} data-testid={`card-session-${session.id}`} className="group fade-up relative block border border-border/80 bg-card/75 p-4 transition-all hover:-translate-y-0.5 hover:border-primary/45 hover:bg-card" style={{ animationDelay: `${index * 55}ms` }}>
      <div className="mb-5 flex items-start justify-between"><div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-primary"><span className="h-1.5 w-1.5 bg-primary" /> {repo?.slug ?? 'repository'}</div><span className="font-mono text-[10px] text-muted-foreground">{formatDate(session.createdAt)}</span></div>
      <h3 className="truncate font-mono text-sm text-foreground group-hover:text-primary">{session.title}</h3>
      <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-3 font-mono text-[10px] text-muted-foreground"><span className="flex items-center gap-1.5"><GitBranch className="h-3 w-3" /> {session.branches?.length ?? 0} branch{session.branches?.length === 1 ? '' : 'es'}</span><span className="flex items-center gap-1.5"><StatusDot status={activeBranch?.status} pulse={activeBranch?.status === 'running'} /> {activeBranch?.status ?? 'queued'}</span></div>
    </Link>
  );
}

function Workspace() {
  const { id = '' } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const sessionQuery = useGetSession(id, { query: { enabled: Boolean(id), queryKey: getGetSessionQueryKey(id) } });
  const session = sessionQuery.data;
  const branches = useMemo(() => session?.branches ?? [], [session?.branches]);
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const [selectedStepIndex, setSelectedStepIndex] = useState(0);
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [showFork, setShowFork] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [fileFilter, setFileFilter] = useState('');
  const [liveState, setLiveState] = useState<'connecting' | 'live' | 'offline'>('connecting');

  useEffect(() => {
    if (branches.length && !branches.some((branch) => branch.id === selectedBranchId)) setSelectedBranchId(branches[0].id);
  }, [branches, selectedBranchId]);
  useEffect(() => {
    setSelectedStepIndex(0);
    setSelectedFilePath('');
    setFileFilter('');
  }, [selectedBranchId]);

  const selectedBranch = branches.find((branch) => branch.id === selectedBranchId);
  const stepsQuery = useListBranchSteps(selectedBranchId, { query: { enabled: Boolean(selectedBranchId), queryKey: getListBranchStepsQueryKey(selectedBranchId) } });
  const steps = useMemo(() => stepsQuery.data ?? [], [stepsQuery.data]);
  const selectedStep = steps.find((step) => step.index === selectedStepIndex) ?? steps[selectedStepIndex];
  const activeIndex = selectedStep?.index ?? selectedStepIndex;
  const filesQuery = useListStepFiles(selectedBranchId, activeIndex, { query: { enabled: Boolean(selectedBranchId) && Boolean(selectedStep), queryKey: getListStepFilesQueryKey(selectedBranchId, activeIndex) } });
  const files = useMemo(() => filesQuery.data ?? [], [filesQuery.data]);
  const filteredFiles = files.filter((file) => file.path.toLowerCase().includes(fileFilter.toLowerCase()));
  const fileQuery = useReadFileAtStep({ branchId: selectedBranchId, index: activeIndex, path: selectedFilePath || '__none__' }, { query: { enabled: Boolean(selectedBranchId && selectedStep && selectedFilePath), queryKey: getReadFileAtStepQueryKey({ branchId: selectedBranchId, index: activeIndex, path: selectedFilePath || '__none__' }) } });
  const contextQuery = useGetStepContext(selectedBranchId, activeIndex, { query: { enabled: Boolean(selectedBranchId && selectedStep), queryKey: getGetStepContextQueryKey(selectedBranchId, activeIndex) } });
  const compareBranch = branches.find((branch) => branch.id !== selectedBranchId);
  const diffParams = { a: `${selectedBranchId}:${activeIndex}`, b: `${compareBranch?.id ?? ''}:0` };
  const diffQuery = useGetDiff(diffParams, { query: { enabled: Boolean(showDiff && compareBranch && selectedStep), queryKey: getGetDiffQueryKey(diffParams) } });
  const forkBranch = useForkBranch();

  useEffect(() => {
    if (!selectedBranchId) return;
    setLiveState('connecting');
    const source = new EventSource(`/api/branches/${selectedBranchId}/events`);
    source.onopen = () => setLiveState('live');
    source.onerror = () => setLiveState('offline');
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { type?: string; step?: any };
      if (payload.step) {
        queryClient.setQueryData(getListBranchStepsQueryKey(selectedBranchId), (current: any) => {
          const rows = Array.isArray(current) ? current : [];
          return rows.some((row: any) => row.id === payload.step.id) ? rows : [...rows, payload.step].sort((a, b) => a.index - b.index);
        });
      }
      queryClient.invalidateQueries({ queryKey: getGetSessionQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: getListBranchStepsQueryKey(selectedBranchId) });
    };
    return () => source.close();
  }, [id, selectedBranchId]);

  const selectStep = (index: number) => {
    setSelectedStepIndex(index);
    setSelectedFilePath('');
  };
  const refetchAll = () => {
    sessionQuery.refetch();
    stepsQuery.refetch();
  };

  return (
    <AppShell>
      <TopBar health="ok" />
      <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-[#0c1016] px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3"><Link href="/" data-testid="link-back-sessions" className="text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /></Link><span className="h-4 w-px bg-border" /><span className="truncate font-mono text-xs text-foreground">{session?.title ?? 'Loading session…'}</span>{selectedBranch && <span className="hidden items-center gap-1.5 border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground sm:flex"><GitBranch className="h-3 w-3 text-primary" /> {selectedBranch.id.slice(0, 8)}</span>}</div>
          <div className="flex items-center gap-2"><span className="hidden items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground sm:flex"><StatusDot status={liveState === 'live' ? 'done' : liveState === 'offline' ? 'failed' : 'queued'} pulse={liveState === 'connecting'} /> {liveState}</span><button type="button" data-testid="button-toggle-diff" onClick={() => setShowDiff((value) => !value)} className={cx('flex items-center gap-1.5 border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors', showDiff ? 'border-primary/60 bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}><GitCompare className="h-3.5 w-3.5" /> <span className="hidden sm:inline">compare</span></button><button type="button" data-testid="button-fork-header" onClick={() => setShowFork(true)} disabled={!selectedStep} className="flex items-center gap-1.5 border border-primary/40 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-primary hover:bg-primary/10 disabled:opacity-40"><Split className="h-3.5 w-3.5" /> fork</button></div>
        </div>
        {sessionQuery.isLoading ? <WorkspaceSkeleton /> : sessionQuery.isError ? <div className="m-4"><QueryError onRetry={refetchAll} /></div> : (
          <div className="grid min-h-0 flex-1 lg:grid-cols-[220px_minmax(420px,1fr)_320px]">
            <BranchPanel branches={branches} selectedId={selectedBranchId} onSelect={setSelectedBranchId} />
            <main className="scanline min-w-0 border-b border-border lg:border-b-0 lg:border-r">
              <TrajectoryPanel steps={steps} selectedIndex={activeIndex} onSelect={selectStep} branch={selectedBranch} loading={stepsQuery.isLoading} error={stepsQuery.isError} onRetry={() => stepsQuery.refetch()} />
              <StepInspector step={selectedStep} branch={selectedBranch} onFork={() => setShowFork(true)} />
              {showDiff && <DiffPanel query={diffQuery} compareBranch={compareBranch} onClose={() => setShowDiff(false)} />}
            </main>
            <aside className="min-w-0 bg-[#0b0f15]">
              <ContextPanel contextQuery={contextQuery} step={selectedStep} />
              <FilePanel files={filteredFiles} allFiles={files} query={filesQuery} selectedPath={selectedFilePath} onSelect={setSelectedFilePath} filter={fileFilter} onFilter={setFileFilter} content={fileQuery.data} contentQuery={fileQuery} />
            </aside>
          </div>
        )}
      </div>
      {showFork && <ForkModal branch={selectedBranch} stepIndex={activeIndex} onClose={() => setShowFork(false)} mutation={forkBranch} onSuccess={(created) => { setShowFork(false); const targetSessionId = created[0]?.sessionId; if (targetSessionId && targetSessionId !== id) setLocation(`/sessions/${targetSessionId}`); else sessionQuery.refetch(); }} />}
    </AppShell>
  );
}

function WorkspaceSkeleton() {
  return <div className="grid flex-1 animate-pulse lg:grid-cols-[220px_1fr_320px]"><div className="border-r border-border bg-card/30" /><div className="border-r border-border p-6"><div className="h-7 w-2/3 bg-muted" /><div className="mt-8 h-36 bg-muted/60" /><div className="mt-5 h-52 bg-muted/40" /></div><div className="p-5"><div className="h-5 w-1/2 bg-muted" /><div className="mt-5 h-48 bg-muted/50" /></div></div>;
}

function BranchPanel({ branches, selectedId, onSelect }: { branches: any[]; selectedId: string; onSelect: (id: string) => void }) {
  return (
    <aside className="border-b border-border bg-[#0c1016] lg:border-b-0 lg:border-r">
      <div className="flex h-10 items-center justify-between border-b border-border px-3"><span className="font-mono text-[10px] uppercase tracking-[.18em] text-muted-foreground">branches</span><span className="font-mono text-[10px] text-primary">{branches.length.toString().padStart(2, '0')}</span></div>
      {branches.length === 0 ? <div className="p-3"><EmptyState icon={GitBranch} title="No branch data" body="The session has not returned a branch tree yet." /></div> : <div className="rewind-scroll max-h-[340px] overflow-auto p-2 lg:max-h-[calc(100dvh-9rem)]">{branches.map((branch, index) => <button type="button" data-testid={`button-branch-${branch.id}`} key={branch.id} onClick={() => onSelect(branch.id)} className={cx('relative mb-1 w-full border p-3 text-left transition-colors', selectedId === branch.id ? 'border-primary/50 bg-primary/8' : 'border-transparent hover:border-border hover:bg-card/60', branch.parentBranchId && 'ml-3 w-[calc(100%-0.75rem)]')}><span className="absolute -left-2 top-5 h-px w-2 bg-border" hidden={!branch.parentBranchId} /><div className="flex items-center justify-between gap-2"><span className={cx('flex min-w-0 items-center gap-2 truncate font-mono text-[11px]', selectedId === branch.id ? 'text-primary' : 'text-foreground')}><StatusDot status={branch.status} pulse={branch.status === 'running'} /> {index === 0 ? 'root trajectory' : `fork ${index.toString().padStart(2, '0')}`}</span><ChevronRight className={cx('h-3 w-3 shrink-0 text-muted-foreground transition-transform', selectedId === branch.id && 'rotate-90 text-primary')} /></div><div className="mt-2 flex items-center justify-between font-mono text-[10px] text-muted-foreground"><span>{branch.modelId}</span><span>{branch.stepCount} steps</span></div>{branch.forkStepIndex !== null && branch.forkStepIndex !== undefined && <div className="mt-1 font-mono text-[9px] text-amber-300/70">forked at step {branch.forkStepIndex}</div>}</button>)}</div>}
      <div className="hidden border-t border-border p-3 lg:block"><div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground"><Layers3 className="h-3 w-3" /> branch lineage</div><div className="mt-2 h-1 overflow-hidden bg-muted"><div className="h-full w-2/3 bg-primary/60" /></div></div>
    </aside>
  );
}

function TrajectoryPanel({ steps, selectedIndex, onSelect, branch, loading, error, onRetry }: { steps: any[]; selectedIndex: number; onSelect: (index: number) => void; branch: any; loading: boolean; error: boolean; onRetry: () => void }) {
  const [isPlaying, setIsPlaying] = useState(false);
  useEffect(() => {
    if (!isPlaying || !steps.length) return;
    const timer = window.setInterval(() => {
      const current = steps.findIndex((step) => step.index === selectedIndex);
      if (current >= steps.length - 1) setIsPlaying(false);
      else onSelect(steps[current + 1].index);
    }, 1300);
    return () => window.clearInterval(timer);
  }, [isPlaying, onSelect, selectedIndex, steps]);
  return (
    <section className="border-b border-border bg-[#0f141b]">
      <div className="flex h-10 items-center justify-between border-b border-border px-4"><div className="flex items-center gap-2"><Zap className="h-3.5 w-3.5 text-primary" /><span className="font-mono text-[10px] uppercase tracking-[.18em] text-foreground">trajectory</span><span className="font-mono text-[10px] text-muted-foreground">{branch?.status ?? '—'}</span></div><div className="flex items-center gap-3 font-mono text-[10px] text-muted-foreground"><span>{formatNumber(branch?.totalInputTokens)} in / {formatNumber(branch?.totalOutputTokens)} out</span></div></div>
      {loading ? <div className="h-36 animate-pulse bg-muted/30" /> : error ? <div className="p-4"><QueryError onRetry={onRetry} /></div> : steps.length === 0 ? <div className="p-4"><EmptyState icon={Clock3} title="Trajectory is empty" body="Steps will appear here once the agent begins producing events." /></div> : <div className="p-4"><div className="relative h-16"><div className="absolute left-2 right-2 top-7 h-px bg-border" /><div className="absolute left-2 top-7 h-px bg-primary transition-all" style={{ width: `${steps.length > 1 ? (steps.findIndex((step) => step.index === selectedIndex) / (steps.length - 1)) * 100 : 0}%` }} />{steps.map((step) => { const selected = step.index === selectedIndex; const left = steps.length > 1 ? (steps.findIndex((item) => item.index === step.index) / (steps.length - 1)) * 100 : 0; return <button type="button" data-testid={`button-step-${step.index}`} key={step.id} onClick={() => onSelect(step.index)} title={`Step ${step.index}`} className="absolute top-0 -translate-x-1/2" style={{ left: `${Math.max(1, Math.min(99, left))}%` }}><span className={cx('mx-auto block rounded-full border transition-all', selected ? 'h-4 w-4 border-primary bg-primary shadow-[0_0_0_4px_rgba(76,218,197,.12)]' : 'h-2.5 w-2.5 border-muted-foreground/70 bg-[#0f141b] hover:border-primary')} /><span className={cx('mt-3 block font-mono text-[9px]', selected ? 'text-primary' : 'text-muted-foreground')}>{step.index.toString().padStart(2, '0')}</span></button>; })}</div><div className="flex items-center justify-between border-t border-border/70 pt-3"><button type="button" data-testid="button-play-trajectory" onClick={() => setIsPlaying((value) => !value)} className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-primary hover:text-primary/80">{isPlaying ? <><span className="h-3 w-3 border border-primary p-[2px]"><span className="block h-full w-full bg-primary" /></span> pause replay</> : <><Play className="h-3 w-3 fill-current" /> replay trajectory</>}</button><span className="font-mono text-[10px] text-muted-foreground">step {selectedIndex} / {steps[steps.length - 1]?.index ?? 0}</span></div></div>}
    </section>
  );
}

function StepInspector({ step, branch, onFork }: { step: any; branch: any; onFork: () => void }) {
  return <section className="border-b border-border p-4 sm:p-5"><div className="mb-4 flex items-center justify-between"><div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.18em] text-muted-foreground"><CircleDot className="h-3.5 w-3.5 text-primary" /> step inspection</div><button type="button" data-testid="button-fork-step" onClick={onFork} disabled={!step} className="flex items-center gap-1.5 border border-border px-2.5 py-1.5 font-mono text-[10px] uppercase text-muted-foreground hover:border-primary/50 hover:text-primary disabled:opacity-40"><Split className="h-3 w-3" /> fork here</button></div>{!step ? <EmptyState icon={CircleDot} title="Select a step" body="Choose a trajectory point to inspect its event, context, and repository state." /> : <div className="fade-up"><div className="flex flex-wrap items-center gap-2"><span className={cx('border px-2 py-1 font-mono text-[10px] uppercase', kindTone[step.kind] ?? 'border-border text-muted-foreground')}>{step.kind.replace('_', ' ')}</span>{step.toolName && <span className="flex items-center gap-1.5 border border-border bg-card px-2 py-1 font-mono text-[10px] text-foreground"><TerminalSquare className="h-3 w-3 text-amber-300" /> {step.toolName}</span>}{step.commitHash && <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground"><Code2 className="h-3 w-3" /> {shortHash(step.commitHash)}</span>}</div><div className="mt-4 border border-border/80 bg-[#0b1016] p-4"><p className="whitespace-pre-wrap font-mono text-[12px] leading-6 text-foreground/90">{typeof step.content === 'string' ? step.content : JSON.stringify(step.content, null, 2)}</p></div><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">{[['latency', step.latencyMs ? `${step.latencyMs}ms` : '—'], ['input', formatNumber(step.inputTokens)], ['output', formatNumber(step.outputTokens)], ['files', step.filesChanged?.length ?? 0]].map(([label, value]) => <div key={label} className="border border-border/70 bg-card/40 px-3 py-2"><p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-1 font-mono text-xs text-foreground">{value}</p></div>)}</div>{step.toolArgs && <details className="mt-3 border border-border/70 bg-card/30"><summary className="cursor-pointer px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">tool arguments</summary><pre className="overflow-auto border-t border-border/70 p-3 font-mono text-[11px] leading-5 text-amber-100/80">{JSON.stringify(step.toolArgs, null, 2)}</pre></details>}</div>}</section>;
}

function ContextPanel({ contextQuery, step }: { contextQuery: any; step: any }) {
  const [expanded, setExpanded] = useState(true);
  const context = contextQuery.data;
  return <section className="border-b border-border"><button type="button" data-testid="button-toggle-context" onClick={() => setExpanded((value) => !value)} className="flex h-10 w-full items-center justify-between border-b border-border px-4 text-left hover:bg-card/60"><span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.18em] text-foreground"><MessageSquare className="h-3.5 w-3.5 text-violet-300" /> model context</span><span className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">{context ? `${formatNumber(context.tokenCount)} tokens` : 'exact state'}<ChevronDown className={cx('h-3.5 w-3.5 transition-transform', !expanded && '-rotate-90')} /></span></button>{expanded && <div className="p-3">{contextQuery.isLoading ? <div className="space-y-2">{[1, 2, 3].map((item) => <div key={item} className="h-8 animate-pulse bg-muted/40" />)}</div> : contextQuery.isError ? <QueryError onRetry={() => contextQuery.refetch()} /> : !step ? <p className="px-1 py-3 font-mono text-[11px] text-muted-foreground">Select a step to load its exact model context.</p> : !context || context.messages.length === 0 ? <p className="px-1 py-3 font-mono text-[11px] text-muted-foreground">No context messages returned for this step.</p> : <div className="rewind-scroll max-h-56 space-y-2 overflow-auto">{context.messages.map((message: any, index: number) => <div key={index} className="border border-border/70 bg-card/40 p-2.5"><div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-primary">message {index.toString().padStart(2, '0')}</div><p className="line-clamp-4 whitespace-pre-wrap font-mono text-[10px] leading-5 text-muted-foreground">{typeof message === 'string' ? message : JSON.stringify(message)}</p></div>)}</div>}</div>}</section>;
}

function FilePanel({ files, allFiles, query, selectedPath, onSelect, filter, onFilter, content, contentQuery }: { files: any[]; allFiles: any[]; query: any; selectedPath: string; onSelect: (path: string) => void; filter: string; onFilter: (value: string) => void; content: any; contentQuery: any }) {
  const [showBrowser, setShowBrowser] = useState(true);
  return <section><button type="button" data-testid="button-toggle-files" onClick={() => setShowBrowser((value) => !value)} className="flex h-10 w-full items-center justify-between border-b border-border px-4 text-left hover:bg-card/60"><span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.18em] text-foreground"><Braces className="h-3.5 w-3.5 text-amber-300" /> repository state</span><span className="font-mono text-[10px] text-muted-foreground">{allFiles.length} files <ChevronDown className={cx('ml-2 inline h-3.5 w-3.5 transition-transform', !showBrowser && '-rotate-90')} /></span></button>{showBrowser && <div className="grid min-h-[280px] grid-cols-[132px_1fr]">{<div className="border-r border-border"><div className="border-b border-border p-2"><div className="flex items-center gap-1.5 border border-input px-2 py-1.5"><Search className="h-3 w-3 text-muted-foreground" /><input data-testid="input-file-search" value={filter} onChange={(event) => onFilter(event.target.value)} placeholder="filter" className="min-w-0 w-full bg-transparent font-mono text-[10px] text-foreground outline-none placeholder:text-muted-foreground" /></div></div><div className="rewind-scroll max-h-64 overflow-auto p-1.5">{query.isLoading ? <div className="space-y-2 p-1">{[1, 2, 3, 4].map((item) => <div key={item} className="h-5 animate-pulse bg-muted/40" />)}</div> : query.isError ? <p className="p-2 font-mono text-[10px] text-red-300">Files unavailable.</p> : files.length === 0 ? <p className="p-2 font-mono text-[10px] text-muted-foreground">No matching files.</p> : files.map((file) => <button type="button" data-testid={`button-file-${file.path}`} key={file.path} onClick={() => onSelect(file.path)} className={cx('flex w-full items-center gap-1.5 truncate px-2 py-1.5 text-left font-mono text-[10px]', selectedPath === file.path ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-card hover:text-foreground')}><span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', file.changed ? 'bg-amber-300' : 'bg-border')} />{file.path.split('/').pop()}</button>)}</div></div>}<div className="min-w-0 bg-[#090d12]">{!selectedPath ? <div className="flex h-full min-h-[280px] flex-col items-center justify-center px-5 text-center"><Code2 className="mb-3 h-5 w-5 text-muted-foreground/70" /><p className="font-mono text-[10px] text-muted-foreground">Select a file to read it at step {contentQuery.data?.path ? '' : '—'}.</p></div> : contentQuery.isLoading ? <div className="space-y-2 p-4">{[1, 2, 3, 4, 5, 6].map((item) => <div key={item} className="h-3 animate-pulse bg-muted/40" />)}</div> : contentQuery.isError ? <div className="p-4"><QueryError onRetry={() => contentQuery.refetch()} /></div> : <div className="h-full"><div className="flex items-center justify-between border-b border-border px-3 py-2"><span className="truncate font-mono text-[10px] text-primary">{content?.path ?? selectedPath}</span><button type="button" data-testid="button-copy-file" onClick={() => navigator.clipboard?.writeText(content?.content ?? '')} className="text-muted-foreground hover:text-foreground"><Copy className="h-3 w-3" /></button></div><pre className="rewind-scroll max-h-[380px] overflow-auto p-3 font-mono text-[10px] leading-5 text-slate-300">{content?.content ?? 'No content returned.'}</pre></div>}</div></div>}</section>;
}

function DiffPanel({ query, compareBranch, onClose }: { query: any; compareBranch: any; onClose: () => void }) {
  return <section className="border-t border-primary/20 bg-[#0c1517]"><div className="flex items-center justify-between border-b border-border px-4 py-3"><div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-primary"><GitCompare className="h-3.5 w-3.5" /> branch comparison <span className="text-muted-foreground">vs {compareBranch?.id.slice(0, 8)}</span></div><button type="button" data-testid="button-close-diff" onClick={onClose}><X className="h-4 w-4 text-muted-foreground hover:text-foreground" /></button></div>{query.isLoading ? <div className="p-4 font-mono text-[11px] text-muted-foreground">Calculating patch…</div> : query.isError ? <div className="p-4"><QueryError onRetry={() => query.refetch()} /></div> : !query.data ? <div className="p-4 font-mono text-[11px] text-muted-foreground">A second branch is required to compare trajectory points.</div> : <div className="grid gap-3 p-4 md:grid-cols-[180px_1fr]"><div><p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">changed files</p><div className="mt-2 space-y-1">{query.data.files.map((file: string) => <div key={file} className="truncate font-mono text-[10px] text-amber-200">{file}</div>)}</div></div><pre className="rewind-scroll max-h-48 overflow-auto border border-border/70 bg-[#090d12] p-3 font-mono text-[10px] leading-5 text-slate-300">{query.data.patch}</pre></div>}</section>;
}

function ForkModal({ branch, stepIndex, onClose, mutation, onSuccess }: { branch: any; stepIndex: number; onClose: () => void; mutation: any; onSuccess: (created: any[]) => void }) {
  const [modelId, setModelId] = useState(branch?.modelId ?? 'anthropic/claude-sonnet-4');
  const [editedTaskPrompt, setEditedTaskPrompt] = useState(branch?.taskPrompt ?? '');
  const [count, setCount] = useState(1);
  const submit = () => {
    if (!branch || mutation.isPending) return;
    mutation.mutate({ id: branch.id, data: { stepIndex, modelId, editedTaskPrompt: editedTaskPrompt.trim() || null, count } }, { onSuccess });
  };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"><div role="dialog" aria-modal="true" className="fade-up w-full max-w-lg border border-primary/30 bg-[#10171b] p-5 shadow-2xl"><div className="flex items-start justify-between"><div><div className="flex items-center gap-2 font-mono text-xs text-primary"><Split className="h-4 w-4" /> fork trajectory</div><p className="mt-2 font-mono text-[11px] text-muted-foreground">Create a new branch from step {stepIndex}. Original history remains immutable.</p></div><button type="button" data-testid="button-close-fork" onClick={onClose}><X className="h-4 w-4 text-muted-foreground hover:text-foreground" /></button></div><div className="mt-6 space-y-4"><label className="block"><span className="mb-2 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">model</span><select data-testid="select-fork-model" value={modelId} onChange={(event) => setModelId(event.target.value)} className="h-10 w-full border border-input bg-background px-3 font-mono text-xs outline-none focus:border-primary"><option value="anthropic/claude-sonnet-4">Claude Sonnet</option><option value="openai/gpt-4o-mini">GPT-4o mini</option><option value="google/gemini-2.5-flash">Gemini Flash</option><option value="moonshotai/kimi-k2">Kimi K2</option><option value="deepseek/deepseek-chat-v3-0324">DeepSeek V3</option></select></label><label className="block"><span className="mb-2 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">edited task prompt <span className="normal-case text-muted-foreground/60">(optional)</span></span><textarea data-testid="input-fork-prompt" value={editedTaskPrompt} onChange={(event) => setEditedTaskPrompt(event.target.value)} rows={4} className="w-full resize-none border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed outline-none focus:border-primary" /></label><label className="block"><span className="mb-2 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">parallel branches</span><input data-testid="input-fork-count" type="number" min={1} max={5} value={count} onChange={(event) => setCount(Math.max(1, Math.min(5, Number(event.target.value))))} className="h-10 w-24 border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus:border-primary" /></label></div>{mutation.isError && <p className="mt-4 text-[11px] text-red-300">Fork request failed. The original branch is unchanged.</p>}<div className="mt-6 flex justify-end gap-2"><button type="button" data-testid="button-cancel-fork" onClick={onClose} className="border border-border px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground">Cancel</button><button type="button" data-testid="button-submit-fork" disabled={mutation.isPending} onClick={submit} className="flex items-center gap-2 bg-primary px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-primary-foreground disabled:opacity-50">{mutation.isPending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <GitBranch className="h-3.5 w-3.5" />} Create branch</button></div></div></div>;
}

function NotFound() {
  return <AppShell><TopBar /><main className="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-3xl flex-col items-center justify-center px-6 text-center"><div className="mb-5 font-mono text-6xl text-primary/30">404</div><h1 className="font-mono text-xl">Trajectory not found</h1><p className="mt-2 text-sm text-muted-foreground">The route points somewhere Rewind has not recorded.</p><Link href="/" data-testid="link-not-found-home" className="mt-6 border border-primary/40 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-primary hover:bg-primary/10">return to sessions</Link></main></AppShell>;
}

function Landing() {
  return <AppShell><TopBar /><main className="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-5xl flex-col justify-center px-6 py-16"><div className="max-w-2xl"><div className="mb-4 font-mono text-[10px] uppercase tracking-[.24em] text-primary">trajectory debugger</div><h1 className="font-mono text-4xl leading-tight text-foreground sm:text-6xl">Find the moment it changed.</h1><p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground">Rewind coding-agent sessions, inspect the exact context and repository state, and branch from the step where the result went wrong.</p><div className="mt-8 flex flex-wrap gap-3"><Link href="/sign-up" className="bg-primary px-5 py-3 font-mono text-[11px] font-semibold uppercase tracking-wider text-primary-foreground hover:bg-primary/90">Create account</Link><Link href="/sign-in" className="border border-border px-5 py-3 font-mono text-[11px] uppercase tracking-wider text-muted-foreground hover:border-primary/50 hover:text-primary">Sign in</Link></div></div><div className="mt-20 grid gap-px border border-border bg-border sm:grid-cols-3"><div className="bg-card/80 p-5"><p className="font-mono text-[10px] uppercase tracking-wider text-primary">01 / inspect</p><p className="mt-3 font-mono text-sm text-foreground">Scrub every model and tool event.</p></div><div className="bg-card/80 p-5"><p className="font-mono text-[10px] uppercase tracking-wider text-primary">02 / compare</p><p className="mt-3 font-mono text-sm text-foreground">See context, files, and branches side by side.</p></div><div className="bg-card/80 p-5"><p className="font-mono text-[10px] uppercase tracking-wider text-primary">03 / rewind</p><p className="mt-3 font-mono text-sm text-foreground">Fork from the exact moment that mattered.</p></div></div></main></AppShell>;
}

function HomeRedirect() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <AppShell><div className="grid min-h-[100dvh] place-items-center font-mono text-xs text-muted-foreground">loading auth…</div></AppShell>;
  return isSignedIn ? <Home /> : <Landing />;
}

function ProtectedWorkspace() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <AppShell><div className="grid min-h-[100dvh] place-items-center font-mono text-xs text-muted-foreground">loading auth…</div></AppShell>;
  return isSignedIn ? <Workspace /> : <Redirect to="/" />;
}

function SignInPage() {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div>;
}

function SignUpPage() {
  return <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div>;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const prevUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => addListener(({ user }) => {
    const userId = user?.id ?? null;
    if (prevUserId.current !== undefined && prevUserId.current !== userId) queryClient.clear();
    prevUserId.current = userId;
  }), [addListener]);
  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to inspect your agent trajectories' } }, signUp: { start: { title: 'Create your account', subtitle: 'Start debugging coding-agent runs' } } }} routerPush={(to) => setLocation(stripBase(to))} routerReplace={(to) => setLocation(stripBase(to), { replace: true })}><QueryClientProvider client={queryClient}><ClerkQueryClientCacheInvalidator /><TooltipProvider><RoutedErrorBoundary><Router /></RoutedErrorBoundary><Toaster /></TooltipProvider></QueryClientProvider></ClerkProvider>;
}

function Router() {
  return <Switch><Route path="/" component={HomeRedirect} /><Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} /><Route path="/sessions/:id" component={ProtectedWorkspace} /><Route component={NotFound} /></Switch>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  if (!clerkPubKey) throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY.');
  return <WouterRouter base={basePath}><ClerkProviderWithRoutes /></WouterRouter>;
}

export default App;