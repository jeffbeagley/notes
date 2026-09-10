<template>
  <nav v-if="items.length" class="breadcrumbs" aria-label="Breadcrumb">
    <ol>
      <li v-for="(item, index) in items" :key="`${item.label}-${index}`">
        <ChevronRight v-if="index > 0" class="breadcrumb-separator" :size="13" :stroke-width="1.8" aria-hidden="true" />
        <RouterLink v-if="item.to && index < items.length - 1" :to="item.to" class="breadcrumb-link">
          <component :is="item.component" v-if="item.component" :size="13" :stroke-width="1.8" aria-hidden="true" />
          <span v-else-if="item.icon" class="breadcrumb-emoji" aria-hidden="true">{{ item.icon }}</span>
          <span class="breadcrumb-text">{{ item.label }}</span>
        </RouterLink>
        <span v-else class="breadcrumb-current" aria-current="page">
          <component :is="item.component" v-if="item.component" :size="13" :stroke-width="1.8" aria-hidden="true" />
          <span v-else-if="item.icon" class="breadcrumb-emoji" aria-hidden="true">{{ item.icon }}</span>
          <span class="breadcrumb-text">{{ item.label }}</span>
        </span>
      </li>
    </ol>
  </nav>
</template>

<script setup lang="ts">
import type { Component } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { RouterLink } from 'vue-router';
import { ChevronRight } from '@lucide/vue';

export type Crumb = { label: string; to?: RouteLocationRaw; icon?: string | null; component?: Component };

defineProps<{ items: Crumb[] }>();
</script>

<style scoped>
.breadcrumbs { min-width: 0; }
.breadcrumbs ol { display: flex; align-items: center; flex-wrap: wrap; gap: 0.1rem; margin: 0; padding: 0; list-style: none; }
.breadcrumbs li { display: flex; align-items: center; min-width: 0; }
.breadcrumb-separator { color: #b9bcc4; flex: none; }
.breadcrumb-link, .breadcrumb-current { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.2rem 0.4rem; border-radius: 6px; font-size: 0.76rem; max-width: 22ch; }
.breadcrumb-link { border: 0; background: transparent; color: #6c707a; font-family: inherit; text-decoration: none; cursor: pointer; }
.breadcrumb-link:hover { background: #f1f2f4; color: #23252b; }
.breadcrumb-current { color: #23252b; font-weight: 600; }
.breadcrumb-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.breadcrumb-emoji { font-size: 0.85rem; line-height: 1; }

:root[data-theme='dark'] .breadcrumb-separator { color: #565a63; }
:root[data-theme='dark'] .breadcrumb-link { color: #9a9ea8; }
:root[data-theme='dark'] .breadcrumb-link:hover { background: #2a2d34; color: #eceef2; }
:root[data-theme='dark'] .breadcrumb-current { color: #eceef2; }
</style>
