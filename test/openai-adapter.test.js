import test from 'node:test';
import assert from 'node:assert/strict';
import { adapter } from '../dist/adapters/openai-adapter.js';

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
