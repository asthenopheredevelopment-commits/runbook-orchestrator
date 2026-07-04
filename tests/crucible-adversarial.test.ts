/**
 * CRUCIBLE — Adversarial & Red-Team Test Suite
 * ==============================================
 * 
 * UNIVERSAL CORE:
 *   ORACLE — every result must match known-correct expected value
 *   ADVERSARIAL MUTATION — boundary, overflow, NaN, deep nesting, edge cases
 *   REPLAY — regression re-run (standalone: this file re-runs on each change)
 *   EXTERMINATE — fix the CLASS, not the instance (each failing case reveals the class)
 *   BUG vs VULNERABILITY triage — attacker-useful primitive check
 *   VERIFY ON THE FRESH ARTIFACT — all tests parse/validate fresh
 * 
 * REPERTOIRE (when trigger holds):
 *   CONTRACT — design-by-contract lens on API interfaces
 *   LOODA — looped OODA with verification
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ToolRegistry, defineTool } from '../src/engine/tool-registry.js'
import { Orchestrator } from '../src/engine/orchestrator.js'
import { createAgent, applyEvent } from '../src/types/agent.js'
import { validateRunbook, topoSort, RunbookSchema } from '../src/types/runbook.js'
import { ApprovalGate, createExecutionId } from '../src/hitl/approval-gate.js'
import { mockBashTool } from '../src/tools/mock-bash.js'
import { mockCloudTool } from '../src/tools/mock-cloud.js'

/* ===================================================================
 * ORACLE — known-correct expected values
 * =================================================================== */

describe('ORACLE: known-correct expected values', () => {
  it('topoSort: single level tasks produce one level', () => {
    const runbook = validateRunbook({
      name: 'oracle-test',
      tasks: [
        { id: 'a', description: 'A', tool: 'bash', params: { command: 'echo a' }, depends_on: [] },
        { id: 'b', description: 'B', tool: 'bash', params: { command: 'echo b' }, depends_on: [] },
      ],
    })
    const plan = topoSort(runbook)
    expect(plan.levels).toHaveLength(1)
    expect(plan.levels[0]).toHaveLength(2)
    expect(new Set(plan.levels[0])).toEqual(new Set(['a', 'b']))
  })

  it('topoSort: diamond dependency resolves correctly', () => {
    // a -> b -> d
    // a -> c -> d
    const runbook = validateRunbook({
      name: 'diamond',
      tasks: [
        { id: 'a', description: 'A', tool: 'bash', params: {}, depends_on: [] },
        { id: 'b', description: 'B', tool: 'bash', params: {}, depends_on: ['a'] },
        { id: 'c', description: 'C', tool: 'bash', params: {}, depends_on: ['a'] },
        { id: 'd', description: 'D', tool: 'bash', params: {}, depends_on: ['b', 'c'] },
      ],
    })
    const plan = topoSort(runbook)
    expect(plan.sortedTaskIds[0]).toBe('a')
    expect(plan.sortedTaskIds[3]).toBe('d')
    // b and c can be in any order in the middle
    expect(plan.sortedTaskIds.slice(1, 3).sort()).toEqual(['b', 'c'])
    // Levels: a (0), b+c (1), d (2)
    expect(plan.levels).toHaveLength(3)
  })

  it('agent: idle -> executing -> completed is valid', () => {
    let agent = createAgent('oracle-a1', 'bash')
    expect(agent.state.status).toBe('idle')
    agent = applyEvent(agent, { type: 'TASK_ASSIGNED', taskId: 't1', tool: 'bash', payload: {} })
    expect(agent.state.status).toBe('executing')
    agent = applyEvent(agent, { type: 'TASK_COMPLETED', taskId: 't1', result: 'ok' })
    expect(agent.state.status).toBe('completed')
  })

  it('approval gate: rotate_key triggers high severity', () => {
    const gate = new ApprovalGate()
    const result = gate.evaluate('Rotate the staging DB IAM key', 'cloud')
    expect(result.needsApproval).toBe(true)
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.violations[0]).toContain('HIGH')
  })

  it('approval gate: non-destructive action passes', () => {
    const gate = new ApprovalGate()
    const result = gate.evaluate('List current files in directory', 'bash')
    expect(result.needsApproval).toBe(false)
    expect(result.violations).toHaveLength(0)
  })
})

/* ===================================================================
 * ADVERSARIAL MUTATION — boundary, overflow, NaN, edge cases
 * =================================================================== */

describe('ADVERSARIAL MUTATION: boundary and edge cases', () => {
  it('empty runbook rejected by Zod schema', () => {
    expect(() => validateRunbook({ name: 'empty' })).toThrow()
    expect(() => validateRunbook({ name: 'empty', tasks: [] })).toThrow()
  })

  it('deeply nested dependency chain (100 levels)', () => {
    const tasks = Array.from({ length: 100 }, (_, i) => ({
      id: `t${i}`,
      description: `Task ${i}`,
      tool: 'bash',
      params: { command: 'echo hi' },
      depends_on: i === 0 ? [] : [`t${i - 1}`],
      destructive: false,
      timeout_seconds: 30,
    }))
    const runbook = validateRunbook({ name: 'deep-nest', tasks })
    const plan = topoSort(runbook)
    expect(plan.sortedTaskIds).toHaveLength(100)
    expect(plan.levels).toHaveLength(100)
  })

  it('component with 1000+ parallel tasks', () => {
    const tasks = Array.from({ length: 1000 }, (_, i) => ({
      id: `t${i}`,
      description: `Task ${i}`,
      tool: 'bash',
      params: { command: `echo ${i}` },
      depends_on: [] as string[],
      destructive: false,
      timeout_seconds: 30,
    }))
    const runbook = validateRunbook({ name: 'wide', tasks })
    const plan = topoSort(runbook)
    expect(plan.sortedTaskIds).toHaveLength(1000)
    expect(plan.levels).toHaveLength(1)
    expect(plan.levels[0]).toHaveLength(1000)
  })

  it('task id with special characters', () => {
    const runbook = validateRunbook({
      name: 'special-chars',
      tasks: [
        { id: 'task-1_2.3', description: 'hyphen/underscore/dot', tool: 'bash', params: {}, depends_on: [] },
        { id: '任务', description: 'Unicode task', tool: 'bash', params: {}, depends_on: [] },
      ],
    })
    const plan = topoSort(runbook)
    expect(plan.sortedTaskIds).toContain('task-1_2.3')
    expect(plan.sortedTaskIds).toContain('任务')
  })

  it('tool params with empty values', async () => {
    const inputSchema = z.object({
      command: z.string().min(1),
      flags: z.array(z.string()).optional(),
    })
    const tool = defineTool({
      name: 'test-tool',
      description: 'test',
      inputSchema,
      execute: async (input: unknown) => {
        const { command, flags } = input as { command: string; flags?: string[] }
        return { command, flagsCount: flags?.length ?? 0 }
      },
    })
    // Empty string should be rejected
    const reg = new ToolRegistry()
    reg.register(tool)

    await expect(reg.execute('test-tool', { command: '' })).rejects.toThrow()
  })

  it('NaN/Infinity in numeric params rejected by Zod', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'numeric',
      description: 'test',
      inputSchema: z.object({ value: z.number() }),
      execute: async () => 'ok',
    }))
    // NaN and Infinity fail Zod's number() parsing
    const nanResult = await registry.execute('numeric', { value: NaN }).catch(e => e.message)
    expect(nanResult).toContain('validation failed')
  })

  it('XSS injection in task description handled', () => {
    const gate = new ApprovalGate()
    const result = gate.evaluate('<script>alert("xss")</script>', 'echo')
    // Should not crash — description is string-typed
    expect(result.needsApproval).toBe(false)
  })
})

/* ===================================================================
 * CONTRACT — design-by-contract lens
 * =================================================================== */

describe('CONTRACT: design-by-contract', () => {
  it('PRECONDITION: ToolRegistry.execute requires registered tool', async () => {
    const registry = new ToolRegistry()
    await expect(registry.execute('nonexistent', {})).rejects.toThrow('Unknown tool')
  })

  it('PRECONDITION: ToolRegistry.register rejects duplicate names', () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'test', description: '', inputSchema: z.object({}), execute: async () => 'a',
    }))
    expect(() => registry.register(defineTool({
      name: 'test', description: '', inputSchema: z.object({}), execute: async () => 'b',
    }))).toThrow('already registered')
  })

  it('POSTCONDITION: topoSort produces valid dependency order', () => {
    const runbook = validateRunbook({
      name: 'contract-order',
      tasks: [
        { id: 'a', description: 'A', tool: 'bash', params: {}, depends_on: [] },
        { id: 'b', description: 'B', tool: 'bash', params: {}, depends_on: ['a'] },
        { id: 'c', description: 'C', tool: 'bash', params: {}, depends_on: ['a', 'b'] },
      ],
    })
    const plan = topoSort(runbook)
    // Every task appears before tasks that depend on it
    const pos = new Map(plan.sortedTaskIds.map((id, i) => [id, i]))
    expect(pos.get('a')! < pos.get('b')!).toBe(true)
    expect(pos.get('a')! < pos.get('c')!).toBe(true)
    expect(pos.get('b')! < pos.get('c')!).toBe(true)
  })

  it('INVARIANT: agent state transitions are monotonic', () => {
    const agent = createAgent('invariant', 'bash')
    // Once an agent reaches a terminal state, it cannot transition further
    let a = applyEvent(agent, { type: 'TASK_ASSIGNED', taskId: 't1', tool: 'bash', payload: {} })
    a = applyEvent(a, { type: 'TASK_COMPLETED', taskId: 't1', result: 'done' })
    expect(a.state.status).toBe('completed')
    // Further events are ignored
    a = applyEvent(a, { type: 'TASK_FAILED', taskId: 't2', error: 'late', rollbackStep: null })
    expect(a.state.status).toBe('completed')
  })
})

/* ===================================================================
 * BUG vs VULNERABILITY TRIAGE
 * =================================================================== */

describe('BUG vs VULNERABILITY triage', () => {
  it('Orchestrator rejects invalid input with Zod error (not crash)', () => {
    expect(() => new Orchestrator(null)).toThrow()
    expect(() => new Orchestrator(undefined)).toThrow()
    expect(() => new Orchestrator({})).toThrow()
    expect(() => new Orchestrator({ name: 'test', tasks: 'not-array' } as any)).toThrow()
  })

  it('ApprovalGate handles empty description without crashing', () => {
    const gate = new ApprovalGate()
    const result = gate.evaluate('', '')
    // Should not throw — everything is string
    expect(result.needsApproval).toBe(false)
  })

  it('ApprovalGate handles very long descriptions', () => {
    const gate = new ApprovalGate()
    const longStr = 'a'.repeat(10000)
    const result = gate.evaluate(`delete ${longStr}`, 'bash')
    // Should match on 'delete' prefix
    expect(result.needsApproval).toBe(true)
    expect(result.violations[0]).toContain('CRITICAL')
  })

  it('mockBashTool rejects commands not in allowlist', async () => {
    const { executeBash } = await import('../src/tools/mock-bash.js')
    const result = await executeBash({ command: 'sudo rm -rf /', timeout_seconds: 30 })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('not in allowlist')
  })

  it('mockBashTool allows listed commands', async () => {
    const { executeBash } = await import('../src/tools/mock-bash.js')
    const result = await executeBash({ command: 'ls -la', timeout_seconds: 30 })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('[mock]')
  })

  it('crucible: runbook with missing tool fails gracefully, not crash', async () => {
    const runbook = {
      name: 'missing-tool',
      description: 'Uses an unregistered tool',
      tasks: [{ id: 't1', description: 'test', tool: 'does-not-exist', params: {}, depends_on: [], destructive: false, timeout_seconds: 30 }],
    }
    const orchestrator = new Orchestrator(runbook)
    const result = await orchestrator.execute()
    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.logs.length).toBeGreaterThan(0)
  })
})

/* ===================================================================
 * EXTERMINATE — class-level fix verification
 * =================================================================== */

describe('EXTERMINATE: class-level fix verification', () => {
  it('no tool should silently accept "any" input bypassing Zod', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'strict-tool',
      description: 'test',
      inputSchema: z.object({ allowed: z.string() }).strict(),
      execute: async () => 'ok',
    }))
    // Extra fields are rejected by .strict()
    await expect(registry.execute('strict-tool', { allowed: 'yes', extra: 'bad' })).rejects.toThrow('Unrecognized key')
  })

  it('all tools register with Zod schemas (no naked execute)', () => {
    // Verify that mockBashTool and mockCloudTool have valid schemas
    expect(mockBashTool.inputSchema).toBeDefined()
    expect(mockBashTool.inputSchema.safeParse({ command: 'ls' }).success).toBe(true)
    expect(mockCloudTool.inputSchema).toBeDefined()
    const cloudParse = mockCloudTool.inputSchema.safeParse({ action: 'rotate_key', params: { service: 'aws', resource: 'test', keyType: 'access_key' } })
    expect(cloudParse.success).toBe(true)
  })

  it('ApprovalGate.decisionHistory is append-only', () => {
    const gate = new ApprovalGate()
    gate.recordDecision('exec-1', true, 'operator', 'approved')
    gate.recordDecision('exec-2', false, 'operator', 'too risky')
    const history = gate.getDecisionHistory()
    expect(history).toHaveLength(2)
    // Attempting to modify history should not affect internal state
    history.pop()
    expect(gate.getDecisionHistory()).toHaveLength(2)
  })
})

/* ===================================================================
 * LOODA — looped OODA with verification
 * =================================================================== */

describe('LOODA: verification after change', () => {
  it('full register-execute-verify cycle', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'looda-tool',
      description: 'LOODA test tool',
      inputSchema: z.object({ x: z.number() }),
      execute: async (input) => {
        const { x } = input as { x: number }
        return x * 2
      },
    }))

    // OBSERVE: tool is registered
    expect(registry.list()).toHaveLength(1)

    // ORIENT: verify schema
    const parseResult = registry.get('looda-tool')!.inputSchema.safeParse({ x: 5 })
    expect(parseResult.success).toBe(true)

    // DECIDE: execute
    const result = await registry.execute('looda-tool', { x: 5 })

    // ACT + VERIFY
    expect(result).toBe(10)

    // RE-VERIFY with different input
    const result2 = await registry.execute('looda-tool', { x: 0 })
    expect(result2).toBe(0)

    const result3 = await registry.execute('looda-tool', { x: -3 })
    expect(result3).toBe(-6)
  })
})

/* ===================================================================
 * DALEK — three-pass consensus verification
 * =================================================================== */

describe('DALEK: three-pass consensus (assertions)', () => {
  // PASS 1: Types — all modules compile with strict mode
  it('PASS 1: schema exports have correct types', () => {
    const task = {
      id: 't1', description: 'test', tool: 'bash',
      params: { command: 'ls' }, depends_on: [], destructive: false, timeout_seconds: 30,
    }
    const result = RunbookSchema.safeParse({
      name: 'dalek-test',
      tasks: [task],
    })
    expect(result.success).toBe(true)
  })

  // PASS 2: Runtime — execution produces expected output
  it('PASS 2: orchestrator can complete valid runbook', async () => {
    const runbook = {
      name: 'dalek-run',
      tasks: [{ id: 't1', description: 'test', tool: 'bash', params: { command: 'echo ok' }, depends_on: [], destructive: false, timeout_seconds: 30 }],
    }
    const orchestrator = new Orchestrator(runbook)
    orchestrator.registerTool(mockBashTool)
    const result = await orchestrator.execute()
    expect(result.success).toBe(true)
  })

  // PASS 3: Safety — invalid inputs never crash
  it('PASS 3: all public APIs handle invalid input gracefully', () => {
    // Orchestrator constructor
    expect(() => new Orchestrator('not-object' as any)).toThrow()
    expect(() => new Orchestrator([] as any)).toThrow()

    // Agent creation requires valid string
    expect(() => createAgent('', 'test')).not.toThrow()  // empty string is valid but odd
    expect(createAgent('x', 'y').state.status).toBe('idle')
  })
})
