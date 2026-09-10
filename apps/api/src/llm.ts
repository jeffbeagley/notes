import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { currentUser } from './auth.js';
import { replaceContextChunks } from './context.js';

type LlmUpdateBody = {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  chatModel?: string;
  embeddingsModel?: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
  maxTokens?: number;
};

async function requireUser(request: FastifyRequest, reply: FastifyReply, prisma: PrismaClient) {
  const user = await currentUser(request, prisma);
  if (!user) {
    await reply.code(401).send({ error: 'authentication required' });
    return null;
  }
  return user;
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply, prisma: PrismaClient) {
  const user = await requireUser(request, reply, prisma);
  if (!user) return null;
  if (user.role !== 'admin') {
    await reply.code(403).send({ error: 'admin privilege required' });
    return null;
  }
  return user;
}

const blockedHeaderNames = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

/// The base URL is admin-supplied and the API key travels with every request to it, so restrict
/// where it can point. LLM_ALLOWED_HOSTS opts a self-hosted deployment into private endpoints.
function validateBaseUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error('baseUrl must be a valid absolute URL'), { statusCode: 400 });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw Object.assign(new Error('baseUrl must use http or https'), { statusCode: 400 });
  }

  const allowedHosts = (process.env.LLM_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (allowedHosts.length) {
    if (!allowedHosts.includes(url.hostname.toLowerCase())) {
      throw Object.assign(new Error(`baseUrl host must be one of: ${allowedHosts.join(', ')}`), { statusCode: 400 });
    }
    return url.toString();
  }

  if (url.protocol !== 'https:') {
    throw Object.assign(new Error('baseUrl must use https unless the host is listed in LLM_ALLOWED_HOSTS'), { statusCode: 400 });
  }
  if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) {
    throw Object.assign(new Error('baseUrl may not target a private address unless the host is listed in LLM_ALLOWED_HOSTS'), { statusCode: 400 });
  }
  return url.toString();
}

function validateExtraHeaders(headers: Record<string, string>) {
  const entries = Object.entries(headers);
  if (entries.length > 20) throw Object.assign(new Error('at most 20 extra headers are allowed'), { statusCode: 400 });
  for (const [name, value] of entries) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || blockedHeaderNames.has(name.toLowerCase())) {
      throw Object.assign(new Error(`extra header "${name}" is not allowed`), { statusCode: 400 });
    }
    if (value.length > 1024 || /[\r\n]/.test(value)) {
      throw Object.assign(new Error(`extra header "${name}" has an invalid value`), { statusCode: 400 });
    }
  }
  return headers;
}

function clampNumber(value: number, min: number, max: number, label: string) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw Object.assign(new Error(`${label} must be between ${min} and ${max}`), { statusCode: 400 });
  }
  return Math.round(value);
}

/// Every LLM call costs money at the configured provider, so these are throttled well below the
/// global API limit. Exported so briefing/summary generation shares the same budget shape.
export const llmRouteOptions = {
  config: { rateLimit: { max: Number(process.env.LLM_RATE_LIMIT_MAX) || 30, timeWindow: '1 minute' } },
};

export async function getLlmConfig(prisma: PrismaClient) {
  const dbConfig = await prisma.llmConfig.findUnique({ where: { id: 'global' } });
  return {
    enabled: dbConfig?.enabled ?? (process.env.LLM_ENABLED === 'true'),
    baseUrl: dbConfig?.baseUrl || process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    apiKey: dbConfig?.apiKey || process.env.LLM_API_KEY || '',
    chatModel: dbConfig?.chatModel || process.env.LLM_CHAT_MODEL || 'gpt-4o-mini',
    embeddingsModel: dbConfig?.embeddingsModel || process.env.LLM_EMBEDDINGS_MODEL || '',
    extraHeaders: (dbConfig?.extraHeaders as Record<string, string> | null) ?? {},
    timeoutMs: dbConfig?.timeoutMs ?? (Number(process.env.LLM_TIMEOUT_MS) || 30000),
    maxTokens: dbConfig?.maxTokens ?? (Number(process.env.LLM_MAX_TOKENS) || 2048),
  };
}

export async function callLlm(prisma: PrismaClient, messages: { role: string; content: string }[], options: { responseFormatJson?: boolean } = {}) {
  const config = await getLlmConfig(prisma);
  if (!config.enabled) throw new Error('LLM features are currently disabled');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...config.extraHeaders,
  };

  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: config.chatModel,
        messages,
        max_tokens: config.maxTokens,
        ...(config.chatModel.toLowerCase().includes('qwen') ? { chat_template_kwargs: { enable_thinking: false } } : {}),
        ...(options.responseFormatJson ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LLM provider returned status ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timeout);
  }
}

export function registerLlmRoutes(app: FastifyInstance, prisma: PrismaClient) {
  // Admin LLM Config
  app.get('/api/v1/admin/llm-config', async (request, reply) => {
    const admin = await requireAdmin(request, reply, prisma);
    if (!admin) return;
    const config = await getLlmConfig(prisma);
    return {
      config: {
        enabled: config.enabled,
        baseUrl: config.baseUrl,
        chatModel: config.chatModel,
        embeddingsModel: config.embeddingsModel,
        extraHeaders: config.extraHeaders,
        timeoutMs: config.timeoutMs,
        maxTokens: config.maxTokens,
        hasApiKey: Boolean(config.apiKey),
      },
    };
  });

  app.put<{ Body: LlmUpdateBody }>('/api/v1/admin/llm-config', async (request, reply) => {
    const admin = await requireAdmin(request, reply, prisma);
    if (!admin) return;
    const b = request.body ?? {};
    const baseUrl = b.baseUrl !== undefined ? validateBaseUrl(b.baseUrl) : undefined;
    const extraHeaders = b.extraHeaders !== undefined ? validateExtraHeaders(b.extraHeaders) : undefined;
    const timeoutMs = b.timeoutMs !== undefined ? clampNumber(b.timeoutMs, 1000, 300000, 'timeoutMs') : undefined;
    const maxTokens = b.maxTokens !== undefined ? clampNumber(b.maxTokens, 1, 200000, 'maxTokens') : undefined;
    const updated = await prisma.llmConfig.upsert({
      where: { id: 'global' },
      create: {
        id: 'global',
        enabled: b.enabled ?? false,
        baseUrl,
        apiKey: b.apiKey,
        chatModel: b.chatModel,
        embeddingsModel: b.embeddingsModel,
        extraHeaders: extraHeaders ?? {},
        timeoutMs: timeoutMs ?? 30000,
        maxTokens: maxTokens ?? 2048,
      },
      update: {
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(b.apiKey !== undefined ? { apiKey: b.apiKey } : {}),
        ...(b.chatModel !== undefined ? { chatModel: b.chatModel } : {}),
        ...(b.embeddingsModel !== undefined ? { embeddingsModel: b.embeddingsModel } : {}),
        ...(extraHeaders !== undefined ? { extraHeaders } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      },
    });
    return {
      config: {
        enabled: updated.enabled,
        baseUrl: updated.baseUrl,
        chatModel: updated.chatModel,
        embeddingsModel: updated.embeddingsModel,
        extraHeaders: updated.extraHeaders,
        timeoutMs: updated.timeoutMs,
        maxTokens: updated.maxTokens,
        hasApiKey: Boolean(updated.apiKey),
      },
    };
  });

  // Suggest Rewrite
  app.post<{ Params: { id: string }; Body: { instruction?: string; customPrompt?: string; systemPrompt?: string } }>('/api/v1/notes/:id/suggest-rewrite', llmRouteOptions, async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const note = await prisma.note.findFirst({ where: { id: request.params.id, userId: user.id } });
    if (!note) return reply.code(404).send({ error: 'note not found' });

    const defaultSystemPrompt = `You are a helpful writing assistant. Use only the provided sources. Preserve existing hide markers like ==!text== and :::hide in unedited or rewritten regions. Do not unwrap or leak secret spans unless explicitly instructed. Return only the rewritten markdown body.`;
    const systemPrompt = request.body.systemPrompt?.trim() || defaultSystemPrompt;
    const instruction = request.body.customPrompt?.trim() || request.body.instruction?.trim() || 'Improve grammar, clarity, and formatting.';
    const userPrompt = `Instruction: ${instruction}\n\nDocument body:\n${note.bodyMarkdown}`;

    try {
      const rewritten = await callLlm(prisma, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);
      return { suggestion: rewritten };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'LLM error';
      return reply.code(503).send({ error: message });
    }
  });

  app.post<{ Params: { id: string }; Body: { selectedText?: string; instruction?: string } }>('/api/v1/notes/:id/suggest-selection-rewrite', llmRouteOptions, async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const note = await prisma.note.findFirst({ where: { id: request.params.id, userId: user.id, type: 'note' } });
    if (!note) return reply.code(404).send({ error: 'note not found' });
    const selectedText = request.body.selectedText?.trim();
    if (!selectedText) return reply.code(400).send({ error: 'select text to rewrite' });
    const instruction = request.body.instruction?.trim() || 'Improve clarity and concision.';
    try {
      const suggestion = await callLlm(prisma, [
        { role: 'system', content: 'You are a precise writing editor. Rewrite only the selected text according to the instruction. Preserve its meaning and Markdown formatting. Return only the replacement text.' },
        { role: 'user', content: `Instruction: ${instruction}\n\nSelected text:\n${selectedText}` },
      ]);
      return { suggestion };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'LLM error';
      return reply.code(503).send({ error: message });
    }
  });

  // Apply Rewrite
  app.post<{ Params: { id: string }; Body: { bodyMarkdown: string } }>('/api/v1/notes/:id/apply-rewrite', async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const note = await prisma.note.findFirst({ where: { id: request.params.id, userId: user.id } });
    if (!note) return reply.code(404).send({ error: 'note not found' });
    const bodyMarkdown = request.body.bodyMarkdown;
    if (typeof bodyMarkdown !== 'string') return reply.code(400).send({ error: 'bodyMarkdown is required' });

    const updated = await prisma.$transaction(async (tx) => {
      // Snapshot pre-rewrite state
      await tx.documentVersion.create({
        data: {
          userId: user.id,
          documentType: 'note',
          documentId: note.id,
          versionN: note.version,
          title: note.title,
          bodyMarkdown: note.bodyMarkdown,
          source: 'rewrite_apply',
        },
      });
      const saved = await tx.note.update({
        where: { id: note.id },
        data: { bodyMarkdown, version: { increment: 1 } },
      });
      await replaceContextChunks(tx, user.id, 'note', saved.id, saved.title, bodyMarkdown);
      await tx.documentDraft.upsert({
        where: { documentType_documentId: { documentType: 'note', documentId: note.id } },
        create: { userId: user.id, documentType: 'note', documentId: note.id, title: saved.title, bodyMarkdown, baseVersion: saved.version },
        update: { title: saved.title, bodyMarkdown, baseVersion: saved.version },
      });
      return saved;
    });
    return { note: updated };
  });

  // Suggest Auto-Tags
  app.post<{ Params: { id: string }; Body: { customPrompt?: string; systemPrompt?: string } }>('/api/v1/notes/:id/suggest-tags', llmRouteOptions, async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const note = await prisma.note.findFirst({ where: { id: request.params.id, userId: user.id } });
    if (!note) return reply.code(404).send({ error: 'note not found' });

    const baseSystemPrompt = request.body.systemPrompt?.trim() || `You are a tagging assistant. Analyze the document and return a JSON object with key "tags" containing a list of 1 to 5 concise, lowercase, single-word or hyphenated string tags. Example: {"tags": ["journal", "work-log"]}`;
    const userPrompt = `${request.body.customPrompt ? `Custom instruction: ${request.body.customPrompt}\n\n` : ''}Title: ${note.title}\n\nBody:\n${note.bodyMarkdown}`;

    try {
      const jsonText = await callLlm(prisma, [
        { role: 'system', content: baseSystemPrompt },
        { role: 'user', content: userPrompt },
      ], { responseFormatJson: true });

      const parsed = JSON.parse(jsonText) as { tags?: string[] };
      const tags = (parsed.tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean);
      return { tags };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'LLM error';
      return reply.code(503).send({ error: message });
    }
  });

  // Extract Action Items / Tasks
  app.post<{ Params: { id: string }; Body: { customPrompt?: string; systemPrompt?: string } }>('/api/v1/notes/:id/extract-tasks', llmRouteOptions, async (request, reply) => {
    const user = await requireUser(request, reply, prisma);
    if (!user) return;
    const note = await prisma.note.findFirst({ where: { id: request.params.id, userId: user.id } });
    if (!note) return reply.code(404).send({ error: 'note not found' });

    const baseSystemPrompt = request.body.systemPrompt?.trim() || `You are a task extraction assistant. Extract action items or implied tasks from the document. Return a JSON object with key "tasks" containing array of objects with "title" (string) and optional "dueDate" (YYYY-MM-DD or null). Example: {"tasks": [{"title": "Send report", "dueDate": "2026-09-05"}]}`;
    const userPrompt = `${request.body.customPrompt ? `Custom instruction: ${request.body.customPrompt}\n\n` : ''}Title: ${note.title}\n\nBody:\n${note.bodyMarkdown}`;

    try {
      const jsonText = await callLlm(prisma, [
        { role: 'system', content: baseSystemPrompt },
        { role: 'user', content: userPrompt },
      ], { responseFormatJson: true });

      const parsed = JSON.parse(jsonText) as { tasks?: { title: string; dueDate?: string }[] };
      const tasks = (parsed.tasks ?? []).filter((t) => typeof t.title === 'string' && t.title.trim().length > 0);
      return { tasks };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'LLM error';
      return reply.code(503).send({ error: message });
    }
  });
}
