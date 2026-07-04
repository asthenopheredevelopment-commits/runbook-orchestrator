export type AgentStatus =
  | { status: 'idle'; agentId: string }
  | { status: 'executing'; tool: string; payload: Record<string, unknown>; startedAt: number }
  | { status: 'awaiting_approval'; executionId: string; policyViolation: string; taskId: string }
  | { status: 'completed'; taskId: string; result: unknown; completedAt: number }
  | { status: 'failed'; taskId: string; error: string; rollbackStep: string | null; failedAt: number }
  | { status: 'rolled_back'; taskId: string; rollbackResult: unknown; rolledBackAt: number }

export interface Agent {
  id: string
  role: string
  state: AgentStatus
  taskHistory: Array<{ taskId: string; status: AgentStatus['status']; timestamp: number }>
}

export type AgentEvent =
  | { type: 'TASK_ASSIGNED'; taskId: string; tool: string; payload: Record<string, unknown> }
  | { type: 'APPROVAL_REQUIRED'; executionId: string; policyViolation: string; taskId: string }
  | { type: 'APPROVAL_GRANTED'; executionId: string }
  | { type: 'APPROVAL_DENIED'; executionId: string }
  | { type: 'TASK_COMPLETED'; taskId: string; result: unknown }
  | { type: 'TASK_FAILED'; taskId: string; error: string; rollbackStep: string | null }
  | { type: 'ROLLBACK_COMPLETED'; taskId: string; result: unknown }

export function createAgent(id: string, role: string): Agent {
  return {
    id,
    role,
    state: { status: 'idle', agentId: id },
    taskHistory: [],
  }
}

export function applyEvent(agent: Agent, event: AgentEvent): Agent {
  switch (event.type) {
    case 'TASK_ASSIGNED': {
      if (agent.state.status !== 'idle') return agent
      return {
        ...agent,
        state: {
          status: 'executing',
          tool: event.tool,
          payload: event.payload,
          startedAt: Date.now(),
        },
        taskHistory: [
          ...agent.taskHistory,
          { taskId: event.taskId, status: 'executing', timestamp: Date.now() },
        ],
      }
    }
    case 'APPROVAL_REQUIRED': {
      if (agent.state.status !== 'executing') return agent
      return {
        ...agent,
        state: {
          status: 'awaiting_approval',
          executionId: event.executionId,
          policyViolation: event.policyViolation,
          taskId: event.taskId,
        },
      }
    }
    case 'APPROVAL_GRANTED': {
      if (agent.state.status !== 'awaiting_approval' || agent.state.executionId !== event.executionId)
        return agent
      return {
        ...agent,
        state: {
          status: 'executing',
          tool: '',
          payload: {},
          startedAt: Date.now(),
        },
      }
    }
    case 'APPROVAL_DENIED': {
      if (agent.state.status !== 'awaiting_approval' || agent.state.executionId !== event.executionId)
        return agent
      return {
        ...agent,
        state: {
          status: 'failed',
          taskId: agent.state.taskId,
          error: `Approval denied: ${agent.state.policyViolation}`,
          rollbackStep: null,
          failedAt: Date.now(),
        },
      }
    }
    case 'TASK_COMPLETED': {
      if (agent.state.status !== 'executing') return agent
      return {
        ...agent,
        state: {
          status: 'completed',
          taskId: event.taskId,
          result: event.result,
          completedAt: Date.now(),
        },
        taskHistory: [
          ...agent.taskHistory,
          { taskId: event.taskId, status: 'completed', timestamp: Date.now() },
        ],
      }
    }
    case 'TASK_FAILED': {
      if (agent.state.status !== 'executing') return agent
      return {
        ...agent,
        state: {
          status: 'failed',
          taskId: event.taskId,
          error: event.error,
          rollbackStep: event.rollbackStep,
          failedAt: Date.now(),
        },
        taskHistory: [
          ...agent.taskHistory,
          { taskId: event.taskId, status: 'failed', timestamp: Date.now() },
        ],
      }
    }
    case 'ROLLBACK_COMPLETED': {
      return {
        ...agent,
        state: {
          status: 'rolled_back',
          taskId: event.taskId,
          rollbackResult: event.result,
          rolledBackAt: Date.now(),
        },
        taskHistory: [
          ...agent.taskHistory,
          { taskId: event.taskId, status: 'rolled_back', timestamp: Date.now() },
        ],
      }
    }
  }
}
