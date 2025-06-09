import { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { getAiProviderLanguageModel } from '@openops/common';
import {
  AppSystemProp,
  encryptUtils,
  logger,
  system,
} from '@openops/server-shared';
import {
  AiConfig,
  DeleteChatHistoryRequest,
  NewMessageRequest,
  OpenChatMCPRequest,
  OpenChatResponse,
  openOpsId,
  PrincipalType,
} from '@openops/shared';
import {
  CoreMessage,
  DataStreamWriter,
  LanguageModel,
  pipeDataStreamToResponse,
  streamText,
  ToolChoice,
  ToolSet,
} from 'ai';
import { StatusCodes } from 'http-status-codes';
import {
  sendAiChatFailureEvent,
  sendAiChatMessageSendEvent,
} from '../../telemetry/event-models';
import { aiConfigService } from '../config/ai-config.service';
import { getMCPTools } from '../mcp/mcp-tools';
import {
  appendMessagesToChatHistory,
  appendMessagesToChatHistoryContext,
  createChatContext,
  deleteChatHistory,
  deleteChatHistoryContext,
  generateChatIdForMCP,
  getChatContext,
  getChatHistory,
} from './ai-chat.service';
import {
  shouldTryToSummarize,
  summarizeChatHistoryContext,
} from './ai-message-history-summarizer';
import { generateMessageId } from './ai-message-id-generator';
import { getMcpSystemPrompt } from './prompts.service';
import { selectRelevantTools } from './tools.service';

const maxRecursionDepth = system.getNumberOrThrow(
  AppSystemProp.MAX_LLM_CALLS_WITHOUT_INTERACTION,
);

type StreamMessagesParams = {
  chatId: string;
  tools?: ToolSet;
  aiConfig: AiConfig;
  systemPrompt: string;
  mcpClients: unknown[];
  handledError: boolean;
  attemptIndex?: number;
  messages: CoreMessage[];
  languageModel: LanguageModel;
};

export const aiMCPChatController: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/open',
    OpenChatOptions,
    async (request, reply): Promise<OpenChatResponse> => {
      const { chatId: inputChatId } = request.body;
      const { id: userId } = request.principal;

      if (inputChatId) {
        const existingContext = await getChatContext(inputChatId);

        if (existingContext) {
          const messages = await getChatHistory(inputChatId);
          return reply.code(200).send({
            chatId: inputChatId,
            messages,
          });
        }
      }

      const newChatId = openOpsId();
      const chatId = generateChatIdForMCP({ chatId: newChatId, userId });
      const chatContext = { chatId: newChatId };

      await createChatContext(chatId, chatContext);
      const messages = await getChatHistory(chatId);

      return reply.code(200).send({
        chatId,
        messages,
      });
    },
  );
  app.post('/', NewMessageOptions, async (request, reply) => {
    const chatId = request.body.chatId;
    const projectId = request.principal.projectId;
    const chatContext = await getChatContext(chatId);
    if (!chatContext) {
      return reply
        .code(404)
        .send('No chat session found for the provided chat ID.');
    }

    const aiConfig = await aiConfigService.getActiveConfigWithApiKey(projectId);
    if (!aiConfig) {
      return reply
        .code(404)
        .send('No active AI configuration found for the project.');
    }

    const apiKey = encryptUtils.decryptString(JSON.parse(aiConfig.apiKey));
    const languageModel = await getAiProviderLanguageModel({
      apiKey,
      model: aiConfig.model,
      provider: aiConfig.provider,
      providerSettings: aiConfig.providerSettings,
    });

    const newMessage: CoreMessage = {
      role: 'user',
      content: request.body.message,
    };

    await appendMessagesToChatHistory(chatId, [newMessage]);
    const chatHistory = await appendMessagesToChatHistoryContext(chatId, [
      newMessage,
    ]);

    const { mcpClients, tools } = await getMCPTools(
      app,
      request.headers.authorization?.replace('Bearer ', '') ?? '',
    );

    const filteredTools = await selectRelevantTools({
      messages: chatHistory,
      languageModel,
      aiConfig,
      tools,
      chatId,
    });

    const isAnalyticsLoaded = Object.keys(filteredTools ?? {}).some((key) =>
      key.includes('superset'),
    );
    const isTablesLoaded = Object.keys(filteredTools ?? {}).some((key) =>
      key.includes('table'),
    );

    const systemPrompt = await getMcpSystemPrompt({
      isAnalyticsLoaded,
      isTablesLoaded,
    });

    const streamMessagesParams: StreamMessagesParams = {
      chatId,
      aiConfig,
      mcpClients,
      systemPrompt,
      languageModel,
      attemptIndex: 0,
      handledError: false,
      tools: filteredTools,
      messages: chatHistory,
    };

    pipeDataStreamToResponse(reply.raw, {
      execute: async (dataStreamWriter) => {
        logger.debug('Send user message to LLM.');
        await streamMessages(dataStreamWriter, streamMessagesParams);
      },
      onError: (error) => {
        if (!streamMessagesParams.handledError) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          summarizeChatHistoryContext(languageModel, aiConfig, chatId).catch(
            (e) => logger.warn('Failed to summarize message history.', e),
          );

          const message = `${errorMessage}. \\nPlease try again.`;
          endStreamWithErrorMessage(reply.raw, message);
          logger.warn(message);

          sendAiChatFailureEvent({
            projectId,
            userId: request.principal.id,
            chatId,
            errorMessage: message,
            provider: aiConfig.provider,
            model: aiConfig.model,
          });

          closeMCPClients(mcpClients).catch((e) =>
            logger.warn('Failed to close mcp client.', e),
          );
        }

        return '';
      },
    });

    sendAiChatMessageSendEvent({
      projectId,
      userId: request.principal.id,
      chatId,
      provider: aiConfig.provider,
    });
  });

  app.delete('/:chatId', DeleteChatOptions, async (request, reply) => {
    const { chatId } = request.params;

    try {
      await deleteChatHistory(chatId);
      await deleteChatHistoryContext(chatId);
      return await reply.code(StatusCodes.OK).send();
    } catch (error) {
      logger.error('Failed to delete chat history with error: ', error);
      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        message: 'Failed to delete chat history',
      });
    }
  });
};

const OpenChatOptions = {
  config: {
    allowedPrincipals: [PrincipalType.USER],
  },
  schema: {
    tags: ['ai', 'ai-chat-mcp'],
    description:
      'Initialize a new MCP chat session or resume an existing one. This endpoint creates a unique chat ID and context for the conversation, supporting integration with MCP tools and services.',
    body: OpenChatMCPRequest,
  },
};

const NewMessageOptions = {
  config: {
    allowedPrincipals: [PrincipalType.USER],
  },
  schema: {
    tags: ['ai', 'ai-chat-mcp'],
    description:
      'Send a message to the MCP chat session and receive a streaming response. This endpoint processes the user message, generates an AI response using the configured language model, and maintains the conversation history while integrating with MCP tools.',
    body: NewMessageRequest,
  },
};

const DeleteChatOptions = {
  config: {
    allowedPrincipals: [PrincipalType.USER],
  },
  schema: {
    tags: ['ai', 'ai-chat-mcp'],
    description:
      'Delete an MCP chat session and its associated history. This endpoint removes all messages, context data, and MCP tool states for the specified chat ID, effectively ending the conversation.',
    params: DeleteChatHistoryRequest,
  },
};

async function streamMessages(
  dataStreamWriter: DataStreamWriter,
  params: StreamMessagesParams,
): Promise<void> {
  const { languageModel, aiConfig, chatId } = params;

  params.handledError = false;
  let stepCount = 0;

  let systemPrompt = params.systemPrompt;
  const tools = params.tools;
  let toolChoice: ToolChoice<Record<string, never>> = 'auto';
  if (!tools || Object.keys(tools).length === 0) {
    toolChoice = 'none';
    systemPrompt += `\n\nMCP tools are not available in this chat. Do not claim access or simulate responses from them under any circumstance.`;
  }

  const result = streamText({
    model: params.languageModel,
    system: systemPrompt,
    messages: params.messages,
    ...aiConfig.modelSettings,
    tools,
    toolChoice,
    maxRetries: 1,
    maxSteps: maxRecursionDepth,
    async onStepFinish({ finishReason }): Promise<void> {
      stepCount++;
      if (finishReason !== 'stop' && stepCount >= maxRecursionDepth) {
        const message = `Maximum recursion depth (${maxRecursionDepth}) reached. Terminating recursion.`;
        endStreamWithErrorMessage(dataStreamWriter, message);
        logger.warn(message);
      }
    },
    async onError({ error }) {
      params.handledError = true;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      params.attemptIndex = (params.attemptIndex ?? 0) + 1;
      if (!shouldTryToSummarize(errorMessage, params.attemptIndex)) {
        endStreamWithErrorMessage(dataStreamWriter, errorMessage);
        logger.debug(errorMessage, error);
        return;
      }

      params.messages = await summarizeChatHistoryContext(
        languageModel,
        aiConfig,
        chatId,
      );

      await streamMessages(dataStreamWriter, params);
    },
    async onFinish(result): Promise<void> {
      if (result.finishReason === 'length') {
        await summarizeChatHistoryContext(languageModel, aiConfig, chatId);
        const message = `\\n\\nThe message was truncated because the maximum tokens for the context window was reached. Please try again.`;
        endStreamWithErrorMessage(dataStreamWriter, message);
      }

      await appendMessagesToChatHistory(chatId, result.response.messages);
      await appendMessagesToChatHistoryContext(
        chatId,
        result.response.messages,
      );

      await closeMCPClients(params.mcpClients);
    },
  });

  result.mergeIntoDataStream(dataStreamWriter);
}

function endStreamWithErrorMessage(
  dataStreamWriter: NodeJS.WritableStream | DataStreamWriter,
  message: string,
): void {
  dataStreamWriter.write(`f:{"messageId":"${generateMessageId()}"}\n`);

  dataStreamWriter.write(`0:"${message}"\n`);

  dataStreamWriter.write(
    `e:{"finishReason":"stop","usage":{"promptTokens":null,"completionTokens":null},"isContinued":false}\n`,
  );
  dataStreamWriter.write(
    `d:{"finishReason":"stop","usage":{"promptTokens":null,"completionTokens":null}}\n`,
  );
}

async function closeMCPClients(mcpClients: unknown[]): Promise<void> {
  for (const mcpClient of mcpClients) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (mcpClient as any)?.close();
  }
}
