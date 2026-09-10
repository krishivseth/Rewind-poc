import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const baseRoot = path.join(tmpdir(), "rewind-base-repos");
const worktreeRoot = path.join(tmpdir(), "rewind-worktrees");
const bundleRoot = path.join(tmpdir(), "rewind-bundles");
const repoLocks = new Map<string, Promise<string>>();

const fixtures: Record<string, Record<string, string>> = {
  "csv-stats": {
    "csv_stats.py": `def row_count(rows):\n    return len(rows) - 1\n\n\ndef average(values):\n    if not values:\n        return 0\n    return sum(values) / len(values)\n`,
    "test_csv_stats.py": `import unittest\nfrom csv_stats import average, row_count\n\n\nclass CsvStatsTests(unittest.TestCase):\n    def test_row_count_uses_data_rows(self):\n        self.assertEqual(row_count([[\"a\"], [\"b\"]]), 2)\n\n    def test_average_empty(self):\n        self.assertEqual(average([]), 0)\n\n\nif __name__ == \"__main__\":\n    unittest.main()\n`,
    "README.md": "# csv-stats\n\nSmall helpers used by a CSV statistics CLI.\n",
  },
  "tiny-todo": {
    "todo.py": `def add_todo(items, title):\n    title = title.strip()\n    if not title:\n        raise ValueError(\"title is required\")\n    return [*items, {\"title\": title, \"done\": False}]\n\n\ndef complete_todo(items, index):\n    updated = list(items)\n    updated[index] = {**updated[index], \"done\": True}\n    return updated\n`,
    "test_todo.py": `import unittest\nfrom todo import add_todo, complete_todo\n\n\nclass TodoTests(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add_todo([], \"Ship\"), [{\"title\": \"Ship\", \"done\": False}])\n\n    def test_complete(self):\n        self.assertTrue(complete_todo([{\"title\": \"Ship\", \"done\": False}], 0)[0][\"done\"])\n\n\nif __name__ == \"__main__\":\n    unittest.main()\n`,
    "README.md": "# tiny-todo\n\nA small todo domain module with unit tests.\n",
  },
  "rate-limiter": {
    "rate-limiter.js": `export class TokenBucket {\n  constructor(capacity) {\n    this.capacity = capacity;\n    this.tokens = capacity;\n  }\n\n  take(count = 1) {\n    if (this.tokens < count) return false;\n    this.tokens -= count;\n    return true;\n  }\n}\n`,
    "rate-limiter.test.js": `import test from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { TokenBucket } from \"./rate-limiter.js\";\n\ntest(\"does not exceed capacity\", () => {\n  const bucket = new TokenBucket(2);\n  assert.equal(bucket.take(), true);\n  assert.equal(bucket.take(), true);\n  assert.equal(bucket.take(), false);\n});\n`,
    "package.json": `{\"type\":\"module\",\"scripts\":{\"test\":\"node --test\"}}\n`,
    "README.md": "# rate-limiter\n\nA minimal token bucket implementation.\n",
  },
};

async function git(cwd: string, args: string[], timeout = 60_000) {
  const result = await execFileAsync("git", args, { cwd, timeout, maxBuffer: 2_000_000 });
  return `${result.stdout}${result.stderr}`.trim();
}

async function ensureBareRepository(slug: string) {
  const existing = repoLocks.get(slug);
  if (existing) return existing;
  const pending = (async () => {
    await mkdir(baseRoot, { recursive: true });
    const barePath = path.join(baseRoot, `${slug}.git`);
    try {
      await stat(barePath);
      return barePath;
    } catch {
      // Create the seed repository below.
    }
    const seedPath = await mkdtemp(path.join(tmpdir(), `rewind-seed-${slug}-`));
    await git(seedPath, ["init", "-b", "main"]);
    await git(seedPath, ["config", "user.email", "rewind@local"]);
    await git(seedPath, ["config", "user.name", "Rewind Agent"]);
    for (const [filePath, content] of Object.entries(fixtures[slug] ?? fixtures["tiny-todo"])) {
      const target = path.join(seedPath, filePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
    await git(seedPath, ["add", "-A"]);
    await git(seedPath, ["commit", "-m", "Seed repository"]);
    await git(seedPath, ["clone", "--bare", ".", barePath]);
    await rm(seedPath, { recursive: true, force: true });
    return barePath;
  })();
  repoLocks.set(slug, pending);
  return pending;
}

function safePath(root: string, requested: string) {
  const resolved = path.resolve(root, requested);
  if (!resolved.startsWith(`${root}${path.sep}`) || requested.includes(".git")) {
    throw new Error("Path is outside the worktree.");
  }
  return resolved;
}

function truncate(value: string, max = 30_000) {
  return value.length > max ? `${value.slice(0, max)}\n…output truncated…` : value;
}

export type AgentToolName = "list_files" | "read_file" | "write_file" | "edit_file" | "run_tests" | "git_diff";
export type AgentToolResult = {
  output: string;
  filesChanged: string[];
  snapshot?: { path: string; content: string };
};

export async function createAgentWorktree(slug: string, branchId: string) {
  const barePath = await ensureBareRepository(slug);
  await Promise.all([
    mkdir(worktreeRoot, { recursive: true }),
    mkdir(bundleRoot, { recursive: true }),
  ]);
  const root = await mkdtemp(path.join(worktreeRoot, `${branchId.slice(0, 8)}-`));
  await git(tmpdir(), ["--git-dir", barePath, "worktree", "add", "--detach", root, "HEAD"]);
  await git(root, ["config", "user.email", "rewind@local"]);
  await git(root, ["config", "user.name", "Rewind Agent"]);

  return {
    root,
    async execute(name: AgentToolName, args: Record<string, unknown>): Promise<AgentToolResult> {
      if (name === "list_files") {
        return { output: await git(root, ["ls-files"]), filesChanged: [] };
      }
      if (name === "read_file") {
        const requested = String(args.path ?? "");
        const content = await readFile(safePath(root, requested), "utf8");
        return { output: truncate(content), filesChanged: [], snapshot: { path: requested, content } };
      }
      if (name === "write_file") {
        const requested = String(args.path ?? "");
        const content = String(args.content ?? "");
        if (!requested || content.length > 100_000) throw new Error("Invalid file write.");
        const target = safePath(root, requested);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content, "utf8");
        return { output: `Wrote ${requested}`, filesChanged: [requested], snapshot: { path: requested, content } };
      }
      if (name === "edit_file") {
        const requested = String(args.path ?? "");
        const oldString = String(args.old_string ?? "");
        const newString = String(args.new_string ?? "");
        const target = safePath(root, requested);
        const current = await readFile(target, "utf8");
        if (!oldString || !current.includes(oldString)) throw new Error("old_string was not found.");
        const content = current.replace(oldString, newString);
        await writeFile(target, content, "utf8");
        return { output: `Edited ${requested}`, filesChanged: [requested], snapshot: { path: requested, content } };
      }
      if (name === "run_tests") {
        const files = await git(root, ["ls-files"]);
        const command = files.includes("package.json")
          ? ["npm", ["test"]] as const
          : ["python", ["-m", "unittest", "discover", "-v"]] as const;
        try {
          const result = await execFileAsync(command[0], command[1], { cwd: root, timeout: 90_000, maxBuffer: 2_000_000 });
          return { output: truncate(`${result.stdout}${result.stderr}`.trim()), filesChanged: [] };
        } catch (error) {
          const failure = error as { stdout?: string; stderr?: string; message?: string };
          return { output: truncate(`${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim() || failure.message || "Tests failed."), filesChanged: [] };
        }
      }
      if (name === "git_diff") {
        return { output: truncate(await git(root, ["diff", "--no-ext-diff"])), filesChanged: [] };
      }
      throw new Error(`Unsupported tool: ${name}`);
    },
    async finalize() {
      const changed = (await git(root, ["diff", "--name-only", "HEAD"]))
        .split("\n")
        .filter(Boolean);
      if (changed.length) {
        await git(root, ["add", "-A"]);
        await git(root, ["commit", "-m", `Rewind agent run ${branchId.slice(0, 8)}`]);
      }
      const commitHash = await git(root, ["rev-parse", "HEAD"]);
      const bundleKey = path.join(bundleRoot, `${branchId}.bundle`);
      await git(root, ["bundle", "create", bundleKey, "HEAD"]);
      return { changed, commitHash, bundleKey };
    },
    async cleanup() {
      await git(tmpdir(), ["--git-dir", barePath, "worktree", "remove", "--force", root]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}