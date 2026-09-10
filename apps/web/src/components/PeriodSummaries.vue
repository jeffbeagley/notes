<template>
  <article class="tasks period-summaries">
    <header>
      <h2>Period Summaries</h2>
      <button class="quiet" type="button" @click="openAdhocDialog">+ Ad hoc range</button>
    </header>

    <section v-if="mode === 'browse'">
      <div class="year-nav">
        <button class="quiet" type="button" aria-label="Previous year" @click="changeYear(-1)"><ChevronLeft :size="15" :stroke-width="1.8" /></button>
        <strong>{{ year }}</strong>
        <button class="quiet" type="button" aria-label="Next year" @click="changeYear(1)"><ChevronRight :size="15" :stroke-width="1.8" /></button>
      </div>

      <button
        v-if="tree"
        type="button"
        class="task-row summary-row year-summary-row"
        :disabled="Boolean(pending[tree.yearSummary.periodKey])"
        @click="openNode(tree.yearSummary)"
      >
        <strong>{{ year }} Year Summary</strong>
        <p class="muted" style="margin:0;">{{ tree.yearSummary.exists ? `Last updated ${formatDate(tree.yearSummary.updatedAt)}` : 'Not generated yet — click to generate' }}</p>
      </button>

      <nav class="task-filters period-tabs" v-if="tree">
        <button :class="{ active: tab === 'quarters' }" @click="tab = 'quarters'">Quarters</button>
        <button :class="{ active: tab === 'months' }" @click="tab = 'months'">Months</button>
        <button :class="{ active: tab === 'weeks' }" @click="tab = 'weeks'">Weeks</button>
      </nav>

      <div v-if="tree" class="period-grid">
        <button
          v-for="node in tree[tab]"
          :key="node.periodKey"
          type="button"
          class="period-node"
          :class="{ exists: node.exists }"
          :disabled="Boolean(pending[node.periodKey])"
          @click="openNode(node)"
        >
          <span class="period-node-dot" :class="{ filled: node.exists }" />
          <span class="period-node-label">{{ node.label }}</span>
          <span v-if="pending[node.periodKey]" class="muted small">Generating...</span>
        </button>
      </div>

      <div v-if="adhocSummaries.length" class="adhoc-list">
        <div class="section-heading"><h3>Ad hoc summaries</h3></div>
        <button v-for="s in adhocSummaries" :key="s.id" type="button" class="task-row summary-row" @click="router.push({ name: 'summaryDetail', params: { periodKey: s.periodKey } })">
          <strong>{{ s.title }}</strong>
          <p class="muted" style="margin:0;">Last updated: {{ formatDate(s.updatedAt) }}</p>
        </button>
      </div>
    </section>

    <section v-else-if="mode === 'detail' && activeSummary" class="summary-detail">
      <header class="summary-detail-header">
        <div class="summary-detail-title">
          <button v-if="activeSummary.period !== 'custom'" class="quiet" type="button" aria-label="Previous period" :disabled="navigating" @click="navigatePeriod(-1)"><ChevronLeft :size="15" :stroke-width="1.8" /></button>
          <strong>{{ activeSummary.title }}</strong>
          <button v-if="activeSummary.period !== 'custom'" class="quiet" type="button" aria-label="Next period" :disabled="navigating" @click="navigatePeriod(1)"><ChevronRight :size="15" :stroke-width="1.8" /></button>
        </div>
        <div class="summary-detail-actions">
          <button class="quiet" type="button" :disabled="regenerating" @click="regenerate">{{ regenerating ? 'Regenerating...' : 'Regenerate' }}</button>
          <button class="quiet" type="button" @click="backToBrowse">Back to summaries</button>
        </div>
      </header>

      <div v-if="versions.length" class="version-bar">
        <select v-model="selectedVersionId" @change="onSelectVersion" aria-label="Version history">
          <option value="">Current version</option>
          <option v-for="v in versions" :key="v.id" :value="v.id">v{{ v.versionN }} · {{ formatDate(v.createdAt) }}</option>
        </select>
        <span v-if="selectedVersionId" class="muted small">Showing diff against current</span>
      </div>

      <div v-if="diffLines" class="diff-view">
        <p v-for="(line, index) in diffLines" :key="index" :class="`diff-${line.type}`">{{ line.type === 'add' ? '+ ' : line.type === 'remove' ? '- ' : '  ' }}{{ line.text }}</p>
      </div>
      <div v-else class="briefing-content" v-html="markdown.render(activeSummary.bodyMarkdown)" />
    </section>

    <div v-if="adhocDialogOpen" class="confirm-backdrop" role="presentation" @click.self="adhocDialogOpen = false">
      <section class="confirm-dialog adhoc-dialog" role="dialog" aria-modal="true">
        <header><h2>Ad hoc summary</h2><button class="quiet" type="button" @click="adhocDialogOpen = false">Close</button></header>
        <label>Start date <input v-model="adhocStart" type="date" /></label>
        <label>End date <input v-model="adhocEnd" type="date" /></label>
        <p v-if="adhocError" class="error">{{ adhocError }}</p>
        <div class="dialog-actions">
          <button :disabled="generatingAdhoc || !adhocStart || !adhocEnd" @click="generateAdhoc">{{ generatingAdhoc ? 'Generating...' : 'Generate' }}</button>
        </div>
      </section>
    </div>
  </article>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ChevronLeft, ChevronRight } from '@lucide/vue';
import MarkdownIt from 'markdown-it';
import { diffLines as computeDiffLines } from '../diff';

type TreeNode = { period: string; periodKey: string; label: string; start: string; end: string; exists: boolean; id: string | null; updatedAt: string | null };
type Tree = { year: number; yearSummary: TreeNode; quarters: TreeNode[]; months: TreeNode[]; weeks: TreeNode[] };
type Summary = { id: string; title: string; bodyMarkdown: string; period: string; periodKey: string; updatedAt: string };
type VersionMeta = { id: string; versionN: number; source: string; createdAt: string };

const emit = defineEmits<{ detail: [title: string | null] }>();

const route = useRoute();
const router = useRouter();
const markdown = new MarkdownIt({ linkify: true, typographer: true });

const mode = ref<'browse' | 'detail'>('browse');
const year = ref(new Date().getFullYear());
const tab = ref<'quarters' | 'months' | 'weeks'>('months');
const tree = ref<Tree | null>(null);
const pending = ref<Record<string, boolean>>({});
const adhocSummaries = ref<Summary[]>([]);

const activeSummary = ref<Summary | null>(null);
const regenerating = ref(false);
const navigating = ref(false);
const versions = ref<VersionMeta[]>([]);
const selectedVersionId = ref('');
const diffLines = ref<{ type: 'add' | 'remove' | 'same'; text: string }[] | null>(null);

const adhocDialogOpen = ref(false);
const adhocStart = ref('');
const adhocEnd = ref('');
const generatingAdhoc = ref(false);
const adhocError = ref('');

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString() : '';
}

async function loadTree() {
  const res = await fetch(`/api/v1/summaries/tree?year=${year.value}`, { credentials: 'include' });
  if (res.ok) tree.value = (await res.json()) as Tree;
}

async function loadAdhocSummaries() {
  const res = await fetch('/api/v1/summaries?period=custom', { credentials: 'include' });
  if (res.ok) adhocSummaries.value = ((await res.json()) as { summaries: Summary[] }).summaries || [];
}

function changeYear(delta: number) {
  year.value += delta;
  void loadTree();
}

async function openNode(node: TreeNode) {
  pending.value = { ...pending.value, [node.periodKey]: true };
  try {
    await openOrGenerate(node);
  } finally {
    pending.value = { ...pending.value, [node.periodKey]: false };
  }
}

/// Navigates to a period's URL, generating it first if it doesn't exist yet. The route watcher below loads the data.
async function openOrGenerate(node: TreeNode) {
  if (node.exists) {
    await router.push({ name: 'summaryDetail', params: { periodKey: node.periodKey } });
    return;
  }
  const res = await fetch('/api/v1/summaries/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ period: node.period, periodKey: node.periodKey }),
  });
  if (!res.ok) return;
  await loadTree();
  await router.push({ name: 'summaryDetail', params: { periodKey: node.periodKey } });
}

async function loadByPeriodKey(periodKey: string) {
  const res = await fetch(`/api/v1/summaries/by-key/${periodKey}`, { credentials: 'include' });
  if (!res.ok) {
    mode.value = 'browse';
    activeSummary.value = null;
    emit('detail', null);
    return;
  }
  const summary = ((await res.json()) as { summary: Summary }).summary;
  activeSummary.value = summary;
  selectedVersionId.value = '';
  diffLines.value = null;
  mode.value = 'detail';
  emit('detail', summary.title);
  syncBrowseStateToSummary(summary);
  await loadVersions(summary.id);
}

/// Keeps the underlying year/tab in sync with the open summary so returning to browse mode lands somewhere sensible.
function syncBrowseStateToSummary(summary: Summary) {
  if (summary.period === 'custom') return;
  const keyYear = Number(summary.periodKey.slice(0, 4));
  if (Number.isFinite(keyYear) && keyYear !== year.value) {
    year.value = keyYear;
    void loadTree();
  }
  if (summary.period !== 'year') tab.value = tabForPeriod(summary.period);
}

watch(
  () => route.params.periodKey,
  (periodKey) => {
    if (typeof periodKey === 'string') void loadByPeriodKey(periodKey);
    else {
      mode.value = 'browse';
      activeSummary.value = null;
      emit('detail', null);
    }
  },
  { immediate: true }
);

async function loadVersions(id: string) {
  const res = await fetch(`/api/v1/summaries/${id}/versions`, { credentials: 'include' });
  if (res.ok) versions.value = ((await res.json()) as { versions: VersionMeta[] }).versions || [];
}

async function onSelectVersion() {
  if (!activeSummary.value) return;
  if (!selectedVersionId.value) {
    diffLines.value = null;
    return;
  }
  const res = await fetch(`/api/v1/summaries/${activeSummary.value.id}/versions/${selectedVersionId.value}`, { credentials: 'include' });
  if (!res.ok) return;
  const version = ((await res.json()) as { version: { bodyMarkdown: string } }).version;
  diffLines.value = computeDiffLines(version.bodyMarkdown, activeSummary.value.bodyMarkdown);
}

async function regenerate() {
  if (!activeSummary.value) return;
  regenerating.value = true;
  try {
    const res = await fetch('/api/v1/summaries/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ period: activeSummary.value.period, periodKey: activeSummary.value.periodKey }),
    });
    if (res.ok) {
      const body = (await res.json()) as { summary: Summary };
      activeSummary.value = body.summary;
      selectedVersionId.value = '';
      diffLines.value = null;
      await loadVersions(body.summary.id);
      await loadTree();
    }
  } finally {
    regenerating.value = false;
  }
}

function tabForPeriod(period: string): 'quarters' | 'months' | 'weeks' {
  return period === 'quarter' ? 'quarters' : period === 'month' ? 'months' : 'weeks';
}

/// Steps to the adjacent period of the same type, crossing into the neighboring year's tree when at a year boundary.
async function navigatePeriod(direction: 1 | -1) {
  if (!activeSummary.value || navigating.value) return;
  const period = activeSummary.value.period;
  if (period === 'custom') return;
  navigating.value = true;
  try {
    if (period === 'year') {
      const targetYear = Number(activeSummary.value.periodKey) + direction;
      const res = await fetch(`/api/v1/summaries/tree?year=${targetYear}`, { credentials: 'include' });
      if (!res.ok) return;
      const targetTree = (await res.json()) as Tree;
      year.value = targetYear;
      tree.value = targetTree;
      await openOrGenerate(targetTree.yearSummary);
      return;
    }

    const key = tabForPeriod(period);
    const activeYear = Number(activeSummary.value.periodKey.slice(0, 4));
    let workingTree = tree.value?.year === activeYear ? tree.value : null;
    if (!workingTree) {
      const res = await fetch(`/api/v1/summaries/tree?year=${activeYear}`, { credentials: 'include' });
      if (!res.ok) return;
      workingTree = (await res.json()) as Tree;
      tree.value = workingTree;
      year.value = activeYear;
    }
    const list = workingTree[key];
    const idx = list.findIndex((node) => node.periodKey === activeSummary.value?.periodKey);
    const targetIdx = idx + direction;
    if (idx >= 0 && targetIdx >= 0 && targetIdx < list.length) {
      tab.value = key;
      await openOrGenerate(list[targetIdx]);
      return;
    }

    // At a year boundary: fetch the neighboring year's tree and jump to its first/last node for this period type.
    const targetYear = activeYear + direction;
    const res = await fetch(`/api/v1/summaries/tree?year=${targetYear}`, { credentials: 'include' });
    if (!res.ok) return;
    const targetTree = (await res.json()) as Tree;
    const targetList = targetTree[key];
    const targetNode = direction === -1 ? targetList[targetList.length - 1] : targetList[0];
    if (!targetNode) return;
    year.value = targetYear;
    tree.value = targetTree;
    tab.value = key;
    await openOrGenerate(targetNode);
  } finally {
    navigating.value = false;
  }
}

function backToBrowse() {
  void router.push({ name: 'summaries' });
}

function openAdhocDialog() {
  adhocError.value = '';
  adhocStart.value = '';
  adhocEnd.value = '';
  adhocDialogOpen.value = true;
}

async function generateAdhoc() {
  generatingAdhoc.value = true;
  adhocError.value = '';
  try {
    const res = await fetch('/api/v1/summaries/custom', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ start: adhocStart.value, end: adhocEnd.value }),
    });
    const body = (await res.json()) as { summary?: Summary; error?: string };
    if (!res.ok || !body.summary) throw new Error(body.error ?? 'Unable to generate summary');
    adhocDialogOpen.value = false;
    await loadAdhocSummaries();
    await router.push({ name: 'summaryDetail', params: { periodKey: body.summary.periodKey } });
  } catch (err) {
    adhocError.value = err instanceof Error ? err.message : 'Unable to generate summary';
  } finally {
    generatingAdhoc.value = false;
  }
}

onMounted(async () => {
  await Promise.all([loadTree(), loadAdhocSummaries()]);
});
</script>

<style scoped>
/* .year-nav, .period-grid, .period-node(-dot/-label) are shared globally with the journal archive page. */
.year-summary-row { margin-bottom: 1rem; }
.period-tabs { margin-bottom: 0.85rem; }
.small { font-size: 0.72rem; }
.adhoc-list { margin-top: 1.75rem; }
.summary-detail-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
.summary-detail-title { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }
.summary-detail-title strong { color: #24252a; font-size: 1.1rem; font-weight: 650; }
.summary-detail-actions { display: flex; gap: 0.5rem; }
.version-bar { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1rem; }
.version-bar select { padding: 0.32rem 0.4rem; border: 1px solid #e0e2e5; border-radius: 6px; color: #45474e; background: #fff; font-size: 0.72rem; }
.diff-view { padding: 1.35rem; border: 1px solid #e3e4e7; border-radius: 9px; background: #fff; box-shadow: 0 5px 18px #59616d0a; font-family: ui-monospace, monospace; font-size: 0.78rem; line-height: 1.6; white-space: pre-wrap; }
.diff-view p { margin: 0; }
.diff-add { color: #1a7f37; background: #e6ffec; }
.diff-remove { color: #b42318; background: #ffebe9; }
.diff-same { color: #45474e; }
.adhoc-dialog { display: flex; flex-direction: column; gap: 0.7rem; }
.adhoc-dialog label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.72rem; color: #75797f; }
.adhoc-dialog input { border: 1px solid #e0e2e5; border-radius: 6px; background: #fff; font-size: 0.78rem; padding: 0.5rem 0.6rem; }
.dialog-actions { display: flex; justify-content: flex-end; }
</style>
