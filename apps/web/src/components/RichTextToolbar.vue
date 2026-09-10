<template>
  <div class="simple-editor-toolbar" role="toolbar" aria-label="toolbar" :data-editor-state="toolbarVersion">
    <div class="toolbar-group" role="group">
      <button type="button" title="Undo" :disabled="!editor?.can().undo()" @click="editor?.chain().focus().undo().run()"><Undo2 :size="16" /></button>
      <button type="button" title="Redo" :disabled="!editor?.can().redo()" @click="editor?.chain().focus().redo().run()"><Redo2 :size="16" /></button>
    </div>
    <div class="toolbar-group" role="group">
      <div class="toolbar-menu"><button type="button" aria-label="Format text as heading" aria-haspopup="menu" :aria-expanded="openMenu === 'heading'" :aria-pressed="editor?.isActive('heading')" :class="{ active: editor?.isActive('heading') }" @click.stop="toggleMenu('heading')"><Heading2 :size="16" /><ChevronDown :size="13" /></button><div v-if="openMenu === 'heading'" class="toolbar-popover" role="menu"><button v-for="level in [1, 2, 3, 4, 5, 6]" :key="level" type="button" role="menuitem" :class="{ active: editor?.isActive('heading', { level }) }" @click="setHeading(level)">Heading {{ level }}</button></div></div>
      <div class="toolbar-menu"><button type="button" aria-label="List options" aria-haspopup="menu" :aria-expanded="openMenu === 'list'" :aria-pressed="editor?.isActive('bulletList') || editor?.isActive('orderedList') || editor?.isActive('taskList')" :class="{ active: editor?.isActive('bulletList') || editor?.isActive('orderedList') || editor?.isActive('taskList') }" @click.stop="toggleMenu('list')"><List :size="16" /><ChevronDown :size="13" /></button><div v-if="openMenu === 'list'" class="toolbar-popover" role="menu"><button type="button" role="menuitem" :class="{ active: editor?.isActive('bulletList') }" @click="toggleList('bullet')"><List :size="15" />Bullet List</button><button type="button" role="menuitem" :class="{ active: editor?.isActive('orderedList') }" @click="toggleList('ordered')"><ListOrdered :size="15" />Ordered List</button><button type="button" role="menuitem" :class="{ active: editor?.isActive('taskList') }" @click="toggleList('task')"><ListChecks :size="15" />Task List</button></div></div>
      <button type="button" title="Blockquote" :class="{ active: editor?.isActive('blockquote') }" @click="editor?.chain().focus().toggleBlockquote().run()"><Quote :size="16" /></button><button type="button" title="Insert code block" @mousedown.prevent @click="emit('insertCode')"><Code2 :size="16" /></button>
    </div>
    <div class="toolbar-group" role="group">
      <button type="button" title="Bold" :class="{ active: editor?.isActive('bold') }" @click="editor?.chain().focus().toggleBold().run()"><Bold :size="16" /></button><button type="button" title="Italic" :class="{ active: editor?.isActive('italic') }" @click="editor?.chain().focus().toggleItalic().run()"><Italic :size="16" /></button><button type="button" title="Strike" :class="{ active: editor?.isActive('strike') }" @click="editor?.chain().focus().toggleStrike().run()"><Strikethrough :size="16" /></button><button type="button" title="Code" :class="{ active: editor?.isActive('code') }" @click="editor?.chain().focus().toggleCode().run()"><Code2 :size="16" /></button><button type="button" title="Underline" :class="{ active: editor?.isActive('underline') }" @click="editor?.chain().focus().toggleUnderline().run()"><Underline :size="16" /></button><button type="button" title="Highlight" :class="{ active: editor?.isActive('highlight') }" @click="editor?.chain().focus().toggleHighlight().run()"><Highlighter :size="16" /></button><button type="button" title="Rewrite selected text with AI" :disabled="!hasSelection" @mousedown.prevent @click="emit('rewriteSelection')"><WandSparkles :size="16" /></button><button type="button" title="Hide selected text" :class="{ active: editor?.isActive('hiddenText') }" @mousedown.prevent @click="editor?.chain().focus().toggleMark('hiddenText').run()"><EyeOff :size="16" /></button><button type="button" title="Link" :class="{ active: editor?.isActive('link') }" @click="applyLink"><Link2 :size="16" /></button>
    </div>
    <div class="toolbar-group" role="group"><button type="button" title="Superscript" :class="{ active: editor?.isActive('superscript') }" @click="editor?.chain().focus().toggleSuperscript().run()"><Superscript :size="16" /></button><button type="button" title="Subscript" :class="{ active: editor?.isActive('subscript') }" @click="editor?.chain().focus().toggleSubscript().run()"><Subscript :size="16" /></button></div>
    <div class="toolbar-group" role="group"><button type="button" title="Align left" :class="{ active: editor?.isActive({ textAlign: 'left' }) }" @click="editor?.chain().focus().setTextAlign('left').run()"><AlignLeft :size="16" /></button><button type="button" title="Align center" :class="{ active: editor?.isActive({ textAlign: 'center' }) }" @click="editor?.chain().focus().setTextAlign('center').run()"><AlignCenter :size="16" /></button><button type="button" title="Align right" :class="{ active: editor?.isActive({ textAlign: 'right' }) }" @click="editor?.chain().focus().setTextAlign('right').run()"><AlignRight :size="16" /></button><button type="button" title="Align justify" :class="{ active: editor?.isActive({ textAlign: 'justify' }) }" @click="editor?.chain().focus().setTextAlign('justify').run()"><AlignJustify :size="16" /></button></div>
    <div class="toolbar-group toolbar-add-group" role="group"><button type="button" aria-label="Add image" @click="imageInput?.click()"><ImagePlus :size="16" /><span>Add</span></button><input ref="imageInput" type="file" accept="image/png,image/jpeg,image/gif,image/webp" @change="emit('upload', $event)" /></div>
    <div class="toolbar-group toolbar-actions" role="group"><button type="button" title="Search and replace" :class="{ active: searchOpen }" @click="emit('toggleSearch')"><Replace :size="16" /></button><button type="button" :title="isDark ? 'Switch to light mode' : 'Switch to dark mode'" @click="emit('toggleTheme')"><Sun v-if="isDark" :size="16" /><Moon v-else :size="16" /></button></div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { Editor } from '@tiptap/core';
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, ChevronDown, Code2, EyeOff, Heading2, Highlighter, ImagePlus, Italic, Link2, List, ListChecks, ListOrdered, Moon, Quote, Redo2, Replace, Strikethrough, Subscript, Sun, Superscript, Underline, Undo2, WandSparkles } from '@lucide/vue';

const props = defineProps<{ editor?: Editor | null; isDark: boolean; searchOpen: boolean }>();
const emit = defineEmits<{ upload: [event: Event]; insertCode: []; rewriteSelection: []; toggleSearch: []; toggleTheme: [] }>();
const openMenu = ref<'heading' | 'list' | null>(null);
const imageInput = ref<HTMLInputElement | null>(null);
const toolbarVersion = ref(0);
const hasSelection = ref(false);

function refreshToolbarState() {
  toolbarVersion.value += 1;
  hasSelection.value = !props.editor?.state.selection.empty;
}

function toggleMenu(menu: 'heading' | 'list') {
  openMenu.value = openMenu.value === menu ? null : menu;
}

function closeMenu() {
  openMenu.value = null;
}

function setHeading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  props.editor?.chain().focus().toggleHeading({ level }).run();
  closeMenu();
}

function toggleList(type: 'bullet' | 'ordered' | 'task') {
  const command = props.editor?.chain().focus();
  if (type === 'bullet') command?.toggleBulletList().run();
  if (type === 'ordered') command?.toggleOrderedList().run();
  if (type === 'task') command?.toggleTaskList().run();
  closeMenu();
}

function applyLink() {
  const href = window.prompt('Link URL');
  if (href) props.editor?.chain().focus().setLink({ href }).run();
}

watch(() => props.editor, (editor, previousEditor) => {
  previousEditor?.off('transaction', refreshToolbarState);
  editor?.on('transaction', refreshToolbarState);
}, { immediate: true });

window.addEventListener('click', closeMenu);
onBeforeUnmount(() => {
  props.editor?.off('transaction', refreshToolbarState);
  window.removeEventListener('click', closeMenu);
});
</script>

<style scoped>
.simple-editor-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; overflow: visible; padding: 0.5rem clamp(0.75rem, 3vw, 2rem); border-bottom: 1px solid #e5e6e8; background: #fafafa; position: relative; z-index: 2; }
.toolbar-group { display: flex; align-items: center; gap: 0.1rem; padding-right: 0.45rem; border-right: 1px solid #dedfe3; }.toolbar-group:last-child { padding-right: 0; border-right: 0; }
button { display: grid; width: 2rem; height: 2rem; place-items: center; padding: 0; border: 0; border-radius: 12px; color: #777b83; background: transparent; cursor: pointer; }button:hover, button:focus-visible, button.active { color: #7650dc; background: #f2efff; }button:disabled { cursor: not-allowed; opacity: 0.4; }
.toolbar-menu { position: relative; }.toolbar-menu > button { display: flex; width: auto; padding: 0 0.28rem; }.toolbar-popover { position: absolute; top: calc(100% + 0.35rem); left: 0; z-index: 3; display: grid; min-width: 9rem; padding: 0.3rem; border: 1px solid #e1e2e5; border-radius: 6px; background: #fff; box-shadow: 0 8px 22px #59616d1a; }.toolbar-popover button { display: flex; gap: 0.45rem; width: 100%; height: auto; justify-content: flex-start; padding: 0.45rem 0.55rem; font-size: 0.72rem; }
.toolbar-add-group button { display: flex; width: 4.057rem; gap: 0.25rem; padding: 0 0.45rem; font-size: 0.7rem; }.toolbar-add-group input { display: none; }.toolbar-actions { margin-left: auto; }
:global(.editor-dark) .simple-editor-toolbar { border-color: #34353b; background: #24252a; }:global(.editor-dark) .toolbar-group { border-color: #46474e; }:global(.editor-dark) button { color: #bfc0c7; }:global(.editor-dark) button:hover, :global(.editor-dark) button.active { color: #c4a9ff; background: #343044; }:global(.editor-dark) .toolbar-popover { border-color: #45464d; background: #28292f; }
</style>