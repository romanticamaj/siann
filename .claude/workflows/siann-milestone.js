export const meta = {
  name: 'siann-milestone',
  description: 'Run one SIANN milestone: spec check, TDD implementation per feature in worktrees, independent verification, spec review, landing, exit check',
  whenToUse: 'When the maintainer asks to run a milestone, e.g. "用 siann-milestone workflow 跑 M2". Args: {milestone: "M2", features?: [ids], maxRounds?: 2, land?: true, checked?: false}',
  phases: [
    { title: 'Preflight', detail: 'read the manifest, check main, CI and the local checks' },
    { title: 'Plan', detail: 'Fable checks each feature against the spec', model: 'fable' },
    { title: 'Build', detail: 'per feature: Opus TDD in a worktree, verify, spec review, fix loop', model: 'opus' },
    { title: 'Land', detail: 'rebase, CI green on all platforms, merge, one feature at a time' },
    { title: 'Exit', detail: 'check the exit criteria and update the spec and manifest' },
  ],
}

// ---------------------------------------------------------------- inputs
const input = typeof args === 'string' ? { milestone: args } : (args || {})
const M = input.milestone
if (!M) throw new Error('args.milestone is required, e.g. {milestone: "M2"}')
const MAX_ROUNDS = input.maxRounds || 2
const LAND = input.land !== false
// checked: true means the caller already confirmed main CI is green; preflight then only reads the manifest.
const CHECKED = input.checked === true
const ONLY = Array.isArray(input.features) && input.features.length ? input.features : null

const RULES = 'docs/harness/agent-rules.md'
const SPEC = 'docs/superpowers/specs/2026-10-14-siann-native-daw-architecture.md'
const MANIFEST = `.claude/milestones/${M}.json`

const common = `You work on the SIANN repository (D:\\projects\\siann, Windows, Git Bash and PowerShell available). ` +
  `Read ${RULES} first and follow it exactly; it overrides your defaults. ` +
  `The architecture spec is ${SPEC}; the milestone manifest is ${MANIFEST}.`

// ---------------------------------------------------------------- schemas
const PREFLIGHT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
    manifest: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string' },
        humanGates: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
        features: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              wave: { type: 'number' },
              dependsOn: { type: 'array', items: { type: 'string' } },
              done: { type: 'boolean' },
            },
            required: ['id', 'title', 'wave', 'dependsOn', 'done'],
          },
        },
        exit: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] } },
      },
      required: ['id', 'features', 'exit'],
    },
  },
  required: ['ok', 'problems', 'manifest'],
}

const PLAN = {
  type: 'object',
  properties: {
    verdict: { enum: ['ready', 'needs_spec_change', 'needs_human'] },
    plan: { type: 'string', description: 'concrete TDD plan: files, tests to write first, order of steps' },
    specIssues: { type: 'array', items: { type: 'string' } },
    question: { type: 'string', description: 'when needs_human: the one decision the maintainer must make' },
  },
  required: ['verdict', 'plan', 'specIssues'],
}

const BUILD = {
  type: 'object',
  properties: {
    status: { enum: ['done', 'blocked'] },
    branch: { type: 'string' },
    commits: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'array', items: { type: 'string' } },
    checkAll: { type: 'string', description: 'last lines of node scripts/check-all.js --changed' },
    blocker: { type: 'string' },
  },
  required: ['status', 'branch', 'commits', 'checkAll'],
}

const REVIEW = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { enum: ['blocker', 'major', 'minor'] },
          where: { type: 'string' },
          problem: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['severity', 'where', 'problem'],
      },
    },
  },
  required: ['pass', 'findings'],
}

const LANDING = {
  type: 'object',
  properties: {
    status: { enum: ['merged', 'blocked'] },
    pr: { type: 'string' },
    blocker: { type: 'string' },
  },
  required: ['status'],
}

const EXIT = {
  type: 'object',
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { enum: ['met', 'not_met', 'needs_human'] },
          evidence: { type: 'string' },
        },
        required: ['id', 'status', 'evidence'],
      },
    },
    pr: { type: 'string' },
  },
  required: ['criteria'],
}

const blocking = (r) => (r && r.findings ? r.findings.filter((f) => f.severity !== 'minor') : [])
const fmt = (fs) => fs.map((f, i) => `${i + 1}. [${f.severity}] ${f.where}: ${f.problem}${f.evidence ? ` (evidence: ${f.evidence})` : ''}`).join('\n')

// ---------------------------------------------------------------- preflight
phase('Preflight')
const pre = await agent(
  `${common}\n\nPreflight for milestone ${M}. Do not modify any file.\n` +
  `1. Read ${MANIFEST} and return it (id, status, humanGates, features with done=true for features whose work is already merged on main — check git log and the code, exit).\n` +
  `2. Check: the working tree of the main checkout is clean or only has unrelated untracked files; origin/main is fetched; the latest CI run on main is green (gh run list --branch main --limit 1; if it is still running, wait for it with gh run watch <id> --exit-status and do not give up early).\n` +
  `3. CI on main covers Windows, macOS, Linux and GCC, so a green run for the current origin/main commit is enough. Only if that run is red or missing, run \`node scripts/check-all.js --all\` on a fresh worktree of origin/main (git worktree add, then remove it) and wait for it to finish (several minutes: run it in the foreground with a long timeout) before reporting.\n` +
  (CHECKED ? `The caller already confirmed that CI on main is green: skip steps 2 and 3 and only do step 1 plus the prerequisite check.\n` : ``) +
  `Set ok=false with problems listed when any check fails or a prerequisite in the manifest is not met.`,
  { label: `preflight ${M}`, schema: PREFLIGHT, effort: 'medium' },
)
if (!pre) throw new Error('preflight agent failed')
if (!pre.ok) return { milestone: M, stopped: 'preflight', problems: pre.problems }

const manifest = pre.manifest
let features = manifest.features.filter((f) => !f.done)
if (ONLY) features = features.filter((f) => ONLY.includes(f.id))
if (!features.length) log(`${M}: all features already done; going to the exit check`)
log(`${M}: ${features.length} feature(s) to build: ${features.map((f) => f.id).join(', ')}`)

// ---------------------------------------------------------------- plan (Fable)
phase('Plan')
const plans = {}
const planned = await parallel(features.map((f) => () =>
  agent(
    `${common}\n\nSpec check for feature ${f.id} ("${f.title}") of ${M}. Do not modify any file.\n` +
    `Read the feature's specRefs and acceptance in the manifest and the referenced spec sections, then the existing code it builds on.\n` +
    `Decide whether the acceptance criteria are consistent with the spec and implementable as written. ` +
    `Return verdict=ready with a concrete TDD plan (failing tests first, files, steps), ` +
    `needs_spec_change when the spec is wrong or contradicts the acceptance (list the issues and the exact correction), ` +
    `or needs_human when a decision belongs to the maintainer (state the one question).`,
    { label: `spec ${f.id}`, phase: 'Plan', model: 'fable', schema: PLAN },
  ).then((p) => ({ f, p }))))

const needsHuman = []
for (const r of planned.filter(Boolean)) {
  if (!r.p) continue
  plans[r.f.id] = r.p
  if (r.p.verdict === 'needs_human') needsHuman.push({ feature: r.f.id, question: r.p.question })
}
if (needsHuman.length) return { milestone: M, stopped: 'plan', needsHuman, plans }

// ---------------------------------------------------------------- build + land, wave by wave
const results = {}
const failed = new Set()
const waves = [...new Set(features.map((f) => f.wave))].sort((a, b) => a - b)

for (const wave of waves) {
  const inWave = features.filter((f) => f.wave === wave)
  const ready = inWave.filter((f) => !f.dependsOn.some((d) => failed.has(d)))
  for (const f of inWave.filter((x) => !ready.includes(x))) {
    failed.add(f.id)
    results[f.id] = { status: 'skipped', reason: 'a dependency failed' }
  }
  log(`wave ${wave}: ${ready.map((f) => f.id).join(', ')}`)

  phase('Build')
  const built = await pipeline(
    ready,
    // implement (Opus, own worktree)
    (f) => {
      const p = plans[f.id]
      const specNote = p && p.verdict === 'needs_spec_change'
        ? `\nThe spec check found spec issues; fix the spec text in the same branch as part of this feature (docs commit first):\n- ${p.specIssues.join('\n- ')}\n`
        : ''
      return agent(
        `${common}\n\nImplement feature ${f.id} ("${f.title}") of ${M} with TDD in this worktree.\n` +
        `Branch: ms/${M}/${f.id} from origin/main. Acceptance criteria are in the manifest; meet every one.\n` +
        `Plan from the spec check:\n${p ? p.plan : '(none)'}\n${specNote}` +
        `Write the failing tests first and commit them, then the implementation. ` +
        `Run \`node scripts/check-all.js --changed\` (it picks the steps from your paths, desktop included for host_desktop) until it passes. ` +
        `Commit with Conventional Commit subjects and the attribution lines from ${RULES}. Do not push and do not open a PR. ` +
        `Return status=blocked with the reason when you hit a stop condition from ${RULES}.`,
        { label: `build ${f.id}`, phase: 'Build', model: 'opus', isolation: 'worktree', schema: BUILD },
      )
    },
    // verify, spec review, fix loop
    async (b, f) => {
      if (!b || b.status !== 'done') return { f, b, ok: false, reason: b ? b.blocker : 'build agent failed' }
      let last = b
      for (let round = 0; round <= MAX_ROUNDS; round += 1) {
        const [verify, spec] = await parallel([
          () => agent(
            `${common}\n\nIndependent verification of branch ${last.branch} (feature ${f.id} of ${M}). You did not write this code; assume it is wrong until shown otherwise. Do not modify files.\n` +
            `Check out the branch in a fresh worktree, run \`node scripts/check-all.js --changed\`, read the diff against origin/main, and check: ` +
            `every acceptance criterion has a test that would fail without the change; tests are deterministic; realtime rules from ${RULES} hold (no allocation, locks or I/O on the audio thread); ` +
            `no behaviour regressions; GCC and MSVC warnings clean; ` +
            `the feature's row in docs/harness/test-matrix.md exists, names only tests that exist on the branch, and lists every platform skip or env gate the branch adds (the rules in its section 8). ` +
            `Report findings with evidence (file:line, command output).`,
            { label: `verify ${f.id} r${round}`, phase: 'Build', schema: REVIEW },
          ),
          () => agent(
            `${common}\n\nSpec conformance review of branch ${last.branch} (feature ${f.id} of ${M}). Do not modify files.\n` +
            `Compare the implementation and its tests with the spec sections in the feature's specRefs and with the acceptance criteria. ` +
            `Report each place where the code contradicts the spec, silently narrows it, or the spec needs an update to match a justified change.`,
            { label: `spec review ${f.id} r${round}`, phase: 'Build', model: 'fable', schema: REVIEW },
          ),
        ])
        const issues = [...blocking(verify), ...blocking(spec)]
        if (verify && spec && issues.length === 0) return { f, b: last, ok: true, rounds: round, minor: [...(verify.findings || []), ...(spec.findings || [])] }
        if (round === MAX_ROUNDS) return { f, b: last, ok: false, reason: `findings remain after ${MAX_ROUNDS} fix rounds`, findings: issues }
        const fixed = await agent(
          `${common}\n\nFix round ${round + 1} for branch ${last.branch} (feature ${f.id} of ${M}). Check out the branch in this worktree and address every finding below. ` +
          `For each: add or adjust a test that exposes it first, then fix. Run \`node scripts/check-all.js --changed\`. Commit; do not push.\n` +
          `If you believe a finding is wrong, do not change code for it; explain why in a commit-free note in your result.\n\n${fmt(issues)}`,
          { label: `fix ${f.id} r${round + 1}`, phase: 'Build', model: 'opus', isolation: 'worktree', schema: BUILD },
        )
        if (!fixed || fixed.status !== 'done') return { f, b: last, ok: false, reason: fixed ? fixed.blocker : 'fix agent failed' }
        last = fixed
      }
      return { f, b: last, ok: false, reason: 'unreachable' }
    },
  )

  // landing is sequential: each merge changes main for the next one
  phase('Land')
  for (const r of built.filter(Boolean)) {
    if (!r.ok) {
      failed.add(r.f.id)
      results[r.f.id] = { status: 'failed', reason: r.reason, findings: r.findings, branch: r.b && r.b.branch }
      continue
    }
    if (!LAND) {
      results[r.f.id] = { status: 'verified', branch: r.b.branch, minor: r.minor }
      continue
    }
    const landed = await agent(
      `${common}\n\nLand branch ${r.b.branch} (feature ${r.f.id} of ${M}).\n` +
      `Rebase it on the latest origin/main and rerun \`node scripts/check-all.js --changed\`. ` +
      `Push and open a PR following the landing steps in ${RULES} (account switching, PR body format with the acceptance checklist and the verification evidence). ` +
      `Wait for CI on all platforms. If CI fails, fix it on the branch (test first) and push again; stop with status=blocked after the second red run. ` +
      `When green, merge with a merge commit and delete the branch, then switch the gh account back. Minor findings to list in the PR body as follow-ups:\n${fmt(r.minor || []) || '(none)'}`,
      { label: `land ${r.f.id}`, phase: 'Land', schema: LANDING },
    )
    if (!landed || landed.status !== 'merged') {
      failed.add(r.f.id)
      results[r.f.id] = { status: 'failed', reason: landed ? landed.blocker : 'land agent failed', branch: r.b.branch }
    } else {
      results[r.f.id] = { status: 'merged', pr: landed.pr, rounds: r.rounds }
    }
  }
  // features from the same wave that failed block their dependants; independent ones continue
  for (const f of ready) if (!results[f.id]) { failed.add(f.id); results[f.id] = { status: 'failed', reason: 'no result' } }
}

// ---------------------------------------------------------------- exit
phase('Exit')
const allMerged = features.every((f) => results[f.id] && results[f.id].status === 'merged')
let exit = null
if (allMerged && !ONLY) {
  exit = await agent(
    `${common}\n\nExit check for ${M}. For each exit criterion in the manifest, run or inspect what its "how" says and decide met / not_met / needs_human (hardware, accounts, long runs or judgement the maintainer must give). ` +
    `Then on branch ms/${M}/exit: update the milestone status and evidence table in the spec, set the manifest status to "done" only when every criterion is met (otherwise "exit_pending"), move finished features into "done", and land it through a PR as in ${RULES}.`,
    { label: `exit ${M}`, phase: 'Exit', schema: EXIT },
  )
} else {
  log(ONLY ? 'subset run: exit check skipped' : 'not every feature merged: exit check skipped')
}

return {
  milestone: M,
  features: results,
  exit,
  humanGates: manifest.humanGates || [],
  next: allMerged ? 'review the exit criteria marked needs_human' : 'resolve failed features, then rerun with {milestone, features: [...]}',
}
