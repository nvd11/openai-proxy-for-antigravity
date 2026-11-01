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

// ============================================================================
// Multimodal image input (image_url -> inlineData)
// ============================================================================

import http from 'node:http';

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);

function dataUrl(mime, bytes) {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

function buildRequestWithImage(imageUrl) {
  return {
    model: 'gemini-3.8-flash',
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'What is in this image?' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ] },
    ],
  };
}

test('image: data URL PNG converts to inlineData with correct mime and pure base64', async () => {
  const { init } = await adapter.convertRequest(buildRequestWithImage(dataUrl('image/png', PNG_BYTES)), 'tok', 'proj');
  const body = JSON.parse(init.body);
  const parts = body.request.contents[0].parts;

  assert.equal(parts.length, 2);
  assert.equal(parts[0].text, 'What is in this image?');
  assert.equal(parts[1].inlineData.mimeType, 'image/png');
  // data must be pure base64 (no data: prefix) and decode back to original bytes
  const decoded = Buffer.from(parts[1].inlineData.data, 'base64');
  assert.deepEqual(decoded, PNG_BYTES);
  assert.equal(parts[1].inlineData.data.includes(','), false);
});

test('image: JPEG and WebP magic bytes are detected correctly', async () => {
  const jpeg = await adapter.convertRequest(buildRequestWithImage(dataUrl('application/octet-stream', JPEG_BYTES)), 'tok', 'proj');
  assert.equal(JSON.parse(jpeg.init.body).request.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');

  const webp = await adapter.convertRequest(buildRequestWithImage(dataUrl('application/octet-stream', WEBP_BYTES)), 'tok', 'proj');
  assert.equal(JSON.parse(webp.init.body).request.contents[0].parts[1].inlineData.mimeType, 'image/webp');
});

test('image: malformed data URL degrades to text placeholder without throwing', async () => {
  const { init } = await adapter.convertRequest(buildRequestWithImage('data:image/png;base64,%%%not-base64%%%'), 'tok', 'proj');
  const parts = JSON.parse(init.body).request.contents[0].parts;
  assert.equal(parts.length, 2);
  assert.match(parts[1].text || '', /\[image omitted:/);
  assert.equal(parts[1].inlineData, undefined);
});

test('image: oversized image (>8MB) degrades to text placeholder', async () => {
  const big = Buffer.alloc(8 * 1024 * 1024 + 1, 0x89); // not valid PNG magic, but > size cap
  const { init } = await adapter.convertRequest(buildRequestWithImage(dataUrl('image/png', big)), 'tok', 'proj');
  const parts = JSON.parse(init.body).request.contents[0].parts;
  assert.match(parts[1].text || '', /\[image omitted:/);
});

test('image: total request budget (15MB) rejects second image', async () => {
  const first = Buffer.alloc(8 * 1024 * 1024, 0x00);
  first[0] = 0x89; first[1] = 0x50; first[2] = 0x4e; first[3] = 0x47; // valid PNG magic
  first[4] = 0x0d; first[5] = 0x0a; first[6] = 0x1a; first[7] = 0x0a;
  const second = Buffer.alloc(8 * 1024 * 1024, 0x00);
  second[0] = 0x89; second[1] = 0x50; second[2] = 0x4e; second[3] = 0x47;
  second[4] = 0x0d; second[5] = 0x0a; second[6] = 0x1a; second[7] = 0x0a;

  const req = {
    model: 'gemini-3.8-flash',
    messages: [
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: dataUrl('image/png', first) } },
        { type: 'image_url', image_url: { url: dataUrl('image/png', second) } },
      ] },
    ],
  };
  const { init } = await adapter.convertRequest(req, 'tok', 'proj');
  const parts = JSON.parse(init.body).request.contents[0].parts;
  assert.equal(parts.length, 2);
  assert.equal(parts[0].inlineData.mimeType, 'image/png');
  assert.match(parts[1].text || '', /\[image omitted:/);
});

test('image: pure text messages behave exactly as before (regression)', async () => {
  const req = { model: 'gemini-3.8-flash', messages: [{ role: 'user', content: 'hello only' }] };
  const { init } = await adapter.convertRequest(req, 'tok', 'proj');
  const parts = JSON.parse(init.body).request.contents[0].parts;
  assert.equal(parts.length, 1);
  assert.equal(parts[0].text, 'hello only');
  assert.equal(parts[0].inlineData, undefined);
});

test('image: mixed content preserves text/image/text order', async () => {
  const req = {
    model: 'gemini-3.8-flash',
    messages: [
      { role: 'user', content: [
        { type: 'text', text: 'A' },
        { type: 'image_url', image_url: { url: dataUrl('image/png', PNG_BYTES) } },
        { type: 'text', text: 'B' },
      ] },
    ],
  };
  const { init } = await adapter.convertRequest(req, 'tok', 'proj');
  const parts = JSON.parse(init.body).request.contents[0].parts;
  assert.equal(parts.length, 3);
  assert.equal(parts[0].text, 'A');
  assert.equal(parts[1].inlineData.mimeType, 'image/png');
  assert.equal(parts[2].text, 'B');
});

test('image: remote URL is fetched and inlined', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG_BYTES.length });
    res.end(PNG_BYTES);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const prev = process.env.IMAGE_FETCH_ALLOW_PRIVATE;
  process.env.IMAGE_FETCH_ALLOW_PRIVATE = 'true';
  try {
    const { init } = await adapter.convertRequest(
      buildRequestWithImage(`http://127.0.0.1:${port}/img.png`), 'tok', 'proj'
    );
    const parts = JSON.parse(init.body).request.contents[0].parts;
    assert.equal(parts[1].inlineData.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(parts[1].inlineData.data, 'base64'), PNG_BYTES);
  } finally {
    if (prev === undefined) delete process.env.IMAGE_FETCH_ALLOW_PRIVATE;
    else process.env.IMAGE_FETCH_ALLOW_PRIVATE = prev;
    server.close();
  }
});

test('image: remote 404 degrades to placeholder without throwing', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const prev = process.env.IMAGE_FETCH_ALLOW_PRIVATE;
  process.env.IMAGE_FETCH_ALLOW_PRIVATE = 'true';
  try {
    const { init } = await adapter.convertRequest(
      buildRequestWithImage(`http://127.0.0.1:${port}/missing.png`), 'tok', 'proj'
    );
    const parts = JSON.parse(init.body).request.contents[0].parts;
    assert.match(parts[1].text || '', /\[image omitted:/);
  } finally {
    if (prev === undefined) delete process.env.IMAGE_FETCH_ALLOW_PRIVATE;
    else process.env.IMAGE_FETCH_ALLOW_PRIVATE = prev;
    server.close();
  }
});

test('image: private/loopback hosts are blocked by default (SSRF guard)', async () => {
  const { init } = await adapter.convertRequest(
    buildRequestWithImage('http://127.0.0.1:9999/img.png'), 'tok', 'proj'
  );
  const parts = JSON.parse(init.body).request.contents[0].parts;
  assert.match(parts[1].text || '', /\[image omitted:/);
  assert.match(parts[1].text || '', /private\/loopback/);
});
