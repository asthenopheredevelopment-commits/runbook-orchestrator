import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { ToolRegistry, defineTool } from '../src/engine/tool-registry.js'

describe('ToolRegistry', () => {
  it('registers and retrieves a tool', () => {
    const registry = new ToolRegistry()
    const tool = defineTool({
      name: 'echo',
      description: 'Echo input back',
      inputSchema: z.object({ message: z.string() }),
      execute: async (input: unknown) => (input as { message: string }).message,
    })
    registry.register(tool)
    expect(registry.get('echo')).toBeDefined()
    expect(registry.get('echo')?.name).toBe('echo')
  })

  it('prevents duplicate registration', () => {
    const registry = new ToolRegistry()
    const tool = defineTool({
      name: 'echo',
      description: 'Echo',
      inputSchema: z.object({}),
      execute: async () => 'ok',
    })
    registry.register(tool)
    expect(() => registry.register(tool)).toThrow('already registered')
  })

  it('lists registered tools', () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'a', description: 'tool a',
      inputSchema: z.object({}), execute: async () => 'a',
    }))
    registry.register(defineTool({
      name: 'b', description: 'tool b',
      inputSchema: z.object({}), execute: async () => 'b',
    }))
    const list = registry.list()
    expect(list).toHaveLength(2)
    expect(list.map((t) => t.name).sort()).toEqual(['a', 'b'])
  })

  it('executes a tool with valid input', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'add',
      description: 'Add two numbers',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async (input: unknown) => {
        const { a, b } = input as { a: number; b: number }
        return a + b
      },
    }))
    const result = await registry.execute('add', { a: 2, b: 3 })
    expect(result).toBe(5)
  })

  it('rejects execution with invalid input', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'add',
      description: 'Add two numbers',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async (input: unknown) => {
        const { a, b } = input as { a: number; b: number }
        return a + b
      },
    }))
    await expect(registry.execute('add', { a: 'not-a-number', b: 3 })).rejects.toThrow('validation failed')
  })

  it('rejects execution of unknown tool', async () => {
    const registry = new ToolRegistry()
    await expect(registry.execute('unknown', {})).rejects.toThrow('Unknown tool')
  })

  it('validates input at runtime via Zod', async () => {
    const registry = new ToolRegistry()
    registry.register(defineTool({
      name: 'greet',
      description: 'Greet someone',
      inputSchema: z.object({ name: z.string().min(1), age: z.number().int().positive() }),
      execute: async (input: unknown) => {
        const { name, age } = input as { name: string; age: number }
        return `${name} is ${age}`
      },
    }))
    const result = await registry.execute('greet', { name: 'Alice', age: 30 })
    expect(result).toBe('Alice is 30')

    await expect(registry.execute('greet', { name: '', age: 30 })).rejects.toThrow()
    await expect(registry.execute('greet', { name: 'Bob', age: -1 })).rejects.toThrow()
  })
})
