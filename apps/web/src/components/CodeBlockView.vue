<template>
  <NodeViewWrapper class="code-block-node">
    <div class="code-block-header" contenteditable="false">
      <select :value="node.attrs.language || 'plaintext'" aria-label="Code block language" @change="updateLanguage">
        <option value="plaintext">Plain text</option>
        <option value="javascript">JavaScript</option>
        <option value="typescript">TypeScript</option>
        <option value="json">JSON</option>
        <option value="python">Python</option>
        <option value="bash">Bash</option>
        <option value="html">HTML</option>
        <option value="css">CSS</option>
        <option value="sql">SQL</option>
      </select>
      <button type="button" title="Copy code" aria-label="Copy code" @click="copyCode"><Copy :size="14" />Copy</button>
    </div>
    <pre><code><NodeViewContent as="code" class="code-block-content" /></code></pre>
  </NodeViewWrapper>
</template>

<script setup lang="ts">
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/vue-3';
import { Copy } from '@lucide/vue';

const props = defineProps<NodeViewProps>();

function updateLanguage(event: Event) {
  props.updateAttributes({ language: (event.target as HTMLSelectElement).value });
}

async function copyCode() {
  await navigator.clipboard.writeText(props.node.textContent);
}
</script>

<style scoped>
.code-block-node { margin: 1.25rem 0; overflow: hidden; border: 1px solid #343b4a; border-radius: 7px; background: #20242d; box-shadow: 0 3px 9px #1c1d211f; }
.code-block-header { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.45rem 0.6rem; border-bottom: 1px solid #343b4a; background: #272c37; }
.code-block-header select { min-height: 1.8rem; padding: 0.2rem 1.5rem 0.2rem 0.4rem; border: 1px solid #444d5e; border-radius: 4px; color: #d9e1ee; background-color: #20242d; font: inherit; font-size: 0.7rem; }
.code-block-header button { display: flex; align-items: center; gap: 0.3rem; padding: 0.28rem 0.45rem; border: 1px solid #444d5e; border-radius: 4px; color: #d9e1ee; background: transparent; font: inherit; font-size: 0.7rem; cursor: pointer; }.code-block-header button:hover { border-color: #a88be6; color: #fff; background: #343044; }
pre { margin: 0; padding: 1rem 1.15rem; overflow-x: auto; color: #d9e1ee; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.82rem; line-height: 1.65; } code { display: block; }
</style>