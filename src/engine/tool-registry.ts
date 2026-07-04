import { z } from 'zod'
import { fromZodError } from 'zod-validation-error'

export interface Tool {
  name: string
  description: string
  inputSchema: z.ZodType<unknown>
  execute: (input: unknown) => Promise<unknown>
}

export function defineTool(tool: Tool): Tool {
  return tool
}

export class ToolRegistry {
  private tools = new Map<string, Tool>()

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`)
    }
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  list(): Array<{ name: string; description: string }> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
    }))
  }

  async execute(name: string, input: unknown): Promise<unknown> {
    const tool = this.tools.get(name)
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`)
    }

    const parseResult = tool.inputSchema.safeParse(input)
    if (!parseResult.success) {
      throw new Error(
        `Tool ${name} input validation failed: ${fromZodError(parseResult.error).message}`,
      )
    }

    return tool.execute(parseResult.data)
  }
}
