import { z } from 'zod'

const ApprovalPolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  pattern: z.string(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  requireApproval: z.boolean().default(true),
})

type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>

const ApprovalRequestSchema = z.object({
  executionId: z.string(),
  taskId: z.string(),
  tool: z.string(),
  params: z.record(z.unknown()),
  description: z.string(),
  triggeredBy: z.array(z.string()),
})

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>

export interface ApprovalDecision {
  executionId: string
  approved: boolean
  approvedBy: string
  timestamp: number
  reason: string
}

const DEFAULT_POLICIES: ApprovalPolicy[] = [
  {
    id: 'delete-resource',
    name: 'Resource Deletion',
    pattern: 'delete|remove|destroy|terminate',
    severity: 'critical',
    requireApproval: true,
  },
  {
    id: 'credential-rotation',
    name: 'Credential Rotation',
    pattern: 'rotate|revoke|reset.*key|reset.*secret',
    severity: 'high',
    requireApproval: true,
  },
  {
    id: 'iam-change',
    name: 'IAM Policy Change',
    pattern: 'iam.*attach|iam.*detach|iam.*create|iam.*delete',
    severity: 'high',
    requireApproval: true,
  },
  {
    id: 'network-change',
    name: 'Network Configuration Change',
    pattern: 'security-group|firewall|acl|vpc.*peer',
    severity: 'high',
    requireApproval: true,
  },
  {
    id: 'data-export',
    name: 'Data Export',
    pattern: 'export|backup.*external|copy.*remote',
    severity: 'medium',
    requireApproval: true,
  },
]

export class ApprovalGate {
  private policies: ApprovalPolicy[]
  private decisions: ApprovalDecision[] = []

  constructor(policies?: ApprovalPolicy[]) {
    this.policies = policies ?? DEFAULT_POLICIES
  }

  evaluate(taskDescription: string, tool: string): { needsApproval: boolean; violations: string[] } {
    const violations: string[] = []

    for (const policy of this.policies) {
      const regex = new RegExp(policy.pattern, 'i')
      const matchesDescription = regex.test(taskDescription)
      const matchesTool = regex.test(tool)

      if (matchesDescription || matchesTool) {
        violations.push(
          `[${policy.severity.toUpperCase()}] ${policy.name}: "${taskDescription}" triggered by ${tool}`,
        )
      }
    }

    return {
      needsApproval: violations.length > 0,
      violations,
    }
  }

  recordDecision(
    executionId: string,
    approved: boolean,
    approvedBy: string,
    reason: string,
  ): ApprovalDecision {
    const decision: ApprovalDecision = {
      executionId,
      approved,
      approvedBy,
      timestamp: Date.now(),
      reason,
    }
    this.decisions.push(decision)
    return decision
  }

  getDecisionHistory(): ApprovalDecision[] {
    return [...this.decisions]
  }
}

export function createExecutionId(taskId: string): string {
  return `exec-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}
