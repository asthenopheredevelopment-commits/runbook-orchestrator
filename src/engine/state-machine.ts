import type { ExecutionPlan, RollbackStep } from '../types/runbook.js'

export type OrchestratorState =
  | { status: 'initialized'; plan: ExecutionPlan }
  | { status: 'running'; plan: ExecutionPlan; currentLevel: number; taskResults: Map<string, unknown> }
  | { status: 'awaiting_approval'; plan: ExecutionPlan; taskId: string; policyViolation: string; executionId: string; currentLevel: number; taskResults: Map<string, unknown> }
  | { status: 'completed'; plan: ExecutionPlan; results: Map<string, unknown> }
  | { status: 'failed'; taskId: string; error: string; rollbackTaskId: string | null }
  | { status: 'rolling_back'; taskId: string; rollbackSteps: Array<{ taskId: string; rollback: RollbackStep }> }

export type OrchestratorEvent =
  | { type: 'LEVEL_COMPLETED'; level: number }
  | { type: 'TASK_FAILED'; taskId: string; error: string; hasRollback: boolean }
  | { type: 'APPROVAL_RESPONSE'; executionId: string; approved: boolean }
  | { type: 'ROLLBACK_COMPLETED'; taskId: string }
  | { type: 'ALL_TASKS_COMPLETED' }

export function createOrchestratorState(plan: ExecutionPlan): OrchestratorState {
  return { status: 'initialized', plan }
}

export function transitionState(
  state: OrchestratorState,
  event: OrchestratorEvent,
): OrchestratorState {
  switch (state.status) {
    case 'initialized': {
      if (event.type === 'LEVEL_COMPLETED') {
        return {
          status: 'running',
          plan: state.plan,
          currentLevel: 0,
          taskResults: new Map(),
        }
      }
      return state
    }

    case 'running': {
      switch (event.type) {
        case 'LEVEL_COMPLETED': {
          const nextLevel = state.currentLevel + 1
          if (nextLevel >= state.plan.levels.length) {
            return { status: 'completed', plan: state.plan, results: state.taskResults }
          }
          return { ...state, currentLevel: nextLevel }
        }
        case 'TASK_FAILED': {
          if (event.hasRollback) {
            return {
              status: 'rolling_back',
              taskId: event.taskId,
              rollbackSteps: [],
            }
          }
          return {
            status: 'failed',
            taskId: event.taskId,
            error: event.error,
            rollbackTaskId: null,
          }
        }
        default:
          return state
      }
    }

    case 'awaiting_approval': {
      if (event.type !== 'APPROVAL_RESPONSE') return state
      if (event.executionId !== state.executionId) return state
      if (event.approved) {
        return {
          status: 'running',
          plan: state.plan,
          currentLevel: state.currentLevel,
          taskResults: state.taskResults,
        }
      }
      return {
        status: 'failed',
        taskId: state.taskId,
        error: `Approval denied: ${state.policyViolation}`,
        rollbackTaskId: null,
      }
    }

    case 'rolling_back': {
      if (event.type === 'ROLLBACK_COMPLETED') {
        return {
          status: 'failed',
          taskId: state.taskId,
          error: 'Task failed, rollback completed',
          rollbackTaskId: state.taskId,
        }
      }
      return state
    }

    default:
      return state
  }
}

export interface StepResult {
  success: boolean
  result?: unknown
  error?: string
  needsApproval?: { executionId: string; policyViolation: string }
}
