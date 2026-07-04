import { z } from 'zod'
import { defineTool } from '../engine/tool-registry.js'

const RotateKeySchema = z.object({
  service: z.enum(['aws', 'gcp', 'azure', 'github']),
  resource: z.string().min(1),
  keyType: z.enum(['access_key', 'secret_key', 'api_token', 'ssh_key']),
})

const UpdateSecretSchema = z.object({
  service: z.enum(['aws', 'gcp', 'azure', 'github']),
  secretName: z.string().min(1),
  secretValue: z.string().min(1),
})

const CloudActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rotate_key'), params: RotateKeySchema }),
  z.object({ action: z.literal('update_secret'), params: UpdateSecretSchema }),
])

interface CloudResult {
  success: boolean
  action: string
  service: string
  resource?: string
  message: string
}

export async function executeCloudAction(input: unknown): Promise<CloudResult> {
  const parsed = CloudActionSchema.parse(input)

  switch (parsed.action) {
    case 'rotate_key':
      return {
        success: true,
        action: 'rotate_key',
        service: parsed.params.service,
        resource: parsed.params.resource,
        message: `[mock] Rotated ${parsed.params.keyType} for ${parsed.params.resource} on ${parsed.params.service}. New key: mock-${Date.now()}`,
      }
    case 'update_secret':
      return {
        success: true,
        action: 'update_secret',
        service: parsed.params.service,
        resource: parsed.params.secretName,
        message: `[mock] Updated secret "${parsed.params.secretName}" on ${parsed.params.service}`,
      }
  }
}

export const mockCloudTool = defineTool({
  name: 'cloud',
  description: 'Execute cloud infrastructure operations: rotate keys, update secrets across AWS/GCP/Azure/GitHub.',
  inputSchema: CloudActionSchema,
  execute: executeCloudAction,
})
