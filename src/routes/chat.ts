/**
 * Chat completions route - OpenAI-compatible endpoint
 * POST /v1/chat/completions
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { adapter, isMalformedResponse, type OpenAIRequest } from '../adapters/openai-adapter.js';
import { accountService } from '../services/account-manager.js';
import { accessTokenExpired } from '../lib/auth/auth.js';
import { refreshAccessToken } from '../lib/auth/token.js';
import { createLogger } from '../lib/logger.js';
import { metricsService } from '../services/metrics-collector.js';
import { logService } from '../services/log-store.js';

const log = createLogger('chat-route');

interface ChatRequest extends FastifyRequest {
  body: OpenAIRequest;
}

export default async function chatRoutes(server: FastifyInstance) {
  server.post<{ Body: OpenAIRequest }>(
    '/chat/completions',
    async (request: ChatRequest, reply: FastifyReply) => {
      const startTime = Date.now();
      const openaiReq = request.body;

      // Safe preview logging to prevent event-loop latency and log bloat on large payloads
      const rawBodyPreview = (() => {
        try {
          const serialized = JSON.stringify(openaiReq);
          if (serialized.length > 4096) {
            return serialized.slice(0, 4096) + `... [truncated, total ${serialized.length} bytes]`;
          }
          return serialized;
        } catch {
          return '[unserializable body]';
        }
      })();

      log.info('⬇️ INCOMING REQUEST FROM CLIENT', {
        headers: {
          'content-type': request.headers['content-type'],
          'content-length': request.headers['content-length'],
          'x-request-id': request.headers['x-request-id'],
          'user-agent': request.headers['user-agent'],
        },
        model: openaiReq?.model,
        messagesCount: openaiReq?.messages?.length,
        bodyPreview: rawBodyPreview,
      });

      log.debug('⬇️ INCOMING REQUEST FULL BODY', {
        body: openaiReq,
      });

      try {
        // Validate request
        if (!openaiReq.model) {
          return reply.status(400).send({
            error: {
              message: 'Missing required field: model',
              type: 'invalid_request_error',
            },
          });
        }

        if (!openaiReq.messages || openaiReq.messages.length === 0) {
          return reply.status(400).send({
            error: {
              message: 'Missing required field: messages',
              type: 'invalid_request_error',
            },
          });
        }

        log.info('Chat completion request', {
          model: openaiReq.model,
          messageCount: openaiReq.messages.length,
          stream: openaiReq.stream,
          hasTools: Boolean(openaiReq.tools && openaiReq.tools.length > 0),
        });

        // ⛔ 本服务只服务 Google Antigravity (Gemini) 系模型。
        // 非 Antigravity 模型 (a6api / 元衡 等商业渠道) 必须由 Higress AI 网关
        // 依据 config.yaml 的 provider 声明直连对应上游, 严禁在此中继 ——
        // 否则 openai-proxy 会变成所有厂商的隐形单点 (重启即全站 503),
        // 并且绕开 config.yaml 这个唯一真源。
        if (!adapter.isAntigravityModel(openaiReq.model)) {
          log.warn('Rejected non-Antigravity model (direct routing enforced by Higress gateway)', {
            model: openaiReq.model,
          });
          metricsService.recordRequest(openaiReq.model, Date.now() - startTime, 'error');
          return reply.status(400).send({
            error: {
              message:
                `模型 '${openaiReq.model}' 不属于 Antigravity/Gemini 渠道, 本代理不再中继。` +
                '请在 Higress 网关侧按 config.yaml 的 provider 直连对应上游 (如 api.a6api.com)。',
              type: 'invalid_request_error',
              code: 'upstream_not_hosted_here',
            },
          });
        }

        // Max retries on MALFORMED_FUNCTION_CALL from upstream Gemini
        const MAX_MALFORMED_RETRIES = 2;

        const sendAntigravityRequest = async (): Promise<{
          response: Response | null;
          lastUrl: string;
          errorSent: boolean;
        }> => {
          const totalAccounts = await accountService.getAccountCount();
          const maxAttempts = Math.max(1, totalAccounts);
          let attempt = 0;
          let response: Response | null = null;
          let lastUrl = '';
          let currentAccount: any = null;

          while (attempt < maxAttempts) {
            attempt++;
            currentAccount = await accountService.getNextAccount(openaiReq.model);

            if (!currentAccount) {
              break;
            }

            // Get auth details from account
            let authRecord = accountService.getAccountManager().then(m => m.toAuthDetails(currentAccount));
            let auth = await authRecord;

            // Refresh token if needed
            if (accessTokenExpired(auth)) {
              log.debug('Access token expired, refreshing...', {
                accountIndex: currentAccount.index,
                email: currentAccount.email,
              });

              const refreshed = await refreshAccessToken(auth);
              if (!refreshed) {
                log.error('Token refresh failed', {
                  accountIndex: currentAccount.index,
                });
                continue;
              }

              // Update account with new token
              const manager = await accountService.getAccountManager();
              manager.updateFromAuth(currentAccount, refreshed);
              await manager.saveToDisk();
              auth = refreshed;
            }

            const accessToken = auth.access;
            if (!accessToken) {
              continue;
            }

            // Get projectId
            const projectId = currentAccount.parts.projectId || currentAccount.parts.managedProjectId || 'rising-fact-p41fc';

            // Convert OpenAI request to Antigravity
            const { url, init, headerStyle } = await adapter.convertRequest(
              openaiReq,
              accessToken,
              projectId
            );
            lastUrl = url;

            log.info('Making Antigravity request', {
              url,
              projectId,
              headerStyle,
              accountIndex: currentAccount.index,
              email: currentAccount.email,
              attempt,
            });

            // Make request to Antigravity
            response = await fetch(url, init);

            // Handle rate limits with seamless failover
            if (response.status === 429) {
              log.warn('Rate limited on account, failing over to next account...', {
                accountIndex: currentAccount.index,
                email: currentAccount.email,
                model: openaiReq.model,
              });

              await accountService.markRateLimited(currentAccount, 60_000, openaiReq.model);
              metricsService.recordRequest(openaiReq.model, Date.now() - startTime, 'rate_limited');
              response = null;
              continue;
            }

            // Success or non-429 error received, break retry loop
            break;
          }

          if (!response) {
            reply.status(429).send({
              error: {
                message: 'All accounts are rate-limited. Please try again later.',
                type: 'rate_limit_error',
              },
            });
            return { response: null, lastUrl, errorSent: true };
          }

          // Handle other errors
          if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            log.error('❌ ANTIGRAVITY API ERROR', {
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body: errorText.slice(0, 2000),
              url: lastUrl,
            });

            metricsService.recordRequest(openaiReq.model, Date.now() - startTime, 'error');

            reply.status(response.status).send({
              error: {
                message: `Antigravity API error: ${response.statusText}. Check server logs for details.`,
                type: 'api_error',
              },
            });
            return { response: null, lastUrl, errorSent: true };
          }

          return { response, lastUrl, errorSent: false };
        };

        // Handle streaming response
        if (openaiReq.stream) {
          for (let malformedAttempt = 0; malformedAttempt <= MAX_MALFORMED_RETRIES; malformedAttempt++) {
            const { response, errorSent } = await sendAntigravityRequest();
            if (errorSent || !response || !response.body) {
              return;
            }

            let streamTokens: number | undefined = undefined;
            const streamGen = adapter.convertStream(
              response.body,
              openaiReq.model,
              (usage) => {
                if (usage) {
                  streamTokens = usage.total_tokens;
                }
              }
            );

            // Peek at the first chunk to detect if Gemini returned MALFORMED_FUNCTION_CALL
            const firstResult = await streamGen.next();
            if (firstResult.done) {
              reply.raw.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
              });
              reply.raw.end();
              return;
            }

            const firstChunk = firstResult.value;
            if (isMalformedResponse(firstChunk) && malformedAttempt < MAX_MALFORMED_RETRIES) {
              log.warn('Gemini returned MALFORMED_FUNCTION_CALL on stream start, transparently retrying...', {
                attempt: malformedAttempt + 1,
                maxRetries: MAX_MALFORMED_RETRIES,
                model: openaiReq.model,
              });
              try {
                await response.body.cancel();
              } catch {}
              continue;
            }

            // Normal or max retries reached: send headers and stream
            reply.raw.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });

            let streamBuffer = firstChunk;
            reply.raw.write(firstChunk);

            for await (const chunk of streamGen) {
              streamBuffer += chunk;
              reply.raw.write(chunk);
            }

            reply.raw.end();

            // Record metrics
            const duration = Date.now() - startTime;
            metricsService.recordRequest(openaiReq.model, duration, 'success');
            logService.logRequest(
              openaiReq.model,
              'stream',
              duration,
              'success',
              streamTokens,
              openaiReq,
              streamBuffer
            );
            return;
          }
          return;
        }

        // Handle non-streaming response with transparent auto-retry
        for (let malformedAttempt = 0; malformedAttempt <= MAX_MALFORMED_RETRIES; malformedAttempt++) {
          const { response, errorSent } = await sendAntigravityRequest();
          if (errorSent || !response) {
            return;
          }

          const openaiResponse = await adapter.convertResponse(response, openaiReq.model);
          const content = openaiResponse.choices[0]?.message?.content;

          if (isMalformedResponse(content) && malformedAttempt < MAX_MALFORMED_RETRIES) {
            log.warn('Gemini returned MALFORMED_FUNCTION_CALL in non-streaming, transparently retrying...', {
              attempt: malformedAttempt + 1,
              maxRetries: MAX_MALFORMED_RETRIES,
              model: openaiReq.model,
            });
            continue;
          }

          // Record metrics
          const duration = Date.now() - startTime;
          metricsService.recordRequest(openaiReq.model, duration, 'success');
          logService.logRequest(
            openaiReq.model,
            'completion',
            duration,
            'success',
            openaiResponse.usage?.total_tokens,
            openaiReq,
            openaiResponse
          );

          return reply.send(openaiResponse);
        }

      } catch (error) {
        log.error('Chat completion error', {
          error: String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        metricsService.recordRequest(openaiReq.model, Date.now() - startTime, 'error');
        logService.logRequest(
          openaiReq.model,
          'completion',
          Date.now() - startTime,
          'error',
          undefined,
          openaiReq,
          { error: String(error) }
        );

        return reply.status(500).send({
          error: {
            message: error instanceof Error ? error.message : 'Internal server error',
            type: 'internal_error',
          },
        });
      }
    }
  );
}
