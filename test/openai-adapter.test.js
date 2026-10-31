import test from 'node:test';
import assert from 'node:assert/strict';
import { adapter, isMalformedResponse, MALFORMED_FUNCTION_CALL_ERROR } from '../dist/adapters/openai-adapter.js';

function createReadableStream(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

test('Stream: regular text ending with STOP maps to finish_reason: "stop"', async () => {
  const sseData = [
    'data: {"candidates":[{"content":{"parts":[{"text":"Hello "}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"text":"world!"}]},"finishReason":"STOP"}]}\n\n',
    'data: [DONE]\n\n',
  ];

  const stream = createReadableStream(sseData);
  const results = [];
  for await (const chunk of adapter.convertStream(stream, 'gemini-3.8-flash')) {
    if (chunk.startsWith('data: ') && !chunk.includes('[DONE]')) {
      results.push(JSON.parse(chunk.slice(6)));
    }
  }

  assert.equal(results.length, 2);
  assert.equal(results[0].choices[0].delta.content, 'Hello ');
  assert.equal(results[0].choices[0].finish_reason, null);

  assert.equal(results[1].choices[0].delta.content, 'world!');
  assert.equal(results[1].choices[0].finish_reason, 'stop');
});

test('Stream: functionCall in earlier chunk and STOP in final chunk maps to finish_reason: "tool_calls"', async () => {
  const sseData = [
    'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Thinking..."}]}}]}\n\n',
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"bash","args":{"command":"ps aux"}}}]}}]}\n\n',
    'data: {"candidates":[{"finishReason":"STOP"}]}\n\n',
    'data: [DONE]\n\n',
  ];

  const stream = createReadableStream(sseData);
  const results = [];
  for await (const chunk of adapter.convertStream(stream, 'gemini-3.8-flash')) {
    if (chunk.startsWith('data: ') && !chunk.includes('[DONE]')) {
      results.push(JSON.parse(chunk.slice(6)));
    }
  }

  assert.equal(results.length, 3);
  // Chunk 1: reasoning
  assert.equal(results[0].choices[0].delta.reasoning_content, 'Thinking...');
  assert.equal(results[0].choices[0].finish_reason, null);

  // Chunk 2: tool_calls
  assert.ok(results[1].choices[0].delta.tool_calls);
  assert.equal(results[1].choices[0].delta.tool_calls[0].function.name, 'bash');
  assert.equal(results[1].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(results[1].choices[0].finish_reason, null);

  // Chunk 3: finish chunk with STOP -> must be "tool_calls"!
  assert.equal(results[2].choices[0].finish_reason, 'tool_calls');
});

test('Stream: functionCall and STOP in the SAME chunk maps to finish_reason: "tool_calls"', async () => {
  const sseData = [
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"Path":"/test"}}}]},"finishReason":"STOP"}]}\n\n',
    'data: [DONE]\n\n',
  ];

  const stream = createReadableStream(sseData);
  const results = [];
  for await (const chunk of adapter.convertStream(stream, 'gemini-3.8-flash')) {
    if (chunk.startsWith('data: ') && !chunk.includes('[DONE]')) {
      results.push(JSON.parse(chunk.slice(6)));
    }
  }

  assert.equal(results.length, 1);
  assert.ok(results[0].choices[0].delta.tool_calls);
  assert.equal(results[0].choices[0].delta.tool_calls[0].function.name, 'read_file');
  assert.equal(results[0].choices[0].finish_reason, 'tool_calls');
});

test('Stream: MALFORMED_FUNCTION_CALL yields descriptive error message and finish_reason: "stop"', async () => {
  const sseData = [
    'data: {"candidates":[{"finishReason":"MALFORMED_FUNCTION_CALL"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":0,"totalTokenCount":100}}\n\n',
    'data: [DONE]\n\n',
  ];

  const stream = createReadableStream(sseData);
  const results = [];
  for await (const chunk of adapter.convertStream(stream, 'gemini-3.8-flash')) {
    if (chunk.startsWith('data: ') && !chunk.includes('[DONE]')) {
      results.push(JSON.parse(chunk.slice(6)));
    }
  }

  // 1 candidate chunk + 1 usage chunk
  assert.equal(results.length, 2);
  assert.match(results[0].choices[0].delta.content, /malformed function call/i);
  assert.equal(results[0].choices[0].finish_reason, 'stop');
});

test('Stream: stream ended without explicit finishReason emits fallback finish chunk', async () => {
  const sseData = [
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"test_cmd","args":{}}}]}}]}\n\n',
    'data: [DONE]\n\n',
  ];

  const stream = createReadableStream(sseData);
  const results = [];
  for await (const chunk of adapter.convertStream(stream, 'gemini-3.8-flash')) {
    if (chunk.startsWith('data: ') && !chunk.includes('[DONE]')) {
      results.push(JSON.parse(chunk.slice(6)));
    }
  }

  assert.equal(results.length, 2);
  assert.equal(results[0].choices[0].delta.tool_calls[0].function.name, 'test_cmd');
  assert.equal(results[1].choices[0].finish_reason, 'tool_calls');
});

test('Stream: MAX_TOKENS maps to "length"', async () => {
  const sseData = [
    'data: {"candidates":[{"content":{"parts":[{"text":"trunc"}]},"finishReason":"MAX_TOKENS"}]}\n\n',
    'data: [DONE]\n\n',
  ];

  const stream = createReadableStream(sseData);
  const results = [];
  for await (const chunk of adapter.convertStream(stream, 'gemini-3.8-flash')) {
    if (chunk.startsWith('data: ') && !chunk.includes('[DONE]')) {
      results.push(JSON.parse(chunk.slice(6)));
    }
  }

  assert.equal(results[0].choices[0].finish_reason, 'length');
});

test('Stream: SAFETY maps to "content_filter"', async () => {
  const sseData = [
    'data: {"candidates":[{"finishReason":"SAFETY"}]}\n\n',
    'data: [DONE]\n\n',
  ];

  const stream = createReadableStream(sseData);
  const results = [];
  for await (const chunk of adapter.convertStream(stream, 'gemini-3.8-flash')) {
    if (chunk.startsWith('data: ') && !chunk.includes('[DONE]')) {
      results.push(JSON.parse(chunk.slice(6)));
    }
  }

  assert.equal(results[0].choices[0].finish_reason, 'content_filter');
});

test('Non-streaming: convertResponse handles tool calls and MALFORMED_FUNCTION_CALL', async () => {
  // 1. Tool call response
  const toolCallResponse = new Response(JSON.stringify({
    response: {
      candidates: [{
        content: {
          parts: [{
            functionCall: {
              name: 'bash',
              args: { command: 'ls -la' },
            },
          }],
        },
        finishReason: 'STOP',
      }],
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const convertedTool = await adapter.convertResponse(toolCallResponse, 'gemini-3.8-flash');
  assert.equal(convertedTool.choices[0].finish_reason, 'tool_calls');
  assert.ok(convertedTool.choices[0].message.tool_calls);
  assert.equal(convertedTool.choices[0].message.tool_calls[0].function.name, 'bash');

  // 2. Malformed function call response
  const malformedResponse = new Response(JSON.stringify({
    response: {
      candidates: [{
        finishReason: 'MALFORMED_FUNCTION_CALL',
      }],
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  const convertedMalformed = await adapter.convertResponse(malformedResponse, 'gemini-3.8-flash');
  assert.equal(convertedMalformed.choices[0].finish_reason, 'stop');
  assert.match(convertedMalformed.choices[0].message.content || '', /malformed function call/i);
});

test('isMalformedResponse: correctly identifies malformed response strings', () => {
  assert.equal(isMalformedResponse(MALFORMED_FUNCTION_CALL_ERROR), true);
  assert.equal(isMalformedResponse('Error: Model generated a malformed function call. Please retry or adjust prompt context.'), true);
  assert.equal(isMalformedResponse('data: {"choices":[{"delta":{"content":"Error: Model generated a malformed function call."}}]}'), true);
  assert.equal(isMalformedResponse('Hello world'), false);
  assert.equal(isMalformedResponse(null), false);
  assert.equal(isMalformedResponse(undefined), false);
  assert.equal(isMalformedResponse(''), false);
});

test('convertRequest: merges consecutive tool responses into a single user turn', async () => {
  const req = {
    model: 'gemini-3.8-flash',
    messages: [
      { role: 'user', content: 'run commands' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"uptime"}' } },
          { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{"path":"/a"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'up 10 days' },
      { role: 'tool', tool_call_id: 'call_2', content: 'file content' },
    ],
  };

  const { init } = await adapter.convertRequest(req, 'fake-token', 'fake-project');
  const body = JSON.parse(init.body);
  const contents = body.request.contents;

  // Contents should be:
  // 0: user (text)
  // 1: model (2 functionCall parts)
  // 2: user (2 functionResponse parts MERGED into ONE turn)
  assert.equal(contents.length, 3);
  assert.equal(contents[0].role, 'user');
  assert.equal(contents[1].role, 'model');
  assert.equal(contents[1].parts.length, 2);
  assert.equal(contents[1].parts[0].functionCall.name, 'bash');
  assert.equal(contents[1].parts[1].functionCall.name, 'read_file');

  assert.equal(contents[2].role, 'user');
  assert.equal(contents[2].parts.length, 2, 'Consecutive tool messages must be merged into 1 user turn with 2 parts');
  assert.equal(contents[2].parts[0].functionResponse.name, 'bash');
  assert.deepEqual(contents[2].parts[0].functionResponse.response, { output: 'up 10 days' });
  assert.equal(contents[2].parts[1].functionResponse.name, 'read_file');
  assert.deepEqual(contents[2].parts[1].functionResponse.response, { output: 'file content' });
});

test('convertRequest: keeps non-consecutive tool responses separated when interspersed', async () => {
  const req = {
    model: 'gemini-3.8-flash',
    messages: [
      { role: 'user', content: 'step 1' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'res 1' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_2', content: 'res 2' },
    ],
  };

  const { init } = await adapter.convertRequest(req, 'fake-token', 'fake-project');
  const body = JSON.parse(init.body);
  const contents = body.request.contents;

  // 0: user
  // 1: model (call_1)
  // 2: user (res_1)
  // 3: model (call_2)
  // 4: user (res_2)
  assert.equal(contents.length, 5);
  assert.equal(contents[2].role, 'user');
  assert.equal(contents[2].parts.length, 1);
  assert.equal(contents[4].role, 'user');
  assert.equal(contents[4].parts.length, 1);
});

test('Streaming transparent retry simulation: recovers when attempt 1 is malformed', async () => {
  let attemptCount = 0;

  async function simulateUpstreamRequest() {
    attemptCount++;
    if (attemptCount === 1) {
      // Attempt 1: Gemini emits MALFORMED_FUNCTION_CALL
      const malformedSse = [
        'data: {"candidates":[{"finishReason":"MALFORMED_FUNCTION_CALL"}]}\n\n',
        'data: [DONE]\n\n',
      ];
      return createReadableStream(malformedSse);
    } else {
      // Attempt 2: Gemini succeeds with valid text
      const successSse = [
        'data: {"candidates":[{"content":{"parts":[{"text":"Success after retry!"}]},"finishReason":"STOP"}]}\n\n',
        'data: [DONE]\n\n',
      ];
      return createReadableStream(successSse);
    }
  }

  const MAX_RETRIES = 2;
  let finalStreamOutput = [];

  for (let malformedAttempt = 0; malformedAttempt <= MAX_RETRIES; malformedAttempt++) {
    const stream = await simulateUpstreamRequest();
    const streamGen = adapter.convertStream(stream, 'gemini-3.8-flash');

    const firstResult = await streamGen.next();
    if (firstResult.done) break;

    const firstChunk = firstResult.value;
    if (isMalformedResponse(firstChunk) && malformedAttempt < MAX_RETRIES) {
      // Transparent retry triggered!
      continue;
    }

    finalStreamOutput.push(firstChunk);
    for await (const chunk of streamGen) {
      finalStreamOutput.push(chunk);
    }
    break;
  }

  assert.equal(attemptCount, 2, 'Should have retried exactly once');
  const combined = finalStreamOutput.join('');
  assert.match(combined, /Success after retry!/);
  assert.doesNotMatch(combined, /malformed function call/i);
});

test('Non-streaming transparent retry simulation: recovers when attempt 1 is malformed', async () => {
  let attemptCount = 0;

  async function simulateUpstreamRequest() {
    attemptCount++;
    if (attemptCount === 1) {
      return new Response(JSON.stringify({
        response: {
          candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } else {
      return new Response(JSON.stringify({
        response: {
          candidates: [{
            content: { parts: [{ text: 'Clean non-streaming response' }] },
            finishReason: 'STOP',
          }],
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  const MAX_RETRIES = 2;
  let finalResult = null;

  for (let malformedAttempt = 0; malformedAttempt <= MAX_RETRIES; malformedAttempt++) {
    const response = await simulateUpstreamRequest();
    const openaiResponse = await adapter.convertResponse(response, 'gemini-3.8-flash');
    const content = openaiResponse.choices[0]?.message?.content;

    if (isMalformedResponse(content) && malformedAttempt < MAX_RETRIES) {
      continue;
    }

    finalResult = openaiResponse;
    break;
  }

  assert.equal(attemptCount, 2, 'Should have retried non-streaming request');
  assert.equal(finalResult.choices[0].message.content, 'Clean non-streaming response');
  assert.equal(finalResult.choices[0].finish_reason, 'stop');
});
