import { z } from 'zod'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

const MCPRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
})

const MCPResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
})

export interface MCPToolDefinition {
  name: string
  description?: string
  inputSchema: z.ZodType<unknown>
}

export interface MCPToolResult {
  name: string
  description: string | undefined
  inputSchema: z.ZodType<unknown>
}

export class MCPClient {
  private process: ChildProcess | null = null
  private rl: ReturnType<typeof createInterface> | null = null
  private requestId = 0
  private pending = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >()
  private buffer = ''

  constructor(
    private command: string,
    private args: string[] = [],
  ) {}

  async connect(): Promise<void> {
    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.rl = createInterface({
      input: this.process.stdout!,
      crlfDelay: Infinity,
    })

    this.rl.on('line', (line: string) => {
      this.handleMessage(line)
    })

    this.process.on('exit', (code) => {
      for (const [, pending] of this.pending) {
        pending.reject(new Error(`MCP process exited with code ${code}`))
      }
      this.pending.clear()
    })

    await this.waitForReady()
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const response = await this.sendRequest('tools/list', {})
    const result = response as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> }
    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.record(z.unknown()),
    })) as MCPToolDefinition[]
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    return this.sendRequest('tools/call', { name, arguments: args })
  }

  disconnect(): void {
    if (this.process) {
      this.process.kill()
      this.process = null
    }
    if (this.rl) {
      this.rl.close()
      this.rl = null
    }
  }

  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestId

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })

      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }

      const parsed = MCPRequestSchema.parse(request)
      this.process?.stdin?.write(JSON.stringify(parsed) + '\n')

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`MCP request ${id} timed out`))
        }
      }, 30_000)
    })
  }

  private handleMessage(line: string): void {
    this.buffer += line
    try {
      const parsed = JSON.parse(this.buffer)
      this.buffer = ''

      const response = MCPResponseSchema.parse(parsed)
      const id = response.id

      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)

      if (response.error) {
        pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`))
      } else {
        pending.resolve(response.result)
      }
    } catch {
      // incomplete JSON, keep buffering
    }
  }

  private async waitForReady(): Promise<void> {
    return new Promise((resolve) => {
      const handler = (data: Buffer) => {
        const text = data.toString()
        if (text.includes('started') || text.includes('ready') || text.includes('listening')) {
          resolve()
        } else {
          setTimeout(resolve, 500)
        }
      }
      this.process?.stderr?.on('data', handler)
      setTimeout(resolve, 1000)
    })
  }
}
