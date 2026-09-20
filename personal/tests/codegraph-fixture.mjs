import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
if (process.argv[2] === 'init') {
  const root = join(process.argv[3], '.codegraph'); await mkdir(root, { recursive: true });
  await appendFile(join(root, 'init-count'), 'x'); await writeFile(join(root, 'codegraph.db'), 'fixture');
} else {
  const server = new McpServer({ name: 'codegraph-fixture', version: '1' });
  server.registerTool('codegraph_explore', { inputSchema: { query: z.string(), projectPath: z.string(), maxFiles: z.number().optional() } },
    async input => ({ content: [{ type: 'text', text: JSON.stringify({ fixture: true, pid: process.pid, ...input }) }] }));
  await server.connect(new StdioServerTransport());
}
