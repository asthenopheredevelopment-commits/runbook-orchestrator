import { describe, it, expect } from 'vitest'
import { createAgent, applyEvent, type AgentEvent } from '../src/types/agent.js'

describe('Agent state machine', () => {
  it('starts in idle state', () => {
    const agent = createAgent('agent-1', 'bash')
    expect(agent.state.status).toBe('idle')
    expect(agent.id).toBe('agent-1')
    expect(agent.role).toBe('bash')
    expect(agent.taskHistory).toHaveLength(0)
  })

  it('transitions from idle to executing on TASK_ASSIGNED', () => {
    let agent = createAgent('agent-1', 'bash')
    const event: AgentEvent = {
      type: 'TASK_ASSIGNED',
      taskId: 'task-1',
      tool: 'bash',
      payload: { command: 'ls' },
    }
    agent = applyEvent(agent, event)
    expect(agent.state.status).toBe('executing')
    if (agent.state.status === 'executing') {
      expect(agent.state.tool).toBe('bash')
      expect(agent.state.payload).toEqual({ command: 'ls' })
    }
    expect(agent.taskHistory).toHaveLength(1)
    expect(agent.taskHistory[0]?.status).toBe('executing')
  })

  it('transitions from idle to awaiting_approval via APPROVAL_REQUIRED', () => {
    let agent = createAgent('agent-1', 'cloud')
    agent = applyEvent(agent, {
      type: 'TASK_ASSIGNED',
      taskId: 'task-1',
      tool: 'cloud',
      payload: { action: 'rotate_key' },
    })
    agent = applyEvent(agent, {
      type: 'APPROVAL_REQUIRED',
      executionId: 'exec-1',
      policyViolation: '[HIGH] Credential Rotation',
      taskId: 'task-1',
    })
    expect(agent.state.status).toBe('awaiting_approval')
    if (agent.state.status === 'awaiting_approval') {
      expect(agent.state.executionId).toBe('exec-1')
      expect(agent.state.policyViolation).toBe('[HIGH] Credential Rotation')
    }
  })

  it('resumes execution on APPROVAL_GRANTED', () => {
    let agent = createAgent('agent-1', 'cloud')
    agent = applyEvent(agent, { type: 'TASK_ASSIGNED', taskId: 't1', tool: 'cloud', payload: {} })
    agent = applyEvent(agent, { type: 'APPROVAL_REQUIRED', executionId: 'e1', policyViolation: 'test', taskId: 't1' })
    agent = applyEvent(agent, { type: 'APPROVAL_GRANTED', executionId: 'e1' })
    expect(agent.state.status).toBe('executing')
  })

  it('fails on APPROVAL_DENIED', () => {
    let agent = createAgent('agent-1', 'cloud')
    agent = applyEvent(agent, { type: 'TASK_ASSIGNED', taskId: 't1', tool: 'cloud', payload: {} })
    agent = applyEvent(agent, { type: 'APPROVAL_REQUIRED', executionId: 'e1', policyViolation: 'test', taskId: 't1' })
    agent = applyEvent(agent, { type: 'APPROVAL_DENIED', executionId: 'e1' })
    expect(agent.state.status).toBe('failed')
    if (agent.state.status === 'failed') {
      expect(agent.state.error).toContain('Approval denied')
    }
  })

  it('transitions to completed on TASK_COMPLETED', () => {
    let agent = createAgent('agent-1', 'bash')
    agent = applyEvent(agent, { type: 'TASK_ASSIGNED', taskId: 't1', tool: 'bash', payload: { command: 'ls' } })
    agent = applyEvent(agent, { type: 'TASK_COMPLETED', taskId: 't1', result: { stdout: 'file1.txt' } })
    expect(agent.state.status).toBe('completed')
    if (agent.state.status === 'completed') {
      expect(agent.state.result).toEqual({ stdout: 'file1.txt' })
    }
  })

  it('transitions to failed on TASK_FAILED', () => {
    let agent = createAgent('agent-1', 'bash')
    agent = applyEvent(agent, { type: 'TASK_ASSIGNED', taskId: 't1', tool: 'bash', payload: {} })
    agent = applyEvent(agent, { type: 'TASK_FAILED', taskId: 't1', error: 'Command not found', rollbackStep: null })
    expect(agent.state.status).toBe('failed')
    if (agent.state.status === 'failed') {
      expect(agent.state.error).toBe('Command not found')
      expect(agent.state.rollbackStep).toBeNull()
    }
  })

  it('records task history for each transition', () => {
    let agent = createAgent('agent-1', 'bash')
    agent = applyEvent(agent, { type: 'TASK_ASSIGNED', taskId: 't1', tool: 'bash', payload: {} })
    agent = applyEvent(agent, { type: 'TASK_COMPLETED', taskId: 't1', result: 'done' })
    expect(agent.taskHistory).toHaveLength(2)
    expect(agent.taskHistory[0]?.status).toBe('executing')
    expect(agent.taskHistory[1]?.status).toBe('completed')
  })

  it('ignores invalid transitions (already completed)', () => {
    let agent = createAgent('agent-1', 'bash')
    agent = applyEvent(agent, { type: 'TASK_ASSIGNED', taskId: 't1', tool: 'bash', payload: {} })
    agent = applyEvent(agent, { type: 'TASK_COMPLETED', taskId: 't1', result: 'done' })

    agent = applyEvent(agent, { type: 'TASK_FAILED', taskId: 't2', error: 'late', rollbackStep: null })
    expect(agent.state.status).toBe('completed')
    expect(agent.taskHistory).toHaveLength(2)
  })
})

describe('Runbook topology sort', () => {
  it('validates a valid runbook', async () => {
    const { validateRunbook } = await import('../src/types/runbook.js')
    const runbook = validateRunbook({
      name: 'test',
      description: 'test runbook',
      tasks: [{ id: 't1', description: 'task 1', tool: 'bash', params: { command: 'ls' }, depends_on: [] }],
    })
    expect(runbook.name).toBe('test')
    expect(runbook.tasks).toHaveLength(1)
  })

  it('rejects runbook with empty name', async () => {
    const { validateRunbook } = await import('../src/types/runbook.js')
    expect(() => validateRunbook({
      name: '',
      tasks: [],
    })).toThrow()
  })

  it('performs topological sort on independent tasks', async () => {
    const { validateRunbook, topoSort } = await import('../src/types/runbook.js')
    const runbook = validateRunbook({
      name: 'test',
      tasks: [
        { id: 'c', description: 'c', tool: 'bash', params: {}, depends_on: ['a'] },
        { id: 'a', description: 'a', tool: 'bash', params: {}, depends_on: [] },
        { id: 'b', description: 'b', tool: 'bash', params: {}, depends_on: ['a'] },
      ],
    })
    const plan = topoSort(runbook)
    expect(plan.sortedTaskIds).toEqual(['a', 'c', 'b'])
    expect(plan.levels).toHaveLength(2)
    expect(plan.levels[0]).toEqual(['a'])
  })

  it('detects circular dependencies', async () => {
    const { validateRunbook, topoSort } = await import('../src/types/runbook.js')
    const runbook = validateRunbook({
      name: 'circular',
      tasks: [
        { id: 'a', description: 'a', tool: 'bash', params: {}, depends_on: ['c'] },
        { id: 'b', description: 'b', tool: 'bash', params: {}, depends_on: ['a'] },
        { id: 'c', description: 'c', tool: 'bash', params: {}, depends_on: ['b'] },
      ],
    })
    expect(() => topoSort(runbook)).toThrow('Circular dependency')
  })
})
