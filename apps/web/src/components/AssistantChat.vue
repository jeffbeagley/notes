<template>
  <div class="assistant-main">
    <div v-if="!messages.length" class="assistant-empty"><Sparkles :size="19" /><p>{{ emptyText }}</p></div>
    <div v-else class="assistant-messages">
      <section v-for="(message, index) in messages" :key="message.id" class="assistant-message" :class="message.role">
        <div class="assistant-message-body">
          <p v-if="message.role === 'user'">{{ message.content }}</p>
          <template v-else>
            <div v-if="message.toolCalls?.length" class="assistant-tool-calls">
              <component
                :is="call.source ? 'button' : 'span'"
                v-for="(call, callIndex) in message.toolCalls"
                :key="callIndex"
                type="button"
                class="assistant-tool-call"
                :class="{ running: call.status === 'running', failed: call.status === 'done' && call.ok === false, linkable: Boolean(call.source) }"
                @click="call.source && emit('source-click', call.source)"
              >
                <Loader2 v-if="call.status === 'running'" class="spin" :size="12" />
                <CheckCircle2 v-else :size="12" />{{ toolLabel(call) }}<ArrowUpRight v-if="call.source" :size="11" />
              </component>
            </div>
            <div class="assistant-markdown" v-html="renderContent(message)" @click="emit('link-click', $event, message)" />
            <div v-if="message.choices" class="assistant-choices">
              <p class="assistant-choices-question">{{ message.choices.question }}</p>
              <div class="assistant-choices-options">
                <button
                  v-for="option in message.choices.options"
                  :key="option.value"
                  type="button"
                  class="assistant-choice"
                  :class="{ chosen: message.chosenLabel === option.label }"
                  :disabled="!isChoicePending(message, index)"
                  @click="emit('choose', message, option)"
                >
                  <span class="assistant-choice-label">{{ option.label }}</span>
                  <small v-if="option.hint">{{ option.hint }}</small>
                </button>
              </div>
              <p v-if="message.chosenLabel" class="assistant-choices-answered">You chose “{{ message.chosenLabel }}”.</p>
            </div>
          </template>
        </div>
        <div class="assistant-message-actions">
          <button type="button" :title="copiedMessageId === message.id ? 'Copied' : 'Copy message'" :aria-label="copiedMessageId === message.id ? 'Copied' : 'Copy message'" @click="emit('copy', message)">
            <Check v-if="copiedMessageId === message.id" :size="13" />
            <Copy v-else :size="13" />
            <span class="sr-only">{{ copiedMessageId === message.id ? 'Copied' : 'Copy message' }}</span>
          </button>
          <template v-if="message.role === 'user'">
            <button type="button" title="Edit and resend message" aria-label="Edit and resend message" :disabled="sending" @click="emit('edit', message, index)"><Pencil :size="13" /><span class="sr-only">Edit and resend</span></button>
            <button type="button" title="Resend message" aria-label="Resend message" :disabled="sending" @click="emit('resend', message, index)"><RotateCcw :size="13" /><span class="sr-only">Resend</span></button>
          </template>
        </div>
      </section>
      <div v-if="sending" class="assistant-message assistant-thinking">Thinking...</div>
      <div ref="scrollAnchor" />
    </div>
    <form class="assistant-composer" @submit.prevent="emit('submit')">
      <input :value="prompt" :aria-label="inputLabel" :placeholder="placeholder" :disabled="sending" @input="emit('update:prompt', ($event.target as HTMLInputElement).value)" />
      <button type="submit" title="Send message" :disabled="sending || !prompt.trim()"><Send :size="16" /></button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ArrowUpRight, Check, CheckCircle2, Copy, Loader2, Pencil, RotateCcw, Send, Sparkles } from '@lucide/vue';

export type AssistantSearchHit = { id: string; type: 'note' | 'journal' | 'task'; title: string; snippet: string; date: string };
export type AssistantToolCall = { name: string; args: Record<string, unknown>; status: 'running' | 'done'; summary?: string; ok?: boolean; source?: AssistantSearchHit };
export type AssistantChoiceOption = { label: string; value: string; hint?: string };
export type AssistantChoices = { question: string; options: AssistantChoiceOption[] };
export type AssistantMessage = { id: string; role: 'user' | 'assistant'; content: string; sources?: AssistantSearchHit[]; toolCalls?: AssistantToolCall[]; choices?: AssistantChoices; chosenLabel?: string };

defineProps<{
  messages: AssistantMessage[];
  prompt: string;
  sending: boolean;
  copiedMessageId: string | null;
  emptyText: string;
  placeholder: string;
  inputLabel: string;
  renderContent: (message: AssistantMessage) => string;
  toolLabel: (call: AssistantToolCall) => string;
  isChoicePending: (message: AssistantMessage, index: number) => boolean;
}>();

const emit = defineEmits<{
  'update:prompt': [value: string];
  submit: [];
  copy: [message: AssistantMessage];
  edit: [message: AssistantMessage, index: number];
  resend: [message: AssistantMessage, index: number];
  choose: [message: AssistantMessage, option: AssistantChoiceOption];
  'source-click': [source: AssistantSearchHit];
  'link-click': [event: MouseEvent, message: AssistantMessage];
}>();

const scrollAnchor = defineModel<HTMLElement | null>('scrollAnchor', { default: null });
</script>