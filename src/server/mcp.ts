/**
 * The MCP server: Larder's assistant tools (src/core/services/assistant.ts)
 * for Claude, ChatGPT, Gemini CLI, Open WebUI, LM Studio and any other MCP
 * client, over Streamable HTTP at /mcp.
 *
 * Stateless: every POST is answered on its own with plain JSON (no sessions,
 * no long-lived streams), so it works through Home Assistant, reverse
 * proxies and tunnels. Callers sign in like any API caller, usually with an
 * access token (Authorization: Bearer lrd_…).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AmbiguousError, ASSISTANT_INSTRUCTIONS, LarderError, type CoreApi } from '@larder/core';
import type { Config } from './config';

export const MCP_PATH = '/mcp';

function serverFor(core: CoreApi, config: Config, userId: string | null): McpServer {
  const server = new McpServer({ name: 'larder', title: 'Larder', version: config.version }, { instructions: ASSISTANT_INSTRUCTIONS });
  for (const tool of core.assistant.list()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { title: tool.title, readOnlyHint: tool.readOnly, destructiveHint: tool.destructive, openWorldHint: false },
      },
      async (args: unknown) => {
        try {
          const result = await core.assistant.call(tool.name, args, { userId });
          return { content: [{ type: 'text' as const, text: result.text }] };
        } catch (err) {
          // Tool errors go back to the assistant (not as protocol errors) so it can ask the person or try again.
          const text =
            err instanceof AmbiguousError ? `${err.message} Candidates: ${err.candidates.join('; ')}.`
            : err instanceof LarderError ? err.message
            : 'Something went wrong in Larder. Check its logs.';
          return { isError: true, content: [{ type: 'text' as const, text }] };
        }
      },
    );
  }
  return server;
}

export function registerMcp(app: FastifyInstance, { core, config }: { core: CoreApi; config: Config }) {
  app.post(MCP_PATH, { schema: { hide: true } }, async (request: FastifyRequest, reply: FastifyReply) => {
    const server = serverFor(core, config, request.user?.id ?? null);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  // Stateless: no server-to-client stream to open and no session to end.
  const notHere = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header('Allow', 'POST').send({ jsonrpc: '2.0', error: { code: -32000, message: 'Larder\'s MCP server is stateless: send requests with POST.' }, id: null });
  app.get(MCP_PATH, { schema: { hide: true } }, notHere);
  app.delete(MCP_PATH, { schema: { hide: true } }, notHere);
}
