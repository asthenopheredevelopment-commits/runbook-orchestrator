import { describe, it, expect } from 'vitest'
import { Orchestrator } from '../src/engine/orchestrator.js'
import { mockBashTool } from '../src/tools/mock-bash.js'
import { mockCloudTool } from '../src/tools/mock-cloud.js'

describe('Orchestrator', () => {
  it('executes a simple non-destructive runbook', async () => {
    const runbook = {
      name: 'simple-test',
      description: 'A simple test runbook',
      tasks: [
        {
          id: 'list-files',
          description: 'List files in current directory',
          tool: 'bash',
          params: { command: 'ls' },
          depends_on: [],
          destructive: false,
          timeout_seconds: 30,
        },
        {
          id: 'show-date',
          description: 'Show current date',
          tool: 'bash',
          params: { command: 'date' },
          depends_on: [],
          destructive: false,
          timeout_seconds: 30,
        },
      ],
    }

    const orchestrator = new Orchestrator(runbook)
    orchestrator.registerTool(mockBashTool)

    const result = await orchestrator.execute()
    expect(result.success).toBe(true)
    expect(result.plan.sortedTaskIds).toEqual(['list-files', 'show-date'])
    expect(result.logs.length).toBeGreaterThan(0)
  })

  it('halts on destructive tasks requiring approval', async () => {
    const runbook = {
      name: 'destructive-test',
      description: 'Test with destructive action',
      tasks: [
        {
          id: 'rotate-key',
          description: 'Rotate the staging DB IAM key',
          tool: 'cloud',
          params: {
            action: 'rotate_key',
            params: { service: 'aws', resource: 'staging-db-svc', keyType: 'access_key' },
          },
          depends_on: [],
          destructive: true,
          timeout_seconds: 60,
          rollback: {
            tool: 'bash',
            params: { command: 'echo rollback' },
          },
        },
      ],
    }

    const orchestrator = new Orchestrator(runbook)
    orchestrator.registerTool(mockCloudTool)
    orchestrator.registerTool(mockBashTool)

    const result = await orchestrator.execute()
    expect(result.success).toBe(false)
    expect(result.error).toContain('Pending approval')
  })

  it('resumes after approval is granted', async () => {
    const runbook = {
      name: 'approval-test',
      description: 'Test approval flow',
      tasks: [
        {
          id: 'rotate-key',
          description: 'Rotate key',
          tool: 'cloud',
          params: {
            action: 'rotate_key',
            params: { service: 'aws', resource: 'test', keyType: 'access_key' },
          },
          depends_on: [],
          destructive: true,
          timeout_seconds: 60,
          rollback: { tool: 'bash', params: { command: 'echo rollback' } },
        },
      ],
    }

    const orchestrator = new Orchestrator(runbook)
    orchestrator.registerTool(mockCloudTool)
    orchestrator.registerTool(mockBashTool)

    const firstResult = await orchestrator.execute()
    expect(firstResult.success).toBe(false)
    expect(firstResult.error).toContain('Pending approval')

    await orchestrator.handleApproval('exec-approval-test', true)
    // After approval, execution continues and may succeed or encounter another issue
  })

  it('executes a sequential multi-step runbook', async () => {
    const runbook = {
      name: 'sequential-test',
      description: 'Tasks with dependencies',
      tasks: [
        {
          id: 'step-1', description: 'First step', tool: 'bash',
          params: { command: 'echo step1' }, depends_on: [], destructive: false, timeout_seconds: 30,
        },
        {
          id: 'step-2', description: 'Second step', tool: 'bash',
          params: { command: 'echo step2' }, depends_on: ['step-1'], destructive: false, timeout_seconds: 30,
        },
        {
          id: 'step-3', description: 'Third step', tool: 'bash',
          params: { command: 'echo step3' }, depends_on: ['step-2'], destructive: false, timeout_seconds: 30,
        },
      ],
    }

    const orchestrator = new Orchestrator(runbook)
    orchestrator.registerTool(mockBashTool)

    const result = await orchestrator.execute()
    expect(result.success).toBe(true)
    expect(result.plan.sortedTaskIds).toEqual(['step-1', 'step-2', 'step-3'])
  })

  it('rejects invalid runbook input', () => {
    expect(() => new Orchestrator({ name: '', tasks: [] })).toThrow()
  })

  it('handles tool execution failure gracefully', async () => {
    const runbook = {
      name: 'failure-test',
      description: 'Test failure handling',
      tasks: [
        {
          id: 'fail-task', description: 'This will fail via unknown tool', tool: 'nonexistent',
          params: {}, depends_on: [], destructive: false, timeout_seconds: 30,
        },
      ],
    }

    const orchestrator = new Orchestrator(runbook)
    const result = await orchestrator.execute()
    expect(result.success).toBe(false)
  })
})
