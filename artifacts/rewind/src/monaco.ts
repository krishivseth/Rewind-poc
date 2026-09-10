// Bundle Monaco locally so the Docker image has no CDN dependency.
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import { loader } from '@monaco-editor/react'

self.MonacoEnvironment = { getWorker: () => new editorWorker() }

monaco.editor.defineTheme('rewind', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#14171d',
    'editor.lineHighlightBackground': '#1a1e26',
    'editorLineNumber.foreground': '#4d5563',
    'editorGutter.background': '#14171d',
    'diffEditor.insertedTextBackground': '#4cc2a02a',
    'diffEditor.removedTextBackground': '#e5646a2a',
    'diffEditor.insertedLineBackground': '#4cc2a018',
    'diffEditor.removedLineBackground': '#e5646a18',
  },
})
loader.config({ monaco })

export const EDITOR_OPTIONS = {
  readOnly: true,
  automaticLayout: true,
  domReadOnly: true,
  minimap: { enabled: false },
  fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
  fontSize: 12,
  lineHeight: 18,
  scrollBeyondLastLine: false,
  renderLineHighlight: 'line' as const,
  wordWrap: 'off' as const,
  smoothScrolling: true,
  padding: { top: 8 },
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
}

const EXT: Record<string, string> = {
  py: 'python', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', json: 'json',
  md: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', html: 'html', css: 'css',
  sh: 'shell', txt: 'plaintext', csv: 'plaintext', sql: 'sql', rs: 'rust', go: 'go', java: 'java', c: 'c', h: 'c', cpp: 'cpp',
}
export function languageFor(path: string): string {
  const name = path.split('/').pop() ?? ''
  if (name === 'Makefile') return 'makefile'
  if (name === '.gitignore' || name === '.rewind.json') return name.endsWith('json') ? 'json' : 'plaintext'
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  return EXT[ext] ?? 'plaintext'
}
