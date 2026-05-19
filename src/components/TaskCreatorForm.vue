<script setup>
import {
  NButton,
  NCard,
  NH1,
  NIcon,
  NInput,
  NModal,
  NSelect,
  NTooltip,
  NTreeSelect,
  useNotification,
} from "naive-ui";
import {PlusIcon} from "@heroicons/vue/20/solid";
import {Folder, List, Planet} from '@vicons/ionicons5'
import {CircleFilled} from "@vicons/carbon";
import {computed, defineEmits, h, ref, watch} from "vue";
import clickupService from "@/clickup-service";
import store from "@/store";
import {cloneDeep} from "lodash";
import {normalize} from "@/task-search";

const props = defineProps({
  show: {
    type: Boolean,
    required: true,
  },
  initialName: {
    type: String,
    default: '',
  },
  hierarchy: {
    type: Array,
    default: () => [],
  },
})

const emit = defineEmits(['update:show', 'created']);

const notification = useNotification();

const newTaskName = ref('');
const selectedListId = ref(null);
const selectedStatus = ref(null);
const statusOptions = ref([]);
const loadingStatuses = ref(false);
const creatingTask = ref(false);
const recentListsRef = ref(store.get('settings.recent_lists') || []);

function open(name) {
  newTaskName.value = name ?? props.initialName;
  selectedListId.value = null;
  selectedStatus.value = null;
  statusOptions.value = [];
}

watch(selectedListId, async (listId) => {
  if (!listId) {
    statusOptions.value = [];
    selectedStatus.value = null;
    return;
  }

  loadingStatuses.value = true;
  try {
    const statuses = await clickupService.getListStatuses(listId);
    statusOptions.value = buildStatusGroups(statuses);
    const previousStillExists = statuses.some(s => s.status === selectedStatus.value);
    if (!previousStillExists) {
      const active = statuses.find(s => s.type === 'custom');
      selectedStatus.value = active ? active.status : null;
    }
  } catch {
    statusOptions.value = [];
    selectedStatus.value = null;
  } finally {
    loadingStatuses.value = false;
  }
})

function close() {
  emit('update:show', false);
}

function stripTasksFromHierarchy(items) {
  return items
      .filter(item => item.type !== 'task' && item.type !== 'subtask')
      .map(item => {
        const clone = {...item};
        if (item.type === 'list') {
          clone.disable = false;
          clone.children = undefined;
        } else if (item.children) {
          clone.children = stripTasksFromHierarchy(item.children);
        }
        return clone;
      });
}

const listOptions = computed(() => {
  return stripTasksFromHierarchy(cloneDeep(props.hierarchy));
})

const MAX_RECENT_LISTS = 4;

function trackRecentList(listId) {
  const found = findListInHierarchy(props.hierarchy, listId);
  if (!found) return;

  const filtered = recentListsRef.value.filter(r => r.listId !== listId);
  filtered.unshift({
    listId,
    name: found.name,
    path: found.path,
    usedAt: Date.now(),
  });
  recentListsRef.value = filtered.slice(0, MAX_RECENT_LISTS);
  store.set('settings.recent_lists', recentListsRef.value);
}

function findListInHierarchy(items, listId, ancestors = []) {
  for (const item of items) {
    if ((item.id === listId || item.value === listId) && item.type === 'list') {
      return {name: item.name, path: ancestors.join(' > ')};
    }
    if (item.children) {
      const result = findListInHierarchy(item.children, listId, [...ancestors, item.name]);
      if (result) return result;
    }
  }
  return null;
}

async function handleCreateTask() {
  if (!selectedListId.value || !(newTaskName.value || '').trim()) return;

  creatingTask.value = true;

  try {
    const userId = await clickupService.getCurrentUserId().catch(() => null);
    const assignees = userId ? [Number(userId)] : [];

    const createdTask = await clickupService.createClickUpTask(
        selectedListId.value,
        newTaskName.value.trim(),
        assignees,
        selectedStatus.value
    );

    trackRecentList(selectedListId.value);
    emit('created', {task: createdTask, listId: selectedListId.value});
    close();

    notification.success({
      duration: 5000,
      title: 'Task created in ClickUp',
      content: `"${createdTask.name}" has been created and selected`,
    });
  } catch (error) {
    notification.error({
      duration: 5000,
      title: 'Failed to create task',
      content: 'There was a problem creating the task in ClickUp. Please try again.',
    });
    console.error(error);
  } finally {
    creatingTask.value = false;
  }
}

function renderSwitcherIcon(option) {
  let icon = null;
  let color = null;

  if (store.get('settings.custom_color_enabled')) {
    color = store.get('settings.color')
  } else {
    color = option.option.color
  }

  switch (option.option.type) {
    case 'space':
      icon = Planet
      break;
    case 'folder':
      icon = Folder;
      break;
    case 'list':
      icon = List;
      break;
    default:
      icon = CircleFilled;
      break;
  }

  return h(NIcon, {size: '15px', id: 'cascader-icon', color: color}, {default: () => h(icon)})
}

function filter(query, option) {
  const q = normalize(query);
  const fields = [];
  if (option && option.label) fields.push(option.label);
  if (option && option.name) fields.push(option.name);
  if (option && option.id) fields.push(String(option.id));
  if (option && option.value) fields.push(String(option.value));

  return fields.some(v => normalize(v).includes(q));
}

const STATUS_TYPE_LABELS = {
  open: 'Not started',
  custom: 'Active',
  closed: 'Done',
};

function buildStatusGroups(statuses) {
  const groups = new Map();
  for (const s of statuses) {
    const groupKey = s.type === 'custom' ? 'custom' : s.type;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }
    groups.get(groupKey).push({
      label: s.status.toUpperCase(),
      value: s.status,
      color: s.color,
    });
  }

  const typeOrder = ['open', 'custom', 'closed'];
  return typeOrder
      .filter(type => groups.has(type))
      .map(type => ({
        type: 'group',
        label: STATUS_TYPE_LABELS[type] || type,
        key: type,
        children: groups.get(type),
      }));
}

function renderStatusLabel(option) {
  return h('div', {style: 'display: flex; align-items: center;'}, [
    h('div', {
      style: `width: 10px; height: 10px; border-radius: 50%; border: 2px solid ${option.color || '#999'}; margin-right: 8px; flex-shrink: 0;`
    }),
    h('span', {style: 'font-weight: 500; font-size: 13px; letter-spacing: 0.02em;'}, option.label)
  ]);
}

defineExpose({open});
</script>

<template>
  <n-modal
      :show="show"
      :mask-closable="true"
      @update:show="emit('update:show', $event)"
      class="dark:bg-gray-800"
  >
    <n-card
        :bordered="false"
        aria-modal="true"
        class="max-w-md bg-white text-gray-800 dark:bg-gray-900 dark:text-gray-200"
        role="dialog"
        size="huge"
        style="border-top: 3px solid #10b981; border-radius: 12px"
    >
      <div class="mb-4">
        <n-h1 class="text-gray-900 dark:text-gray-100 !mb-1 flex items-center !text-lg">
          <plus-icon class="w-5 h-5 mr-2 text-green-500" />
          Create new task
        </n-h1>
        <p class="text-xs text-gray-400 dark:text-gray-500 ml-7">
          The task will be assigned to you automatically
        </p>
      </div>

      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Task name</label>
        <n-input
            v-model:value="newTaskName"
            placeholder="Task name"
            size="large"
            class="dark:bg-gray-800 dark:text-gray-200"
        />
      </div>

      <div class="mb-6">
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Target list</label>
        <n-tree-select
            v-model:value="selectedListId"
            :options="listOptions"
            :filterable="true"
            :filter="filter"
            :key-field="'value'"
            :disabled-field="'disable'"
            :render-prefix="renderSwitcherIcon"
            placeholder="Search for a list..."
            size="large"
            class="bg-white text-gray-800 dark:bg-gray-800 dark:text-gray-200"
        />
        <div v-if="recentListsRef.length > 0" class="mt-2">
          <p class="text-xs text-gray-400 dark:text-gray-500 mb-1.5">Recent lists</p>
          <div class="flex flex-wrap gap-1.5">
            <n-tooltip
                v-for="list in recentListsRef"
                :key="list.listId"
                :disabled="!list.path"
                placement="bottom"
            >
              <template #trigger>
                <div
                    class="inline-flex items-center text-xs rounded-full border px-3 py-1 cursor-pointer transition-colors duration-150"
                    :class="[
                      'bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700',
                      { 'ring-2 ring-green-400 dark:ring-green-500': selectedListId === list.listId }
                    ]"
                    @click="selectedListId = list.listId"
                >
                  <n-icon class="mr-1.5" size="12">
                    <List />
                  </n-icon>
                  <span class="truncate max-w-[180px]">{{ list.name }}</span>
                </div>
              </template>
              {{ list.path }}
            </n-tooltip>
          </div>
        </div>
      </div>

      <div class="mb-6">
        <label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Status</label>
        <n-select
            v-model:value="selectedStatus"
            :options="statusOptions"
            :loading="loadingStatuses"
            :disabled="!selectedListId"
            :placeholder="!selectedListId ? 'Select a list first' : 'Select a status...'"
            size="large"
            class="bg-white text-gray-800 dark:bg-gray-800 dark:text-gray-200"
            :render-label="renderStatusLabel"
        />
      </div>

      <div class="flex justify-end space-x-2">
        <n-button
            round
            @click="close"
            class="bg-gray-200 text-gray-800 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
        >
          Cancel
        </n-button>
        <n-button
            round
            type="primary"
            :disabled="!selectedListId || !(newTaskName || '').trim() || creatingTask"
            :loading="creatingTask"
            @click="handleCreateTask"
            class="bg-green-600 text-white hover:bg-green-700 dark:bg-green-700 dark:hover:bg-green-800"
        >
          Create
        </n-button>
      </div>
    </n-card>
  </n-modal>
</template>
