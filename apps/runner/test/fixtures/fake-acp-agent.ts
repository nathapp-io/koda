/** A tiny newline-delimited JSON-RPC ACP agent used by the real-process regression test. */
export {};

type JsonObject = Record<string, unknown>;

const write = (message: JsonObject): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const input = async (): Promise<void> => {
  let pending = '';
  for await (const chunk of process.stdin) {
    pending += chunk.toString();
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as JsonObject;
      const method = message['method'];
      const id = message['id'];
      if (typeof method !== 'string') continue;
      if (method === 'session/cancel') continue;
      if (id === undefined) continue;
      if (method === 'initialize') {
        write({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentInfo: { name: 'fake', version: '1' }, agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } } } });
      } else if (method === 'session/new') {
        write({ jsonrpc: '2.0', id, result: { sessionId: 'fake-session', modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask', description: 'Ask' }] } } });
      } else if (method === 'session/prompt') {
        const scenario = process.env['FAKE_ACP_SCENARIO'] ?? 'tool-separated';
        const updates: JsonObject[] = scenario === 'adjacent'
          ? [
              { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } },
              { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
            ]
          : [
              { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking the file.' } },
              { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', kind: 'read' },
              { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
              { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } },
            ];
        const params = message['params'] as JsonObject | undefined;
        for (const update of updates) write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params?.['sessionId'] ?? 'fake-session', update } });
        write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
      } else {
        write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      }
    }
  }
};

await input();
