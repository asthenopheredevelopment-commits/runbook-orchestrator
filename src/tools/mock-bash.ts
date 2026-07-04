import { z } from 'zod'
import { defineTool } from '../engine/tool-registry.js'

const BashInputSchema = z.object({
  command: z.string().min(1, 'Command is required'),
  cwd: z.string().optional(),
  timeout_seconds: z.number().int().positive().optional(),
})

interface BashOutput {
  stdout: string
  stderr: string
  exitCode: number
  command: string
}

const ALLOWED_COMMANDS = [
  'ls', 'cat', 'echo', 'pwd', 'whoami', 'date', 'env',
  'mkdir', 'cp', 'mv', 'rm', 'chmod', 'chown',
  'grep', 'find', 'sort', 'wc', 'head', 'tail',
  'aws', 'gcloud', 'az', 'kubectl', 'helm',
  'git', 'docker', 'terraform', 'ansible',
]

export async function executeBash(input: unknown): Promise<BashOutput> {
  const parsed = BashInputSchema.parse(input)
  const toolName = parsed.command.split(/\s+/)[0]!

  if (!ALLOWED_COMMANDS.includes(toolName)) {
    return {
      stdout: '',
      stderr: `Command not in allowlist: ${toolName}`,
      exitCode: 1,
      command: parsed.command,
    }
  }

  return {
    stdout: `[mock] Executed: ${parsed.command} (in ${parsed.cwd ?? '/tmp'})`,
    stderr: '',
    exitCode: 0,
    command: parsed.command,
  }
}

export const mockBashTool = defineTool({
  name: 'bash',
  description: 'Execute a shell command in a sandboxed environment. Only allowlisted commands are permitted.',
  inputSchema: BashInputSchema,
  execute: executeBash,
})
