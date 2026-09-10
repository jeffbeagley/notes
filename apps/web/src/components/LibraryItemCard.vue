<template>
  <div
    class="library-card"
    :class="[`library-card-${viewMode}`, `library-card-${item.type}`, { 'is-drop-target': dropTarget, 'is-dragging': dragging }]"
    :style="accentStyle"
    :draggable="draggable"
    @dragstart="emit('dragstart', $event)"
    @dragend="emit('dragend', $event)"
    @dragover="emit('dragover', $event)"
    @dragleave="emit('dragleave', $event)"
    @drop="emit('drop', $event)"
  >
    <button type="button" class="library-card-open" :title="item.title" @click="emit('open')">
      <span v-if="item.coverUrl" class="library-card-cover">
        <img :src="item.coverUrl" alt="" />
        <span v-if="item.icon" class="library-card-cover-badge" aria-hidden="true">{{ item.icon }}</span>
      </span>
      <span v-else class="library-card-mark" aria-hidden="true">
        <span v-if="item.icon" class="library-card-emoji">{{ item.icon }}</span>
        <component :is="fallbackIcon" v-else :size="viewMode === 'grid' ? 20 : 16" :stroke-width="1.8" />
      </span>
      <span class="library-card-body">
        <strong class="library-card-title">{{ item.title || 'Untitled' }}</strong>
        <small v-if="item.description" class="library-card-description">{{ item.description }}</small>
        <small v-if="item.meta" class="library-card-meta">{{ item.meta }}</small>
      </span>
    </button>
    <div class="library-card-actions">
      <button
        v-if="favoritable"
        type="button"
        class="library-card-action"
        :class="{ active: favorited }"
        :title="favorited ? 'Remove from favorites' : 'Add to favorites'"
        :aria-pressed="favorited"
        @click.stop="emit('toggle-favorite')"
      >
        <Star :size="14" :stroke-width="1.8" :fill="favorited ? 'currentColor' : 'none'" />
      </button>
      <button v-if="editable" type="button" class="library-card-action" :title="`Edit ${item.title}`" @click.stop="emit('edit')">
        <Pencil :size="14" :stroke-width="1.8" />
      </button>
      <button v-if="deletable" type="button" class="library-card-action danger" :title="`Delete ${item.title}`" @click.stop="emit('delete')">
        <Trash2 :size="14" :stroke-width="1.8" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Book, FileText, Library, Pencil, Star, Trash2 } from '@lucide/vue';

export type LibraryCardItem = {
  type: 'place' | 'notebook' | 'note';
  id: string;
  title: string;
  description?: string | null;
  meta?: string | null;
  icon?: string | null;
  color?: string | null;
  coverUrl?: string | null;
};

const props = withDefaults(defineProps<{
  item: LibraryCardItem;
  viewMode?: 'grid' | 'list';
  favorited?: boolean;
  favoritable?: boolean;
  editable?: boolean;
  deletable?: boolean;
  draggable?: boolean;
  dragging?: boolean;
  dropTarget?: boolean;
}>(), { viewMode: 'grid', favoritable: true, editable: false, deletable: false, draggable: false, dragging: false, dropTarget: false, favorited: false });

const emit = defineEmits<{
  open: [];
  edit: [];
  delete: [];
  'toggle-favorite': [];
  dragstart: [DragEvent];
  dragend: [DragEvent];
  dragover: [DragEvent];
  dragleave: [DragEvent];
  drop: [DragEvent];
}>();

const fallbackIcon = computed(() => (props.item.type === 'place' ? Library : props.item.type === 'notebook' ? Book : FileText));
const accentStyle = computed(() => ({ '--library-accent': props.item.color || '#6366f1' }));
</script>

<style scoped>
.library-card { position: relative; display: flex; align-items: stretch; border: 1px solid #e4e6e9; border-radius: 12px; background: #fff; transition: border-color 120ms, box-shadow 120ms, transform 120ms; }
.library-card:hover { border-color: var(--library-accent); box-shadow: 0 6px 18px rgb(15 18 25 / 8%); }
.library-card.is-dragging { opacity: 0.45; }
.library-card.is-drop-target { border-color: var(--library-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--library-accent) 35%, transparent); }
.library-card::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 3px; border-radius: 12px 0 0 12px; background: var(--library-accent); opacity: 0.9; }
.library-card-note::before { opacity: 0.35; }

.library-card-open { flex: 1; display: flex; gap: 0.7rem; align-items: flex-start; padding: 0.85rem 0.9rem 0.85rem 1rem; min-width: 0; text-align: left; background: none; border: 0; cursor: pointer; color: inherit; font: inherit; }
.library-card-grid .library-card-open { flex-direction: column; min-height: 7.5rem; }
.library-card-list .library-card-open { align-items: center; padding: 0.6rem 0.75rem 0.6rem 1rem; }

.library-card-mark { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 2.25rem; height: 2.25rem; border-radius: 9px; background: color-mix(in srgb, var(--library-accent) 14%, transparent); color: var(--library-accent); }
.library-card-list .library-card-mark { width: 1.85rem; height: 1.85rem; border-radius: 7px; }
.library-card-emoji { font-size: 1.1rem; line-height: 1; }
.library-card-cover { display: block; position: relative; width: 100%; height: 4.5rem; overflow: hidden; border-radius: 8px; flex: none; }
.library-card-list .library-card-cover { width: 3.25rem; height: 2.25rem; }
.library-card-cover img { width: 100%; height: 100%; object-fit: cover; }
.library-card-cover-badge { position: absolute; right: 0.25rem; bottom: 0.25rem; display: grid; place-items: center; width: 1.4rem; height: 1.4rem; border-radius: 6px; background: rgb(255 255 255 / 88%); font-size: 0.8rem; line-height: 1; box-shadow: 0 1px 4px rgb(15 18 25 / 25%); }
.library-card-list .library-card-cover-badge { display: none; }

.library-card-body { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.library-card-title { font-size: 0.85rem; font-weight: 600; color: #23252b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.library-card-description { font-size: 0.72rem; color: #75797f; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.library-card-meta { font-size: 0.68rem; color: #9a9ea8; }

.library-card-actions { display: flex; align-items: center; gap: 0.15rem; padding: 0.4rem 0.45rem; opacity: 0; transition: opacity 120ms; }
.library-card:hover .library-card-actions, .library-card:focus-within .library-card-actions { opacity: 1; }
.library-card-grid .library-card-actions { position: absolute; top: 0.2rem; right: 0.2rem; }
.library-card-action { display: inline-flex; padding: 0.28rem; border: 0; border-radius: 6px; background: none; color: #8b8f97; cursor: pointer; }
.library-card-action:hover { background: #f1f2f4; color: #23252b; }
.library-card-action.active { opacity: 1; color: #eab308; }
.library-card-action.danger:hover { background: #fee2e2; color: #b91c1c; }
.library-card-action.active, .library-card:hover .library-card-action { opacity: 1; }

:root[data-theme='dark'] .library-card { background: #202329; border-color: #333740; }
:root[data-theme='dark'] .library-card-title { color: #eceef2; }
:root[data-theme='dark'] .library-card-description { color: #a2a6ae; }
:root[data-theme='dark'] .library-card-meta { color: #7e838d; }
:root[data-theme='dark'] .library-card-action:hover { background: #2c2f37; color: #eceef2; }
:root[data-theme='dark'] .library-card-action.danger:hover { background: #4a1d1d; color: #fca5a5; }
</style>
