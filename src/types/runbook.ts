import { z } from 'zod'

export const RollbackStepSchema = z.object({
  tool: z.string().min(1, 'Rollback tool name is required'),
  params: z.record(z.unknown()),
})

export type RollbackStep = z.infer<typeof RollbackStepSchema>

export const TaskSchema = z.object({
  id: z.string().min(1, 'Task id is required'),
  description: z.string().min(1, 'Task description is required'),
  tool: z.string().min(1, 'Tool name is required'),
  params: z.record(z.unknown()),
  depends_on: z.array(z.string()).default([]),
  destructive: z.boolean().default(false),
  timeout_seconds: z.number().int().positive().default(300),
  rollback: RollbackStepSchema.optional(),
})

export type Task = z.infer<typeof TaskSchema>

export const RunbookSchema = z.object({
  name: z.string().min(1, 'Runbook name is required'),
  description: z.string().default(''),
  tasks: z.array(TaskSchema).min(1, 'Runbook must have at least one task'),
})

export type Runbook = z.infer<typeof RunbookSchema>

export const ExecutionPlanSchema = z.object({
  runbookName: z.string(),
  sortedTaskIds: z.array(z.string()),
  levels: z.array(z.array(z.string())),
})

export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>

export function validateRunbook(data: unknown): Runbook {
  return RunbookSchema.parse(data)
}

export function topoSort(runbook: Runbook): ExecutionPlan {
  const taskMap = new Map(runbook.tasks.map((t) => [t.id, t]))
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const sorted: string[] = []

  function visit(taskId: string): void {
    if (visited.has(taskId)) return
    if (visiting.has(taskId)) {
      throw new Error(`Circular dependency detected at task: ${taskId}`)
    }
    visiting.add(taskId)
    const task = taskMap.get(taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)
    for (const depId of task.depends_on) {
      visit(depId)
    }
    visiting.delete(taskId)
    visited.add(taskId)
    sorted.push(taskId)
  }

  for (const task of runbook.tasks) {
    visit(task.id)
  }

  const levels: string[][] = []
  const depth = new Map<string, number>()

  for (const taskId of sorted) {
    const task = taskMap.get(taskId)!
    if (task.depends_on.length === 0) {
      depth.set(taskId, 0)
      if (!levels[0]) levels[0] = []
      levels[0]!.push(taskId)
    } else {
      const maxDepDepth = Math.max(...task.depends_on.map((d) => depth.get(d) ?? -1))
      const d = maxDepDepth + 1
      depth.set(taskId, d)
      if (!levels[d]) levels[d] = []
      levels[d]!.push(taskId)
    }
  }

  return {
    runbookName: runbook.name,
    sortedTaskIds: sorted,
    levels,
  }
}
