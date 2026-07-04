import { createInterface } from 'node:readline'
import { Orchestrator } from './engine/orchestrator.js'
import { mockBashTool } from './tools/mock-bash.js'
import { mockCloudTool } from './tools/mock-cloud.js'
import { createExecutionId } from './hitl/approval-gate.js'
import type { Runbook } from './types/runbook.js'

const EXAMPLE_RUNBOOK: Runbook = {
  name: 'Rotate Staging DB Credentials',
  description: 'Rotate AWS IAM keys for the staging database and update GitHub Actions secrets',
  tasks: [
    {
      id: 'audit-current-keys',
      description: 'Audit current IAM key ages for staging DB service account',
      tool: 'bash',
      params: { command: 'aws iam list-access-keys --user-name staging-db-svc' },
      depends_on: [],
      destructive: false,
      timeout_seconds: 60,
    },
    {
      id: 'generate-new-key',
      description: 'Generate a new IAM access key for staging-db-svc user',
      tool: 'cloud',
      params: {
        action: 'rotate_key',
        params: { service: 'aws', resource: 'staging-db-svc', keyType: 'access_key' },
      },
      depends_on: ['audit-current-keys'],
      destructive: true,
      timeout_seconds: 120,
      rollback: {
        tool: 'bash',
        params: { command: 'echo "Rollback: deactivating new key and re-enabling old key"' },
      },
    },
    {
      id: 'update-github-secret',
      description: 'Update the STAGING_DB_ACCESS_KEY secret in GitHub Actions',
      tool: 'cloud',
      params: {
        action: 'update_secret',
        params: { service: 'github', secretName: 'STAGING_DB_ACCESS_KEY', secretValue: 'mock-new-key-value' },
      },
      depends_on: ['generate-new-key'],
      destructive: false,
      timeout_seconds: 60,
    },
    {
      id: 'verify-new-key',
      description: 'Verify the new IAM key works by making a test API call',
      tool: 'bash',
      params: { command: 'aws sts get-caller-identity' },
      depends_on: ['update-github-secret'],
      destructive: false,
      timeout_seconds: 60,
    },
    {
      id: 'deactivate-old-key',
      description: 'Deactivate the old IAM access key',
      tool: 'cloud',
      params: {
        action: 'rotate_key',
        params: { service: 'aws', resource: 'staging-db-svc-old-key', keyType: 'access_key' },
      },
      depends_on: ['verify-new-key'],
      destructive: true,
      timeout_seconds: 60,
      rollback: {
        tool: 'bash',
        params: { command: 'echo "Rollback: re-activating old key"' },
      },
    },
  ],
}

async function main(): Promise<void> {
  const orchestrator = new Orchestrator(EXAMPLE_RUNBOOK, {
    enableMCP: false,
  })

  orchestrator.registerTool(mockBashTool)
  orchestrator.registerTool(mockCloudTool)

  console.log('╔════════════════════════════════════════════════════╗')
  console.log('║   Multi-Agent DevOps Runbook Orchestrator        ║')
  console.log('╚════════════════════════════════════════════════════╝')
  console.log(`\nRunbook: ${EXAMPLE_RUNBOOK.name}`)
  console.log(`Description: ${EXAMPLE_RUNBOOK.description}`)
  console.log(`Tasks: ${EXAMPLE_RUNBOOK.tasks.length}`)
  console.log('─'.repeat(50))

  const result = await orchestrator.execute()

  if (!result.success && result.error?.startsWith('Pending approval:')) {
    console.log(`\n⚠ HITL Approval Required:`)
    console.log(`  ${result.error}`)

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await new Promise<string>((resolve) => {
      rl.question('  Type "approve" to continue, anything else to cancel: ', resolve)
    })
    rl.close()

    if (answer.trim().toLowerCase() === 'approve') {
      console.log('  ✓ Approval granted, continuing execution...')
      const resumed = await orchestrator.handleApproval(
        createExecutionId('generate-new-key'),
        true,
      )
      printResult(resumed)
    } else {
      console.log('  ✗ Execution cancelled by operator')
    }
  } else {
    printResult(result)
  }
}

function printResult(result: import('./engine/orchestrator.js').OrchestratorResult): void {
  console.log('─'.repeat(50))
  console.log(`\nExecution: ${result.success ? '✓ SUCCESS' : '✗ FAILED'}`)
  if (result.error) console.log(`Error: ${result.error}`)

  console.log(`\nExecution Log:`)
  for (const entry of result.logs) {
    const date = new Date(entry.timestamp).toISOString().slice(11, 19)
    console.log(`  [${date}] [${entry.taskId}] ${entry.detail}`)
  }

  console.log('\nDone.')
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch(console.error)
}

export { Orchestrator, EXAMPLE_RUNBOOK }
export type { OrchestratorResult, ExecutionLog } from './engine/orchestrator.js'
