import type { z } from 'zod'
import type { Agent, AgentEvent } from '../types/agent.js'
import { createAgent, applyEvent } from '../types/agent.js'
import type { ExecutionPlan, Runbook, Task } from '../types/runbook.js'
import { validateRunbook, topoSort } from '../types/runbook.js'
import { ToolRegistry } from './tool-registry.js'
import { createOrchestratorState, transitionState, type OrchestratorState, type StepResult } from './state-machine.js'
import { MCPClient } from '../mcp/client.js'

export type ExecutionLog = Array<{
  taskId: string
  status: string
  timestamp: number
  detail: string
}>

export interface OrchestratorResult {
  success: boolean
  plan: ExecutionPlan
  results: Map<string, unknown>
  logs: ExecutionLog
  error: string | undefined
  pendingExecutionId?: string
}

export class Orchestrator {
  private toolRegistry: ToolRegistry
  private mcpClient?: MCPClient
  private agents: Map<string, Agent> = new Map()
  private state: OrchestratorState
  private plan: ExecutionPlan
  private logs: ExecutionLog = []

  constructor(
    private runbookInput: unknown,
    private config: {
      enableMCP?: boolean
      mcpCommand?: string
    } = {},
  ) {
    const runbook = validateRunbook(this.runbookInput)
    this.plan = topoSort(runbook)
    this.state = createOrchestratorState(this.plan)
    this.toolRegistry = new ToolRegistry()
  }

  registerTool(tool: {
    name: string
    description: string
    inputSchema: z.ZodType<unknown>
    execute: (input: unknown) => Promise<unknown>
  }): void {
    this.toolRegistry.register(tool)
  }

  async connectMCP(): Promise<void> {
    if (!this.config.mcpCommand) return
    this.mcpClient = new MCPClient(this.config.mcpCommand)
    await this.mcpClient.connect()

    const mcpTools = await this.mcpClient.listTools()
    for (const toolDef of mcpTools) {
      this.toolRegistry.register({
        name: toolDef.name,
        description: toolDef.description ?? '',
        inputSchema: toolDef.inputSchema,
        execute: async (input) => {
          if (!this.mcpClient) throw new Error('MCP not connected')
          return this.mcpClient.callTool(toolDef.name, input)
        },
      })
    }
  }

  async execute(): Promise<OrchestratorResult> {
    this.log('system', 'orchestrator', `Starting runbook: ${this.plan.runbookName}`)

    if (this.state.status === 'initialized') {
      this.state = transitionState(this.state, { type: 'LEVEL_COMPLETED', level: -1 })
    }

    const startLevel = this.state.status === 'running' ? this.state.currentLevel : 0

    try {
      for (let level = startLevel; level < this.plan.levels.length; level++) {
        const taskIds = this.plan.levels[level]!
        this.log('system', 'orchestrator', `Executing level ${level}: ${taskIds.join(', ')}`)

        for (const taskId of taskIds) {
          const result = await this.executeTask(taskId)

          if (!result.success) {
            if (result.needsApproval) {
              this.state = {
                status: 'awaiting_approval',
                plan: this.plan,
                taskId,
                policyViolation: result.needsApproval.policyViolation,
                executionId: result.needsApproval.executionId,
                currentLevel: level,
                taskResults: this.state.status === 'running' ? this.state.taskResults : new Map(),
              }
              return {
                success: false,
                plan: this.plan,
                results: new Map(),
                logs: this.logs,
                error: `Pending approval: ${result.needsApproval.policyViolation}`,
                pendingExecutionId: result.needsApproval.executionId,
              }
            }

            if (this.state.status === 'running') {
              this.handleFailure(undefined, result.error ?? 'Unknown error')
            }
            return {
              success: false,
              plan: this.plan,
              results: new Map(),
              logs: this.logs,
              error: result.error,
            }
          }

          if (result.result !== undefined && this.state.status === 'running') {
            this.state.taskResults.set(taskId, result.result)
          }
        }

        this.state = transitionState(this.state, { type: 'LEVEL_COMPLETED', level })
      }

      if (this.state.status === 'running') {
        this.state = transitionState(this.state, { type: 'ALL_TASKS_COMPLETED' })
      }

      const finalResults = this.state.status === 'completed' ? this.state.results : new Map()

      this.log('system', 'orchestrator', 'Runbook execution completed')

      return {
        success: this.state.status === 'completed',
        plan: this.plan,
        results: finalResults,
        logs: this.logs,
        error: undefined,
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      this.log('system', 'orchestrator', `Fatal error: ${errorMsg}`)
      return {
        success: false,
        plan: this.plan,
        results: new Map(),
        logs: this.logs,
        error: errorMsg,
      }
    }
  }

  async handleApproval(executionId: string, approved: boolean): Promise<OrchestratorResult> {
    this.state = transitionState(
      this.state,
      { type: 'APPROVAL_RESPONSE', executionId, approved },
    )

    if (approved && this.state.status === 'running') {
      return this.execute()
    }

    return {
      success: false,
      plan: this.plan,
      results: new Map(),
      logs: this.logs,
      error: 'Approval denied',
    }
  }

  private async executeTask(taskId: string): Promise<StepResult> {
    const runbook = this.runbookInput as Runbook
    const task = runbook.tasks.find((t) => t.id === taskId)
    if (!task) return { success: false, error: `Task not found: ${taskId}` }

    const agentId = `agent-${taskId}`
    const agent = createAgent(agentId, task.tool)
    this.agents.set(agentId, agent)

    this.log(agentId, task.tool, `Starting task: ${task.description}`)

    const assignEvent: AgentEvent = {
      type: 'TASK_ASSIGNED',
      taskId,
      tool: task.tool,
      payload: task.params,
    }
    applyEvent(agent, assignEvent)

    if (task.destructive) {
      const executionId = `exec-${taskId}-${Date.now()}`
      const violation = `Destructive action: ${task.description}`
      this.log(agentId, task.tool, `HITL gate: ${violation}`)

      const approvalEvent: AgentEvent = {
        type: 'APPROVAL_REQUIRED',
        executionId,
        policyViolation: violation,
        taskId,
      }
      applyEvent(agent, approvalEvent)

      return {
        success: false,
        needsApproval: { executionId, policyViolation: violation },
      }
    }

    return this.runTool(task, agent)
  }

  private async runTool(task: Task, agent: Agent): Promise<StepResult> {
    try {
      const result = await this.toolRegistry.execute(task.tool, task.params)
      const completedEvent: AgentEvent = {
        type: 'TASK_COMPLETED',
        taskId: task.id,
        result,
      }
      applyEvent(agent, completedEvent)
      this.log(agent.id, task.tool, `Completed: ${task.description}`)
      return { success: true, result }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      const failedEvent: AgentEvent = {
        type: 'TASK_FAILED',
        taskId: task.id,
        error: errorMsg,
        rollbackStep: task.rollback?.tool ?? null,
      }
      applyEvent(agent, failedEvent)
      this.log(agent.id, task.tool, `Failed: ${errorMsg}`)

      if (this.state.status === 'running') {
        this.handleFailure(task, errorMsg, agent)
      }

      return { success: false, error: errorMsg }
    }
  }

  private async handleFailure(task: Task | undefined, error: string, agent?: Agent): Promise<void> {
    this.log('system', 'orchestrator', `Task failed: ${error}`)
    if (task?.rollback) {
      this.log('system', 'orchestrator', `Rolling back task: ${task.id}`)
      try {
        const rollbackResult = await this.toolRegistry.execute(task.rollback.tool, task.rollback.params)
        if (agent) {
          applyEvent(agent, { type: 'ROLLBACK_COMPLETED', taskId: task.id, result: rollbackResult })
        }
        this.log('system', 'orchestrator', `Rollback completed for: ${task.id}`)
      } catch (rollbackErr) {
        const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
        this.log('system', 'orchestrator', `Rollback failed for ${task.id}: ${rbMsg}`)
      }
    }
  }

  private log(source: string, tool: string, detail: string): void {
    this.logs.push({
      taskId: source,
      status: tool,
      timestamp: Date.now(),
      detail,
    })
  }
}
