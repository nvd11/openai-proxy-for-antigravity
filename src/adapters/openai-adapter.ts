/**
 * OpenAI-compatible API adapter for Antigravity
 * Converts between OpenAI format (used by Zed) and Antigravity format
 */

import { createLogger } from '../lib/logger.js';
import {
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_HEADERS,
  GEMINI_CLI_HEADERS,
  GEMINI_CLI_ENDPOINT,
  ANTIGRAVITY_SYSTEM_INSTRUCTION,
  SKIP_THOUGHT_SIGNATURE,
  type HeaderStyle,
} from '../lib/constants.js';

const log = createLogger('openai-adapter');

// OpenAI API types
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; image_url?: unknown }>;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  // OpenCode & reasoning extensions
  reasoning_effort?: 'low' | 'medium' | 'high' | 'none' | string;
  thinking?: {
    type?: 'enabled' | 'disabled' | string;
    budget_tokens?: number;
  };
  thinking_budget?: number;
  thinkingBudget?: number;
  stream_options?: {
    include_usage?: boolean;
  };
}

export interface OpenAIResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: 'stop' | 'length' | 'tool_calls' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
    };
  };
}

// Antigravity API types (simplified)
interface AntigravityContent {
  role: 'user' | 'model';
  parts: Array<{
    text?: string;
    thought?: boolean;
    thoughtSignature?: string;
    functionCall?: { name: string; args: Record<string, unknown> };
    functionResponse?: { name: string; response: Record<string, unknown> };
  }>;
}

interface AntigravityTool {
  functionDeclarations: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
}

interface AntigravityRequest {
  contents: AntigravityContent[];
  tools?: AntigravityTool[];
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    stopSequences?: string[];
  };
}

export class OpenAIToAntigravityAdapter {
  /**
   * Fields permitted by Google Gemini/Antigravity API Schema proto
   */
  private readonly ALLOWED_SCHEMA_FIELDS = new Set([
    "type",
    "format",
    "description",
    "nullable",
    "enum",
    "maxItems",
    "minItems",
    "properties",
    "required",
    "items",
    "anyOf",
    "oneOf",
    "allOf",
  ]);

  /**
   * Converts JSON Schema to Gemini-compatible format
   */
  private toGeminiSchema(schema: unknown): unknown {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return schema;
    }

    const inputSchema = schema as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    const propertyNames = new Set<string>();
    if (inputSchema.properties && typeof inputSchema.properties === "object") {
      for (const propName of Object.keys(inputSchema.properties as Record<string, unknown>)) {
        propertyNames.add(propName);
      }
    }

    // Process fields, strictly keeping only fields supported by Gemini protobuf
    for (const [key, value] of Object.entries(inputSchema)) {
      if (!this.ALLOWED_SCHEMA_FIELDS.has(key)) {
        continue;
      }

      if (key === "type" && typeof value === "string") {
        result[key] = value.toUpperCase();
      } else if (key === "properties" && typeof value === "object" && value !== null) {
        const props: Record<string, unknown> = {};
        for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
          props[propName] = this.toGeminiSchema(propSchema);
        }
        result[key] = props;
      } else if (key === "items" && typeof value === "object") {
        result[key] = this.toGeminiSchema(value);
      } else if ((key === "anyOf" || key === "oneOf" || key === "allOf") && Array.isArray(value)) {
        result[key] = value.map((item) => this.toGeminiSchema(item));
      } else if (key === "required" && Array.isArray(value)) {
        if (propertyNames.size > 0) {
          const validRequired = value.filter((prop) =>
            typeof prop === "string" && propertyNames.has(prop)
          );
          if (validRequired.length > 0) {
            result[key] = validRequired;
          }
        } else {
          result[key] = value;
        }
      } else {
        result[key] = value;
      }
    }

    // Heuristic: If 'type' is missing but 'anyOf' is present, try to infer type
    // This fixes "JSON schema is invalid" errors with Claude which requires explicit types
    if (!result.type && result.anyOf && Array.isArray(result.anyOf)) {
      const types = new Set<string>();
      for (const option of result.anyOf as Array<{ type?: string }>) {
        if (option.type) {
          types.add(option.type);
        }
      }
      // If all options share the same type, hoist it
      if (types.size === 1) {
        result.type = Array.from(types)[0];
      }
    }

    if (result.type === "ARRAY" && !result.items) {
      result.items = { type: "STRING" };
    }

    return result;
  }

  /**
   * Determines appropriate header style based on model name
   */
  getHeaderStyle(model: string): HeaderStyle {
    const { baseModel } = this.extractModelInfo(model);
    const lower = baseModel.toLowerCase();

    // Models with antigravity- prefix use Antigravity headers
    if (lower.startsWith('antigravity-')) {
      return 'antigravity';
    }

    // Claude and GPT-OSS models always use Antigravity
    if (lower.includes('claude') || lower.includes('gpt-oss')) {
      return 'antigravity';
    }

    // Gemini 3.x Flash/Pro models use Antigravity headers (daily sandbox endpoint)
    if (lower.includes('gemini-3') || lower.includes('gemini-3.8') || lower.includes('gemini-3.5')) {
      return 'antigravity';
    }

    // Gemini models default to gemini-cli (production endpoint)
    return 'gemini-cli';
  }

  /**
   * Checks if a model should be routed to Google Antigravity
   */
  isAntigravityModel(model: string): boolean {
    const { baseModel } = this.extractModelInfo(model);
    const lower = baseModel.toLowerCase();

    if (lower.startsWith('antigravity-')) return true;
    if (lower.includes('gemini')) return true;
    if (lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus')) return true;
    if (lower.includes('gpt-oss')) return true;

    return false;
  }

  /**
   * Extracts the base model name and any thinking suffix
   */
  extractModelInfo(model: string): { baseModel: string; thinkingSuffix?: string } {
    let cleaned = model.trim();
    // Remove "antigravity-" prefix if present
    cleaned = cleaned.replace(/^antigravity-/, '');
    // Remove ":antigravity" suffix if present
    cleaned = cleaned.replace(/:antigravity$/i, '');

    // Check for thinking suffix: e.g. :low, :medium, :med, :high, :max, :ultra, :none, :off, :0, :thinking, :8k, :16k, :4096
    const suffixRegex = /:(low|medium|med|high|max|ultra|none|off|0|thinking|\d+k?)$/i;
    const match = cleaned.match(suffixRegex);

    if (match) {
      const thinkingSuffix = match[1].toLowerCase();
      const baseModel = cleaned.slice(0, match.index);
      return { baseModel, thinkingSuffix };
    }

    return { baseModel: cleaned };
  }

  /**
   * Extracts the actual model name (strips prefix/suffix)
   */
  extractModelName(model: string): string {
    return this.extractModelInfo(model).baseModel;
  }

  /**
   * Converts OpenAI messages to Antigravity contents
   */
  convertMessages(messages: OpenAIMessage[]): {
    contents: AntigravityContent[];
    systemInstruction?: { parts: Array<{ text: string }> };
  } {
    const contents: AntigravityContent[] = [];
    let systemText = '';
    const toolCallNames = new Map<string, string>();

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Collect system messages
        const text = typeof msg.content === 'string' ? msg.content : '';
        systemText += (systemText ? '\n\n' : '') + text;
        continue;
      }

      if (msg.role === 'user') {
        const parts: AntigravityContent['parts'] = [];

        if (typeof msg.content === 'string') {
          parts.push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text' && part.text) {
              parts.push({ text: part.text });
            }
            // TODO: Handle image_url if needed
          }
        }

        contents.push({ role: 'user', parts });
      } else if (msg.role === 'assistant') {
        const parts: AntigravityContent['parts'] = [];

        if (msg.content) {
          const text = typeof msg.content === 'string' ? msg.content : '';
          if (text) parts.push({ text });
        }

        if (msg.tool_calls) {
          for (const toolCall of msg.tool_calls) {
            if (toolCall.id && toolCall.function?.name) {
              toolCallNames.set(toolCall.id, toolCall.function.name);
            }
            try {
              const args = JSON.parse(toolCall.function.arguments);
              const customSig = (toolCall as Record<string, unknown>).thoughtSignature || (toolCall as Record<string, unknown>).thought_signature;
              parts.push({
                functionCall: {
                  name: toolCall.function.name,
                  args,
                },
                thoughtSignature: typeof customSig === 'string' && customSig ? customSig : SKIP_THOUGHT_SIGNATURE,
              });
            } catch (e) {
              log.warn('Failed to parse tool call arguments', {
                toolCall: toolCall.function.name,
                error: String(e),
              });
            }
          }
        }

        if (parts.length > 0) {
          contents.push({ role: 'model', parts });
        }
      } else if (msg.role === 'tool') {
        // Tool results - protobuf requires functionResponse.response to be a Struct (Object), NEVER an Array
        const toolName = msg.name || (msg.tool_call_id ? toolCallNames.get(msg.tool_call_id) : undefined) || 'tool';
        let responseObj: Record<string, unknown>;

        try {
          const raw = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
          if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
            responseObj = raw as Record<string, unknown>;
          } else {
            responseObj = { output: raw };
          }
        } catch {
          const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          responseObj = { output: contentStr || '' };
        }

        contents.push({
          role: 'user',
          parts: [{
            functionResponse: {
              name: toolName,
              response: responseObj,
            },
          }],
        });
      }
    }

    // Prepend Antigravity system instruction if using Antigravity models
    const fullSystemText = ANTIGRAVITY_SYSTEM_INSTRUCTION + (systemText ? '\n\n' + systemText : '');

    return {
      contents,
      systemInstruction: fullSystemText ? { parts: [{ text: fullSystemText }] } : undefined,
    };
  }

  /**
   * Wraps tools array in Gemini's required functionDeclarations format
   */
  private wrapToolsAsFunctionDeclarations(tools: OpenAITool[]): AntigravityTool[] | undefined {
    if (!tools || tools.length === 0) return undefined;

    const functionDeclarations: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }> = [];

    for (const tool of tools) {
      if (tool.type !== 'function') continue;

      const name = String(tool.function.name || `tool-${functionDeclarations.length}`);
      const description = String(tool.function.description || '');
      const schema = tool.function.parameters || { type: 'OBJECT', properties: {} };

      functionDeclarations.push({
        name,
        description,
        parameters: this.toGeminiSchema(schema) as Record<string, unknown>,
      });
    }

    return functionDeclarations.length > 0
      ? [{ functionDeclarations }]
      : undefined;
  }

  /**
   * Converts OpenAI tools to Antigravity functionDeclarations
   */
  convertTools(tools?: OpenAITool[]): AntigravityTool[] | undefined {
    return this.wrapToolsAsFunctionDeclarations(tools || []);
  }

  /**
   * Resolves internal Antigravity model ID from public model name
   */
  resolveAntigravityModel(model: string): string {
    const name = this.extractModelName(model).toLowerCase();

    // Gemini 3.8 Flash mappings (Google internal ID: gemini-3.8-flash-tiered)
    if (
      name === 'gemini-3.8-flash' ||
      name === 'gemini-3.8-flash-medium' ||
      name === 'gemini-3.8-flash-low' ||
      name === 'gemini-3.8-flash-high' ||
      name === 'gemini-3.8-flash-tiered' ||
      name === 'gemini-3-flash'
    ) {
      return 'gemini-3.8-flash-tiered';
    }

    // For Gemini 3 Pro models (since Gemini 3 Pro is demised by Google, gracefully map to Gemini 3.8 Flash tiered)
    if (name === 'gemini-3-pro' || name === 'gemini-3-pro-low' || name === 'gemini-3-pro-high') {
      return 'gemini-3.8-flash-tiered';
    }

    // Claude models (Google internal IDs: claude-sonnet-4-6, claude-opus-4-6-thinking)
    if (
      name === 'claude-sonnet-4-6' ||
      name === 'claude-sonnet-4-5' ||
      name === 'claude-3-5-sonnet' ||
      name === 'claude-3-5-sonnet-latest' ||
      name === 'sonnet' ||
      name === 'sonnet-4-6'
    ) {
      return 'claude-sonnet-4-6';
    }

    if (
      name === 'claude-opus-4-6-thinking' ||
      name === 'claude-opus-4-5-thinking' ||
      name === 'claude-3-opus' ||
      name === 'opus' ||
      name === 'opus-4-6'
    ) {
      return 'claude-opus-4-6-thinking';
    }

    // GPT-OSS & Gemini Lite
    if (name.includes('gpt-oss')) {
      return 'gpt-oss-120b-medium';
    }
    if (name.includes('flash-lite')) {
      return 'gemini-3.5-flash-lite';
    }

    // Map of public names to internal Antigravity IDs (for legacy compatibility)
    const mappings: Record<string, string> = {
      'gemini-2.0-flash-thinking-exp': 'gemini-2.0-flash-thinking-exp-1219',
      'default': 'gemini-3.8-flash-tiered',
    };

    return mappings[name] || name;
  }

  /**
   * Builds the full Antigravity API URL
   */
  buildAntigravityUrl(
    headerStyle: HeaderStyle,
    stream: boolean
  ): string {
    const baseEndpoint = headerStyle === 'gemini-cli' ? GEMINI_CLI_ENDPOINT : ANTIGRAVITY_ENDPOINT;
    const method = stream ? 'streamGenerateContent' : 'generateContent';
    const query = stream ? '?alt=sse' : '';

    return `${baseEndpoint}/v1internal:${method}${query}`;
  }

  /**
   * Checks if a model is a thinking model by default
   */
  isThinkingModel(model: string): boolean {
    return model.includes('-thinking') || model.includes('opus-4-6');
  }

  /**
   * Gets default thinking budget for a thinking model
   */
  getThinkingBudget(model: string): number {
    const budgets: Record<string, number> = {
      'claude-sonnet-4-6': 8192,
      'claude-opus-4-6-thinking': 8192,
      'claude-sonnet-4-5-thinking': 8192,
      'claude-opus-4-5-thinking': 8192,
    };
    return budgets[model] || 8192;
  }

  /**
   * Parses thinking budget from a model suffix (e.g. low, high, 16k, 4096)
   */
  parseThinkingSuffix(suffix: string): number | undefined {
    const s = suffix.toLowerCase();
    const tierBudgets: Record<string, number> = {
      'none': 0,
      'off': 0,
      '0': 0,
      'low': 2048,
      'med': 8192,
      'medium': 8192,
      'high': 16384,
      'max': 32768,
      'ultra': 32768,
      'thinking': 8192,
    };

    if (s in tierBudgets) {
      return tierBudgets[s];
    }
    if (s.endsWith('k')) {
      const num = parseInt(s.slice(0, -1), 10);
      if (!isNaN(num)) {
        return num * 1024;
      }
    }
    const num = parseInt(s, 10);
    if (!isNaN(num)) {
      return num;
    }
    return undefined;
  }

  /**
   * Determines thinking budget based on OpenCode conventions:
   * 1. Explicit body parameter: thinking_budget / thinkingBudget
   * 2. Body parameter: thinking { budget_tokens, type }
   * 3. Body parameter: reasoning_effort (low/medium/high/none)
   * 4. Model suffix (e.g. :low, :medium, :high, :16k, :none)
   * 5. Default model behavior (thinking models default to 8192)
   */
  determineThinkingBudget(openaiReq: OpenAIRequest, internalModel: string): number | undefined {
    // 1. Explicit direct numeric budget in request body
    if (typeof openaiReq.thinking_budget === 'number') {
      return openaiReq.thinking_budget;
    }
    if (typeof openaiReq.thinkingBudget === 'number') {
      return openaiReq.thinkingBudget;
    }

    // 2. OpenCode / Anthropic thinking object in request body
    if (openaiReq.thinking) {
      if (openaiReq.thinking.type === 'disabled') {
        return 0;
      }
      if (typeof openaiReq.thinking.budget_tokens === 'number') {
        return openaiReq.thinking.budget_tokens;
      }
      if (openaiReq.thinking.type === 'enabled') {
        return 8192;
      }
    }

    // 3. OpenAI reasoning_effort in request body
    if (openaiReq.reasoning_effort) {
      const effort = String(openaiReq.reasoning_effort).toLowerCase();
      if (effort === 'none') return 0;
      if (effort === 'low') return 2048;
      if (effort === 'medium' || effort === 'med') return 8192;
      if (effort === 'high' || effort === 'max') return 16384;
    }

    // 4. Model suffix (e.g. :low, :medium, :high, :16k, :none)
    const { thinkingSuffix } = this.extractModelInfo(openaiReq.model);
    if (thinkingSuffix) {
      const parsed = this.parseThinkingSuffix(thinkingSuffix);
      if (parsed !== undefined) {
        return parsed;
      }
    }

    // 5. Default model behavior for thinking models
    if (this.isThinkingModel(internalModel)) {
      return this.getThinkingBudget(internalModel);
    }

    return undefined;
  }

  /**
   * Converts full OpenAI request to Antigravity format
   */
  async convertRequest(
    openaiReq: OpenAIRequest,
    accessToken: string,
    projectId: string
  ): Promise<{
    url: string;
    init: RequestInit;
    headerStyle: HeaderStyle;
  }> {
    const headerStyle = this.getHeaderStyle(openaiReq.model);
    const modelName = this.extractModelName(openaiReq.model);
    const stream = openaiReq.stream ?? false;

    // Resolve the actual internal model ID
    const internalModel = this.resolveAntigravityModel(modelName);

    const { contents, systemInstruction } = this.convertMessages(openaiReq.messages);
    const tools = this.convertTools(openaiReq.tools);

    const thinkingBudget = this.determineThinkingBudget(openaiReq, internalModel);

    // Anthropic Claude strictly requires max_tokens > thinking.budget_tokens
    let maxOutputTokens = openaiReq.max_tokens;
    if (thinkingBudget !== undefined && thinkingBudget > 0) {
      if (!maxOutputTokens || maxOutputTokens <= thinkingBudget) {
        maxOutputTokens = Math.max(maxOutputTokens || 0, thinkingBudget + 4096);
      }
    }

    const generationConfig: any = {
      temperature: openaiReq.temperature,
      maxOutputTokens,
      topP: openaiReq.top_p,
      stopSequences: openaiReq.stop
        ? Array.isArray(openaiReq.stop) ? openaiReq.stop : [openaiReq.stop]
        : undefined,
    };

    if (thinkingBudget !== undefined && thinkingBudget > 0) {
      generationConfig.thinkingConfig = {
        thinkingBudget,
        includeThoughts: true,
      };
    } else if (thinkingBudget === 0) {
      generationConfig.thinkingConfig = {
        thinkingBudget: 0,
      };
    }

    const requestPayload: AntigravityRequest = {
      contents,
      systemInstruction,
      tools,
      generationConfig,
    };

    // Wrap the body as required by v1internal endpoint
    const wrappedBody = {
      project: projectId,
      model: internalModel,
      request: requestPayload,
      requestType: 'agent',
      userAgent: 'antigravity',
      requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };

    const url = this.buildAntigravityUrl(headerStyle, stream);
    const headers = headerStyle === 'gemini-cli' ? GEMINI_CLI_HEADERS : ANTIGRAVITY_HEADERS;

    return {
      url,
      headerStyle,
      init: {
        method: 'POST',
        headers: {
          ...headers,
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Accept': stream ? 'text/event-stream' : 'application/json',
        },
        body: JSON.stringify(wrappedBody),
      },
    };
  }

  /**
   * Converts Antigravity response to OpenAI format
   */
  async convertResponse(antigravityRes: Response, requestedModel: string): Promise<OpenAIResponse> {
    const data: any = await antigravityRes.json();

    // Extract content from Antigravity response
    const candidates = data.response?.candidates || data.candidates || [];
    const firstCandidate = candidates[0];

    let content: string | null = null;
    let reasoningContent: string | null = null;
    const toolCalls: OpenAIResponse['choices'][0]['message']['tool_calls'] = [];

    if (firstCandidate?.content?.parts) {
      for (const part of firstCandidate.content.parts) {
        if (part.thought) {
          reasoningContent = (reasoningContent || '') + (part.text || '');
        } else if (part.text) {
          content = (content || '') + part.text;
        }
        if (part.functionCall) {
          toolCalls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args || {}),
            },
          });
        }
      }
    }

    const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';

    return {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        finish_reason: finishReason,
      }],
      usage: this.extractUsage(data.response?.usageMetadata || data.usageMetadata),
    };
  }

  /**
   * Helper to extract and format OpenAI usage from Antigravity usageMetadata
   */
  private extractUsage(usageMeta: any): OpenAIResponse['usage'] | undefined {
    if (!usageMeta) return undefined;

    const promptTokens = usageMeta.promptTokenCount || 0;
    const completionTokens = usageMeta.candidatesTokenCount || 0;
    const totalTokens = usageMeta.totalTokenCount || (promptTokens + completionTokens);
    const cachedTokens = usageMeta.cachedContentTokenCount || 0;

    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      prompt_tokens_details: {
        cached_tokens: cachedTokens,
      },
    };
  }

  /**
   * Converts Antigravity SSE stream to OpenAI format
   */
  async *convertStream(
    stream: ReadableStream,
    requestedModel: string,
    onUsage?: (usage: OpenAIResponse['usage']) => void
  ): AsyncGenerator<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let accumulatedUsage: OpenAIResponse['usage'] | null = null;
    let streamId = `chatcmpl-${Date.now()}`;
    let createdTime = Math.floor(Date.now() / 1000);

    let usageEmitted = false;

    log.info('Starting stream conversion', { requestedModel });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          log.info('Stream reading completed');
          break;
        }

        const chunkText = decoder.decode(value, { stream: true });
        // log.debug('Received raw stream chunk', { length: chunkText.length, preview: chunkText.slice(0, 100) });
        
        buffer += chunkText;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          
          if (!line.startsWith('data: ')) {
            log.debug('Skipping non-data line', { line: line.slice(0, 100) });
            continue;
          }

          const data = line.slice(6);
          if (data === '[DONE]') {
            // If we captured usage metadata, yield the final chunk with usage before [DONE]
            if (accumulatedUsage && !usageEmitted) {
              usageEmitted = true;
              const usageChunk = {
                id: streamId,
                object: 'chat.completion.chunk',
                created: createdTime,
                model: requestedModel,
                choices: [],
                usage: accumulatedUsage,
              };
              yield `data: ${JSON.stringify(usageChunk)}\n\n`;
            }
            yield 'data: [DONE]\n\n';
            continue;
          }

          try {
            const parsed = JSON.parse(data);

            // Capture usage metadata if present in stream chunk
            const usageMeta = parsed.response?.usageMetadata || parsed.usageMetadata;
            if (usageMeta) {
              accumulatedUsage = this.extractUsage(usageMeta) || null;
              if (onUsage && accumulatedUsage) {
                onUsage(accumulatedUsage);
              }
            }

            const openaiChunk = this.convertStreamChunk(parsed, requestedModel, streamId, createdTime);
            yield `data: ${JSON.stringify(openaiChunk)}\n\n`;
          } catch (e) {
            log.warn('Failed to parse stream chunk', { error: String(e), data: data.slice(0, 200) });
          }
        }
      }

      // If stream ended without an explicit [DONE] but has usage, emit final chunk with usage + [DONE]
      if (accumulatedUsage && !usageEmitted) {
        usageEmitted = true;
        const usageChunk = {
          id: streamId,
          object: 'chat.completion.chunk',
          created: createdTime,
          model: requestedModel,
          choices: [],
          usage: accumulatedUsage,
        };
        yield `data: ${JSON.stringify(usageChunk)}\n\n`;
        yield 'data: [DONE]\n\n';
      }
    } catch (error) {
      log.error('Stream reading error', { error: String(error) });
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Converts a single Antigravity stream chunk to OpenAI format
   */
  private convertStreamChunk(
    antigravityChunk: any,
    requestedModel: string,
    id: string = `chatcmpl-${Date.now()}`,
    created: number = Math.floor(Date.now() / 1000)
  ) {
    const candidates = antigravityChunk.response?.candidates || antigravityChunk.candidates || [];
    const firstCandidate = candidates[0];

    let delta: any = { role: 'assistant' };

    if (firstCandidate?.content?.parts) {
      for (const part of firstCandidate.content.parts) {
        if (part.thought) {
          delta.reasoning_content = (delta.reasoning_content || '') + (part.text || '');
        } else if (part.text) {
          delta.content = (delta.content || '') + part.text;
        }
        if (part.functionCall) {
          delta.tool_calls = [{
            index: 0,
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args || {}),
            },
          }];
        }
      }
    }

    const finishReason = firstCandidate?.finishReason
      ? (firstCandidate.finishReason === 'STOP' ? 'stop' : firstCandidate.finishReason.toLowerCase())
      : null;

    return {
      id,
      object: 'chat.completion.chunk',
      created,
      model: requestedModel,
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason,
      }],
    };
  }
}

export const adapter = new OpenAIToAntigravityAdapter();
