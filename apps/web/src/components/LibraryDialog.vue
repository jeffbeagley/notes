<template>
  <div class="confirm-backdrop" role="presentation" @click.self="emit('close')">
    <section class="confirm-dialog library-dialog" role="dialog" aria-modal="true" :aria-labelledby="headingId">
      <header>
        <h2 :id="headingId">{{ heading }}</h2>
        <button class="quiet" type="button" @click="emit('close')">Close</button>
      </header>

      <label>Name
        <input v-model="draft.name" :aria-label="`${kindLabel} name`" maxlength="80" placeholder="Work" />
      </label>

      <label>Description
        <textarea v-model="draft.description" :aria-label="`${kindLabel} description`" rows="2" maxlength="240" placeholder="What lives here?" />
      </label>

      <div class="library-dialog-row">
        <label class="library-dialog-icon">Icon
          <input v-model="draft.icon" :aria-label="`${kindLabel} icon`" maxlength="4" placeholder="🏢" />
        </label>
        <fieldset class="library-dialog-colors">
          <legend>Color</legend>
          <button
            v-for="swatch in swatches"
            :key="swatch"
            type="button"
            class="color-swatch"
            :class="{ selected: draft.color === swatch }"
            :style="{ '--swatch': swatch }"
            :aria-label="`Use color ${swatch}`"
            :aria-pressed="draft.color === swatch"
            @click="draft.color = swatch"
          />
        </fieldset>
      </div>

      <div class="library-dialog-cover">
        <span class="library-dialog-cover-preview">
          <img v-if="coverUrl" :src="coverUrl" alt="Cover preview" />
          <ImagePlus v-else :size="16" :stroke-width="1.8" />
        </span>
        <div>
          <label class="upload-control" :for="uploadId"><ImagePlus :size="14" :stroke-width="1.8" />{{ uploading ? 'Uploading...' : 'Cover image' }}</label>
          <input :id="uploadId" class="image-upload-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp" @change="uploadCover" />
          <button v-if="draft.coverMediaId" class="quiet" type="button" @click="draft.coverMediaId = null">Remove cover</button>
        </div>
      </div>

      <div class="library-dialog-emojis" role="group" aria-label="Suggested icons">
        <button v-for="emoji in suggestedIcons" :key="emoji" type="button" @click="draft.icon = emoji">{{ emoji }}</button>
      </div>

      <p v-if="localError" class="error">{{ localError }}</p>
      <div class="dialog-actions">
        <button class="quiet" type="button" @click="emit('close')">Cancel</button>
        <button type="button" :disabled="saving || !draft.name.trim()" @click="submit">{{ saving ? 'Saving...' : submitLabel }}</button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ImagePlus } from '@lucide/vue';

export type LibraryDraft = { name: string; description: string; icon: string; color: string; coverMediaId: string | null };

const props = defineProps<{
  kind: 'place' | 'notebook';
  mode: 'create' | 'edit';
  value?: Partial<LibraryDraft> | null;
  saving?: boolean;
  error?: string;
}>();

const emit = defineEmits<{ close: []; submit: [LibraryDraft] }>();

const swatches = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];
const placeIcons = ['🏢', '🏠', '🚀', '📚', '🧪', '🎯', '💡', '🌱', '🎨', '🧭'];
const notebookIcons = ['📓', '📘', '📕', '🗂️', '🧾', '🗒️', '📎', '🔖', '⚙️', '📊'];

const draft = reactive<LibraryDraft>({ name: '', description: '', icon: '', color: swatches[0], coverMediaId: null });
const uploading = ref(false);
const uploadError = ref('');

const kindLabel = computed(() => (props.kind === 'place' ? 'Place' : 'Notebook'));
const heading = computed(() => `${props.mode === 'create' ? 'New' : 'Edit'} ${kindLabel.value.toLowerCase()}`);
const submitLabel = computed(() => (props.mode === 'create' ? `Create ${kindLabel.value.toLowerCase()}` : 'Save changes'));
const suggestedIcons = computed(() => (props.kind === 'place' ? placeIcons : notebookIcons));
const headingId = computed(() => `library-dialog-${props.kind}-${props.mode}`);
const uploadId = computed(() => `library-cover-${props.kind}`);
const coverUrl = computed(() => (draft.coverMediaId ? `/api/v1/media/${draft.coverMediaId}?variant=thumb` : ''));
const localError = computed(() => uploadError.value || props.error || '');

watch(() => props.value, (value) => {
  draft.name = value?.name ?? '';
  draft.description = value?.description ?? '';
  draft.icon = value?.icon ?? '';
  draft.color = value?.color ?? swatches[0];
  draft.coverMediaId = value?.coverMediaId ?? null;
}, { immediate: true, deep: true });

async function uploadCover(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  uploading.value = true;
  uploadError.value = '';
  try {
    const form = new FormData();
    form.append('file', file);
    const response = await fetch('/api/v1/media', { method: 'POST', credentials: 'include', body: form });
    // A rejected upload can come back as an HTML error page from the proxy rather than JSON.
    const raw = await response.text();
    let body: { media?: { id: string }; error?: string } = {};
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      throw new Error(response.status === 413 ? 'That image is too large. Use one under 10 MB.' : `Upload failed (${response.status})`);
    }
    if (!response.ok || !body.media) throw new Error(body.error ?? 'Unable to upload cover image');
    draft.coverMediaId = body.media.id;
  } catch (reason) {
    uploadError.value = reason instanceof Error ? reason.message : 'Unable to upload cover image';
  } finally {
    uploading.value = false;
    input.value = '';
  }
}

function submit() {
  emit('submit', { ...draft, name: draft.name.trim(), description: draft.description.trim(), icon: draft.icon.trim() });
}
</script>

<style scoped>
.library-dialog { display: flex; flex-direction: column; gap: 0.7rem; width: min(30rem, 92vw); }
.library-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
.library-dialog label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.72rem; color: #75797f; }
.library-dialog textarea { resize: vertical; font: inherit; }
.library-dialog .library-dialog-row { display: grid; grid-template-columns: 5rem minmax(0, 1fr); gap: 0.9rem; align-items: start; }
.library-dialog .library-dialog-icon { width: 100%; }
.library-dialog .library-dialog-icon input { width: 100%; box-sizing: border-box; text-align: center; font-size: 1.1rem; }
.library-dialog .library-dialog-colors { display: flex; flex-wrap: wrap; gap: 0.35rem; border: 0; padding: 0; margin: 0; }
.library-dialog-colors legend { font-size: 0.72rem; color: #75797f; padding: 0 0 0.3rem; }
.color-swatch { width: 1.35rem; height: 1.35rem; border-radius: 50%; border: 2px solid transparent; background: var(--swatch); cursor: pointer; }
.color-swatch.selected { border-color: #23252b; }
.library-dialog .library-dialog-cover { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr); gap: 0.7rem; align-items: center; }
.library-dialog-cover > div { display: flex; align-items: center; gap: 0.5rem; }
.library-dialog-cover-preview { display: inline-flex; align-items: center; justify-content: center; width: 4.5rem; height: 3rem; border-radius: 8px; border: 1px dashed #d8dade; overflow: hidden; color: #9a9ea8; flex: none; }
.library-dialog-cover-preview img { width: 100%; height: 100%; object-fit: cover; }
.image-upload-input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.library-dialog-emojis { display: flex; flex-wrap: wrap; gap: 0.25rem; }
.library-dialog-emojis button { border: 1px solid #e4e6e9; border-radius: 7px; background: #fff; padding: 0.2rem 0.35rem; font-size: 0.95rem; cursor: pointer; }
.library-dialog-emojis button:hover { border-color: #6366f1; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }

:root[data-theme='dark'] .color-swatch.selected { border-color: #eceef2; }
:root[data-theme='dark'] .library-dialog-emojis button { background: #202329; border-color: #333740; }
:root[data-theme='dark'] .library-dialog-cover-preview { border-color: #3a3e47; }
</style>
