<script setup>
import {NEmpty, NSpin} from "naive-ui";
import {computed, defineEmits, onBeforeUnmount, ref, watch} from "vue";
import clickupService from "@/clickup-service";
import {searchTasks} from "@/task-search";

const props = defineProps({
  pattern: {
    type: String,
    required: true,
  },
});

const emit = defineEmits(['tasks-found']);

const SEARCH_DEBOUNCE_MS = 700;
const RECENT_TASKS_LIMIT = 50;
const CUSTOM_ID_PATTERN = /^[a-z]+-\d+$/i;
// ClickUp native task IDs are hash-like (e.g. "86c9bwh9a"): mixed digits
// and letters, no spaces. Require both to avoid matching regular words.
const NATIVE_ID_PATTERN = /^(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{7,}$/i;

const loading = ref(false);
const hasSearched = ref(false);

let pendingTimeout = null;
let activeRequestToken = 0;

const trimmedPattern = computed(() => props.pattern.trim());

const helperText = computed(() => {
  if (!trimmedPattern.value) return '';
  if (CUSTOM_ID_PATTERN.test(trimmedPattern.value)) return 'Looking up custom ID in ClickUp...';
  if (NATIVE_ID_PATTERN.test(trimmedPattern.value)) return 'Looking up task ID in ClickUp...';
  return 'Searching recent tasks in ClickUp...';
});

watch(() => trimmedPattern.value, (pattern) => {
  if (pendingTimeout) {
    clearTimeout(pendingTimeout);
    pendingTimeout = null;
  }

  hasSearched.value = false;

  if (!pattern) {
    loading.value = false;
    return;
  }

  loading.value = true;
  pendingTimeout = setTimeout(() => runSearch(pattern), SEARCH_DEBOUNCE_MS);
}, {immediate: true});

onBeforeUnmount(() => {
  if (pendingTimeout) {
    clearTimeout(pendingTimeout);
    pendingTimeout = null;
  }
  activeRequestToken++;
});

async function runSearch(pattern) {
  const token = ++activeRequestToken;

  let found = [];
  try {
    found = await dispatchSearch(pattern);
  } catch (e) {
    console.error('Task search fallback failed:', e);
    found = [];
  }

  if (token !== activeRequestToken) return;

  loading.value = false;
  hasSearched.value = true;

  const injectable = found.filter(task => task?.list?.id);
  if (injectable.length > 0) {
    emit('tasks-found', injectable);
  }
}

async function dispatchSearch(pattern) {
  if (CUSTOM_ID_PATTERN.test(pattern)) {
    const task = await clickupService.getTaskByCustomId(pattern, true);
    return task ? [task] : [];
  }

  if (NATIVE_ID_PATTERN.test(pattern)) {
    const task = await clickupService.getTask(pattern, true);
    return task ? [task] : [];
  }

  const recent = await clickupService.getRecentTeamTasks(RECENT_TASKS_LIMIT);
  const {exact, fuzzy} = searchTasks(recent, pattern);
  return recent.filter(task => exact.has(task.id) || fuzzy.has(task.id));
}
</script>

<template>
  <div class="px-3 py-4">
    <div v-if="loading" class="flex items-center justify-center text-gray-500 dark:text-gray-400 text-sm py-4">
      <n-spin size="small" class="mr-2" />
      <span>{{ helperText }}</span>
    </div>
    <n-empty v-else-if="hasSearched" description="No Data" class="py-2" />
  </div>
</template>
