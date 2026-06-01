<script setup>
import {
  NAvatar,
  NButton,
  NConfigProvider,
  NForm,
  NFormItem,
  NH1,
  NIcon,
  NMention,
  NTooltip,
  NTreeSelect,
  useNotification,
} from "naive-ui";
import {ArrowPathIcon, ArrowTurnDownRightIcon, PlusIcon} from "@heroicons/vue/20/solid";
import {DocumentCheckIcon, ClockIcon, StarIcon as StarIconOutline, XMarkIcon} from "@heroicons/vue/24/outline";
import {Folder, List, Planet} from '@vicons/ionicons5'
import {CircleFilled} from "@vicons/carbon";
import {computed, defineEmits, h, nextTick, onMounted, ref, watch} from "vue";
import {ipcRenderer} from 'electron';
import clickupService from "@/clickup-service";
import store from "@/store";
import {cloneDeep} from "lodash";
import {ClickUpItemFactory, ClickUpType} from "@/model/ClickUpModels";
import cache from "@/cache";
import {HIERARCHY_CACHE_KEY} from "@/clickup-service";
import TaskCreatorForm from "@/components/TaskCreatorForm.vue";
import TaskSearchFallback from "@/components/TaskSearchFallback.vue";
import {flattenTasks, normalize, searchTasks} from "@/task-search";


const props = defineProps({
  start: {
    type: Date,
    required: true,
  },
  end: {
    type: Date,
    required: true,
  },
  loading: {
    type: Boolean,
    default: false,
  },
})

const notification = useNotification();

// Emits
const emit = defineEmits(['close', 'create']);

// Refs
let clickUpItems = ref([]);
let loadingClickup = ref(false);
let loadingCreate = ref(false);
let mentionable = ref([]);
const withClosed = ref(false);
const withSubtasks = ref(true);

const showCreateTaskModal = ref(false);
const taskCreatorFormRef = ref(null);

let createForm = ref(null);
const descriptionRef = ref(null);
const treeSelectRef = ref(null);
const treeSelectOpen = ref(false);
const expandedKeys = ref([]);

let formValue = ref({
  task: {
    taskId: null,
    description: null,
  },
})

const rules = ref({
  task: {
    taskId: {
      required: true,
      message: 'Please select a task'
    },
    description: {
      validator(rule, value) {
        const requireDescriptions = store.get('settings.require_description')
        const internalTaskIds = (store.get('settings.internal_task_id') || '').split(',').map(id => id.trim()).filter(Boolean)
        const requireForThisTask = requireDescriptions && (internalTaskIds.length === 0 || internalTaskIds.includes(formValue.value.task.taskId))
        if (requireForThisTask && !value) {
          return new Error('Please describe what you worked on')
        }
        return true
      },
      trigger: ['blur']
    },
  },
})

const filterRecursive = (items, withClosed, withSubtasks) => {
  return items
      .filter(item => {
        if (item.children && Array.isArray(item.children)) {
          // Filter children recursively
          item.children = filterRecursive(item.children, withClosed, withSubtasks);
          return true;
        }

        // Exclude subtasks if not allowed
        if (!withSubtasks && item.type === ClickUpType.SUBTASK) {
          return false;
        }

        // Exclude closed items if not allowed
        if(!withClosed && item.date_closed !== null) {
          return false;
        }

        return true;
      });
};



const filteredOptions = computed(() => {
  return filterRecursive(cloneDeep(clickUpItems.value), withClosed.value, withSubtasks.value)
})

const searchPattern = computed(() => {
  return treeSelectRef.value?.pattern || '';
})

// Active shortcut keyword (first word matches a configured shortcut)
const activeShortcut = computed(() => {
  const q = normalize(searchPattern.value);
  if (!q) return null;
  const shortcuts = store.get('settings.search_shortcuts') || [];
  const firstWord = q.split(/\s+/)[0];
  return shortcuts.find(sc => normalize(sc.keyword || '') === firstWord) || null;
});

// When a shortcut is active, the keyword is stripped before searching
const effectiveSearchPattern = computed(() => {
  if (!activeShortcut.value) return searchPattern.value;
  return normalize(searchPattern.value).split(/\s+/).slice(1).join(' ').trim();
});

const searchResults = computed(() => {
  if (!effectiveSearchPattern.value) return {exact: new Set(), fuzzy: new Set()};
  const flat = flattenTasks(filteredOptions.value);
  return searchTasks(flat, effectiveSearchPattern.value);
});

const options = computed(() => {
  if (!searchPattern.value) return filteredOptions.value;
  return sortByRank(cloneDeep(filteredOptions.value), searchResults.value);
});

function sortByRank(items, {exact, fuzzy}) {
  if (!items) return items;
  for (const item of items) {
    if (item.children && Array.isArray(item.children)) {
      sortByRank(item.children, {exact, fuzzy});
    }
  }
  items.sort((a, b) => taskRank(a, exact, fuzzy) - taskRank(b, exact, fuzzy));
  return items;
}

function taskRank(item, exact, fuzzy) {
  // Container nodes (space/folder/list) keep their original order: rank 0.
  if (item.disable) return 0;
  if (exact.has(item.id)) return 0;
  if (fuzzy.has(item.id)) return 1;
  return 2;
}

const favoriteTasksRef = ref(store.get('settings.favorite_tasks') || []);

function findTaskPath(items, taskId, ancestors = []) {
  for (const item of items) {
    if ((item.value === taskId || item.id === taskId) && !item.disable) {
      return {path: ancestors, customId: item.custom_id};
    }
    if (item.children) {
      const result = findTaskPath(item.children, taskId, [...ancestors, item.name]);
      if (result) return result;
    }
  }
  return null;
}

function buildTooltip(task, hierarchyData) {
  const found = findTaskPath(hierarchyData, task.taskId);
  if (found) {
    const path = found.path.join(' > ');
    return found.customId ? `${path} (${found.customId})` : path;
  }
  const parts = [task.spaceName, task.folderName, task.listName].filter(Boolean);
  const path = parts.join(' > ');
  if (task.customId) return path ? `${path} (${task.customId})` : task.customId;
  return path || task.title;
}

function findListName(hierarchyData, taskId) {
  const found = findTaskPath(hierarchyData, taskId);
  if (!found || found.path.length === 0) return '';
  return found.path[found.path.length - 1];
}

const quickSelectTasks = computed(() => {
  const hierarchy = clickUpItems.value;
  const favoriteIds = new Set(favoriteTasksRef.value.map(f => f.taskId));
  const favorites = favoriteTasksRef.value
      .map(f => ({...f, isFavorite: true}))
      .sort((a, b) => a.title.localeCompare(b.title));
  const recents = (store.get('settings.recent_tasks') || [])
      .filter(r => !favoriteIds.has(r.taskId))
      .map(r => ({...r, isFavorite: false}));
  const all = [...favorites, ...recents];

  const titleCount = new Map();
  for (const task of all) {
    titleCount.set(task.title, (titleCount.get(task.title) || 0) + 1);
  }

  return all.map(task => ({
    ...task,
    tooltip: buildTooltip(task, hierarchy),
    showList: titleCount.get(task.title) > 1,
    resolvedListName: findListName(hierarchy, task.taskId),
  }));
});

function selectQuickTask(task) {
  formValue.value.task.taskId = task.taskId;
  nextTick(() => {
    descriptionRef.value?.focus();
  });
}

function addFavoriteTask(task) {
  const alreadyExists = favoriteTasksRef.value.some(f => f.taskId === task.taskId);
  if (alreadyExists) return;

  favoriteTasksRef.value.push({
    taskId: task.taskId,
    title: task.title,
    spaceName: task.spaceName,
    folderName: task.folderName,
    listName: task.listName,
    customId: task.customId,
    addedAt: Date.now(),
  });
  store.set('settings.favorite_tasks', favoriteTasksRef.value);
}

function removeFavoriteTask(taskId) {
  favoriteTasksRef.value = favoriteTasksRef.value.filter(f => f.taskId !== taskId);
  store.set('settings.favorite_tasks', favoriteTasksRef.value);
}

const MAX_RECENT_TASKS = 6;

function trackRecentTask(taskId, entry) {
  const loc = entry.task_location || {};
  const recents = store.get('settings.recent_tasks') || [];
  const filtered = recents.filter(r => r.taskId !== taskId);

  filtered.unshift({
    taskId,
    title: entry.task.name,
    spaceName: loc.space_name || '',
    folderName: loc.folder_name || '',
    listName: loc.list_name || '',
    customId: entry.task.custom_id || '',
    usedAt: Date.now(),
  });

  store.set('settings.recent_tasks', filtered.slice(0, MAX_RECENT_TASKS));
}

// Naive UI custom theme

/**
 * Use this for type hints under js file
 * @type import('naive-ui').GlobalThemeOverrides
 */
const customTheme = {
  common: {
    "textColorDisabled": "-n-text-color"
  }
}


/*
|--------------------------------------------------------------------------
| CASCASER HANDLERS
|--------------------------------------------------------------------------
 */

// A function that builds the cascader options. loops through the clickupItems and builds the options
async function getClickUpHierarchy() {
  // Delay showing loading indicator to avoid flash for cached data
  const loadingTimeout = setTimeout(() => {
    loadingClickup.value = true;
  }, 200); // Only show loading if it takes more than 200ms

  new Promise((resolve, reject) => {
    ipcRenderer.removeAllListeners("set-clickup-hierarchy");
    ipcRenderer.removeAllListeners("fetch-clickup-hierarchy-error");
    ipcRenderer.send("get-clickup-hierarchy");
    console.info("Fetching Clickup hierarchy (from cache when available)...");
    ipcRenderer.once("set-clickup-hierarchy", (event, hierarchy) => {
      resolve(hierarchy)
    });

    ipcRenderer.once("fetch-clickup-hierarchy-error", (event, error) => {
      onError({
        error,
        title: "Failed to fetch Clickup hierarchy in the background",
        content: "You can try again later by pressing the refresh button when searching for a space",
      })
      reject();
    });

  }).then((hierarchy) => {
    clearTimeout(loadingTimeout); // Clear timeout when data arrives
    buildAncestorIds(hierarchy)
    clickUpItems.value = hierarchy
    loadingClickup.value = false;
  }).catch(() => {
    clearTimeout(loadingTimeout); // Clear timeout on error too
    loadingClickup.value = false;
  })
}

async function refreshClickUpHierarchy() {
  // Keep previous hierarchy visible while loading new data
  loadingClickup.value = true;
  new Promise((resolve, reject) => {
    ipcRenderer.removeAllListeners("set-clickup-hierarchy");
    ipcRenderer.removeAllListeners("fetch-clickup-hierarchy-error");
    ipcRenderer.send("refresh-clickup-hierarchy");
    console.info("Refreshing Clickup hierarchy in background (previous data remains accessible)...");
    ipcRenderer.once("set-clickup-hierarchy", (event, hierarchy) => {
      resolve(hierarchy)
    });

    ipcRenderer.once("fetch-clickup-hierarchy-error", (event, error) => {
      onError({
        error,
        title: "Failed to fetch Clickup hierarchy in the background",
        content: "You can try again later by pressing the refresh button when searching for a space",
      })
      reject();
    });

  }).then((hierarchy) => {
    // Only update hierarchy after new data is loaded (keeps old data visible during load)
    buildAncestorIds(hierarchy)
    clickUpItems.value = hierarchy
    onSuccess({
      title: "Clickup hierarchy refreshed",
      content: "The Clickup hierarchy has been refreshed in the background",
    })
  }).finally(() => {
    loadingClickup.value = false;
  })
}

/*
|--------------------------------------------------------------------------
| BUTTON HANDLERS
|--------------------------------------------------------------------------
*/


function createTask() {
  createForm.value?.validate((errors) => {
    if (errors) {
      console.error('Form validation failed:', errors);
      onError({
        title: 'Form validation failed',
        content: 'Please check the form for errors',
      })
    } else {
      pushToClickup()
    }
  })

  const pushToClickup = () => {
    loadingCreate.value = true;
    clickupService.createTimeTrackingEntry(
        formValue.value.task.taskId,
        formValue.value.task.description,
        props.start,
        props.end
    ).then(entry => {
      trackRecentTask(formValue.value.task.taskId, entry);
      pushEntryToCalendar(entry);

      onSuccess({
        title: 'Task created',
        content: 'The task has been created in Clickup',
      });
    }).catch(error => {
      cancelTaskCreation()
      onError({
        error,
        title: "Looks like something went wrong",
        content: "There was a problem while pushing to Clickup. Check your console & internet connection and try again",
      })
      this.error({
        error,
        title: "Looks like something went wrong",
        content: "There was a problem while pushing to Clickup. Check your console & internet connection and try again",
      });
    }).finally(() => {
      loadingCreate.value = false;
    });
  }
}

function pushEntryToCalendar(entry) {
  console.log('Pushing entry to calendar')
  emit('create', entry);
}

function cancelTaskCreation() {
  emit('close');
}

function openCreateTaskModal() {
  const capturedName = searchPattern.value;
  showCreateTaskModal.value = true;
  nextTick(() => {
    taskCreatorFormRef.value?.open(capturedName);
  });
}

function onTaskCreated({task, listId}) {
  injectTaskIntoHierarchy(task, listId);
  formValue.value.task.taskId = task.id;
  lastSearchPattern.value = '';
  treeSelectOpen.value = false;

  nextTick(() => {
    descriptionRef.value?.focus();
  });
}

const HIERARCHY_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

function injectTaskIntoHierarchy(task, listId) {
  if (injectTaskMutate(task, listId)) {
    persistHierarchy();
  }
}

function injectTaskMutate(task, listId) {
  const factory = new ClickUpItemFactory();
  const taskItem = factory.createTask(task);

  const listItem = ensureListInHierarchy(factory, task, listId);
  if (!listItem) {
    console.warn('Could not resolve list for task', {taskId: task.id, listId});
    return false;
  }

  appendChild(listItem, taskItem);
  listItem.children.sort((a, b) => a.name.localeCompare(b.name));
  return true;
}

// Cache restore via electron-store strips prototypes, so ClickUpItem.addChild
// is not available on items that have been through a cache round-trip. Manipulate
// the children array directly to keep this working on plain objects too.
function appendChild(parent, child) {
  if (!Array.isArray(parent.children)) parent.children = [];
  parent.children.push(child);
}

function persistHierarchy() {
  clickUpItems.value = [...clickUpItems.value];
  cache.put(HIERARCHY_CACHE_KEY, clickUpItems.value, HIERARCHY_CACHE_TTL_SECONDS);
}

function ensureListInHierarchy(factory, task, listId) {
  const existingList = findItem(clickUpItems.value, item => item.type === ClickUpType.LIST && item.id === listId);
  if (existingList) return existingList;

  if (!task.list) return null;

  const space = ensureSpace(factory, task.space);
  if (!space) return null;

  const parentContainer = task.folder && !task.folder.hidden
      ? ensureFolder(factory, space, task.folder)
      : space;

  const listItem = factory.createList({...task.list, space: {id: space.id}});
  appendChild(parentContainer, listItem);
  return listItem;
}

function ensureSpace(factory, spaceInfo) {
  if (!spaceInfo?.id) return null;
  const existing = findItem(clickUpItems.value, item => item.type === ClickUpType.SPACE && item.id === spaceInfo.id);
  if (existing) return existing;

  const spaceItem = factory.createSpace({id: spaceInfo.id, name: spaceInfo.name || 'Space'});
  clickUpItems.value.push(spaceItem);
  return spaceItem;
}

function ensureFolder(factory, space, folderInfo) {
  const existing = findItem([space], item => item.type === ClickUpType.FOLDER && item.id === folderInfo.id);
  if (existing) return existing;

  const folderItem = factory.createFolder({
    id: folderInfo.id,
    name: folderInfo.name || 'Folder',
    space: {id: space.id},
  });
  appendChild(space, folderItem);
  return folderItem;
}

function findItem(items, predicate) {
  if (!items) return null;
  for (const item of items) {
    if (predicate(item)) return item;
    if (item.children) {
      const found = findItem(item.children, predicate);
      if (found) return found;
    }
  }
  return null;
}

/*
|--------------------------------------------------------------------------
| NOTIFICATION HANDLERS
|--------------------------------------------------------------------------
*/

// eslint-disable-next-line no-unused-vars
function onSuccess(options) {
  notification.success({duration: 5000, ...options});
}

function onError(options) {
  notification.error({duration: 5000, ...options});

  if (options.error) {
    console.error(options.error);
  }
}

/*
|--------------------------------------------------------------------------
| MISC & EASTER EGG LAND
|--------------------------------------------------------------------------
*/

function renderMentionLabel(option) {
  return h('div', {style: 'display: flex; align-items: center;'}, [
    h(NAvatar, {
      style: 'margin-right: 8px;',
      size: 24,
      round: true,
      src: option.avatar
    }, option.avatar ? '' : option.initials,),
    option.value
  ])
}

function renderSwitcherIcon(option) {
  // Opion.option = id, label, leaf, name, type, value
  let icon = null;
  let color = null;

  // This branch was split of from another branch were the color was made a setting, so here is the check remains to
  // see whether a custom color is set or not. This branch will be merged first so this piece will serve no purpose,
  // till the setting is implemented.
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
  if (!query) return true;
  // Return false for container nodes; NTreeSelect automatically keeps ancestors
  // of any matching leaf visible and expanded.
  if (option?.disable) return false;

  // Shortcut: restrict to selected ancestor subtree(s)
  if (activeShortcut.value) {
    const ids = activeShortcut.value.selectedKeys || [];
    if (ids.length > 0) {
      if (!option.ancestorIds?.length) return false;
      if (!ids.some(id => option.ancestorIds.includes(id))) return false;
    }
    // Shortcut keyword alone (no remaining query): accept all leaves under selected ancestors
    if (!effectiveSearchPattern.value) return true;
  }

  const {exact, fuzzy} = searchResults.value;
  return exact.has(option?.id) || fuzzy.has(option?.id);
}

function onTasksFoundFromFallback(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return;

  const existingIds = collectTaskIds(clickUpItems.value);
  const newTasks = tasks.filter(task => task?.id && !existingIds.has(task.id));

  let mutated = false;
  for (const task of newTasks) {
    if (injectTaskMutate(task, task.list.id)) mutated = true;
  }
  if (mutated) persistHierarchy();

  expandAncestorsOf(tasks);
}

function expandAncestorsOf(tasks) {
  const ancestorIds = new Set(expandedKeys.value);
  for (const task of tasks) {
    if (task?.space?.id) ancestorIds.add(task.space.id);
    if (task?.folder?.id && !task.folder.hidden) ancestorIds.add(task.folder.id);
    if (task?.list?.id) ancestorIds.add(task.list.id);
  }
  expandedKeys.value = Array.from(ancestorIds);
}

function collectTaskIds(items, accumulator = new Set()) {
  if (!Array.isArray(items)) return accumulator;
  for (const item of items) {
    if (item.id) accumulator.add(item.id);
    if (item.children) collectTaskIds(item.children, accumulator);
  }
  return accumulator;
}

// Build ancestor-id chains on leaf tasks/subtasks; used by shortcut filtering
function buildAncestorIds(items, ancestorIds = []) {
  for (const item of items) {
    const childAncestorIds = [...ancestorIds, item.id]
    if (item.type === 'task' || item.type === 'subtask') {
      item.ancestorIds = ancestorIds
    }
    if (item.children && item.children.length > 0) {
      buildAncestorIds(item.children, childAncestorIds)
    }
  }
}

// Auto-highlight first matching task in the dropdown as the user types
const _navKeys = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab', 'Shift', 'Control', 'Alt', 'Meta']);
let _highlightTimer = null;

function getFirstMatchingTask(query) {
  const find = (nodes) => {
    for (const node of nodes) {
      if ((node.type === 'task' || node.type === 'subtask') && filter(query, node)) {
        return node;
      }
      if (node.children) {
        const found = find(node.children);
        if (found) return found;
      }
    }
    return null;
  };
  return find(options.value);
}

function onSearchKeyup(e) {
  if (e.target.tagName !== 'INPUT' || _navKeys.has(e.key)) return;
  const query = e.target.value;
  if (!query || !treeSelectRef.value) return;
  if (_highlightTimer) clearTimeout(_highlightTimer);
  _highlightTimer = setTimeout(() => {
    nextTick(() => {
      const match = getFirstMatchingTask(query);
      if (match) {
        treeSelectRef.value.pendingNodeKey = match.value;
      }
    });
  }, 150);
}

/*
|--------------------------------------------------------------------------
| MAIN
|--------------------------------------------------------------------------
*/

function onFormKeydown(e) {
  if (treeSelectOpen.value) return;
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;

  e.preventDefault();
  treeSelectOpen.value = true;
  nextTick(() => {
    const input = treeSelectRef.value?.$el?.querySelector('input');
    if (input) {
      input.focus();
      input.value = e.key;
      input.dispatchEvent(new Event('input', {bubbles: true}));
    }
  });
}

const lastSearchPattern = ref('');

watch(searchPattern, (val) => {
  if (val) lastSearchPattern.value = val;
  autoSelectTaskByExactId(val);
});

function autoSelectTaskByExactId(pattern) {
  if (!pattern) return;
  const normalized = normalize(pattern);
  if (!normalized) return;

  const flat = flattenTasks(filteredOptions.value);
  const match = flat.find(task =>
      normalize(task.id) === normalized || normalize(task.custom_id) === normalized
  );
  if (!match) return;

  formValue.value.task.taskId = match.value ?? match.id;
  treeSelectOpen.value = false;
  nextTick(() => {
    descriptionRef.value?.focus();
  });
}

watch(treeSelectOpen, (isOpen) => {
  if (!isOpen) return;
  if (!lastSearchPattern.value) return;
  nextTick(() => {
    const input = treeSelectRef.value?.$el?.querySelector('input');
    if (!input) return;
    input.value = lastSearchPattern.value;
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
});

watch(() => formValue.value.task.taskId, (val) => {
  if (val) lastSearchPattern.value = '';
});

// Fetch Clickup spaces on mount
onMounted(async () => {
  if (clickUpItems.value.length === 0) {
    await getClickUpHierarchy()
  }
})
</script>

/*
|--------------------------------------------------------------------------
| TEMPLATE
|--------------------------------------------------------------------------
*/

<template>
  <n-form
      ref="createForm"
      :model="formValue.task"
      :rules="rules.task"
      size="large"
      class="text-gray-800 dark:text-gray-200"
      @keydown="onFormKeydown"
  >
    <div class="mb-4">
      <n-h1 class="text-gray-900 dark:text-gray-100 !mb-0.5 flex items-center !text-xl">
        <clock-icon class="w-6 h-6 mr-2 text-blue-500"/>
        What are you working on?
      </n-h1>
      <p class="text-xs text-gray-400 dark:text-gray-500 ml-8">
        {{ props.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) }}
        &ndash;
        {{ props.end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) }}
      </p>
    </div>

    <div class="flex space-x-2 mb-1">
      <n-form-item path="taskId" class="flex-grow" :show-label="false" :show-feedback="false">
        <n-config-provider class="flex-grow" :theme-overrides="customTheme">
          <div @keyup.capture="onSearchKeyup" class="flex-grow">
          <n-tree-select
              ref="treeSelectRef"
              v-model:value="formValue.task.taskId"
              v-model:show="treeSelectOpen"
              v-model:expanded-keys="expandedKeys"
              :options="options"
              :disabled="loadingClickup && clickUpItems.length === 0"
              :placeholder="
                loadingClickup
                  ? 'Loading tasks...'
                  : 'Select a task or subtask'
              "
              :size="'large'"
              :clearable="true"
              :filterable="true"
              :filter="filter"
              :key-field="'value'"
              :disabled-field="'disable'"
              :render-prefix="renderSwitcherIcon"
              class="bg-white text-gray-800 dark:bg-gray-800 dark:text-gray-200"
          >
            <template #header>
              <div class="flex space-x-2">
                Include &nbsp;
                <div
                    class="rounded-2xl bg-gray-100 h-6 overflow-hidden flex text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 cursor-pointer p-1 text-xs flex justify-center border rounded-r-2xl px-2"
                    @click="withClosed = !withClosed"
                    :class="withClosed ? 'bg-green-200 dark:bg-green-400 dark:text-gray-900 border-green-600 hover:bg-green-300' : 'transparent border-transparent'"
                >
                  <n-icon class="flex items-center justify-center mr-1" name="arrow" size="14">
                    <document-check-icon />
                  </n-icon>
                  Closed
                </div>
                <div
                    class="rounded-2xl bg-gray-100 h-6 overflow-hidden flex text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 cursor-pointer p-1 text-xs flex justify-center border rounded-r-2xl px-2"
                    @click="withSubtasks = !withSubtasks"
                    :class="withSubtasks ? 'bg-green-200 dark:bg-green-400 dark:text-gray-900 border-green-600 hover:bg-green-300' : 'transparent border-transparent'"
                >
                  <n-icon class="flex items-center justify-center mr-1" name="arrow" size="14">
                    <arrow-turn-down-right-icon/>
                  </n-icon>
                  Subtasks
                </div>
              </div>
            </template>
            <template #empty>
              <task-search-fallback
                  :pattern="searchPattern"
                  @tasks-found="onTasksFoundFromFallback"
              />
            </template>
            <template #action>
              <div
                  v-if="searchPattern.length > 0"
                  class="flex items-center px-3 py-1 cursor-pointer text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-gray-700 transition-colors"
                  @mousedown.prevent.stop="openCreateTaskModal"
              >
                <n-icon class="mr-2" size="16">
                  <plus-icon />
                </n-icon>
                <span class="text-sm">
                  Create "<span class="font-medium">{{ searchPattern }}</span>"
                </span>
              </div>
            </template>
          </n-tree-select>
          </div>
        </n-config-provider>
      </n-form-item>

      <!-- Refresh button -->
      <n-button
          :disabled="loadingClickup"
          circle
          class="mt-0.5 bg-transparent text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
          secondary
          strong
          @click="refreshClickUpHierarchy"
      >
        <n-icon class="flex items-center justify-center" name="refresh" size="20">
          <div v-if="loadingClickup" class="w-2 h-2 bg-blue-800 rounded-full animate-ping"></div>
          <arrow-path-icon v-else/>
        </n-icon>
      </n-button>
    </div>

    <!-- Quick select: favorites & recents -->
    <div v-if="quickSelectTasks.length > 0" class="mt-3 mb-5">
      <p class="text-xs text-gray-400 dark:text-gray-500 mb-2">Pinned & recent tasks</p>
      <div class="flex flex-wrap gap-1.5">
        <n-tooltip
            v-for="task in quickSelectTasks"
            :key="task.taskId"
            :disabled="!task.tooltip"
            placement="bottom"
        >
          <template #trigger>
            <div
                class="group inline-flex items-center text-xs rounded-full border transition-colors duration-150 cursor-pointer"
                :class="[
                  task.isFavorite
                    ? 'bg-yellow-50 border-yellow-200 text-yellow-800 hover:bg-yellow-100 dark:bg-yellow-900/20 dark:border-yellow-700 dark:text-yellow-300 dark:hover:bg-yellow-900/40'
                    : 'bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700',
                  { 'ring-2 ring-blue-400 dark:ring-blue-500': formValue.task.taskId === task.taskId }
                ]"
            >
              <span class="truncate max-w-[200px] pl-3 py-1" @click="selectQuickTask(task)">
                {{ task.title }}<span v-if="task.showList && task.resolvedListName" class="ml-1 text-xs opacity-50">({{ task.resolvedListName }})</span>
              </span>

              <button
                  v-if="task.isFavorite"
                  class="ml-1 pr-2 py-1 text-yellow-600 hover:text-red-500 dark:text-yellow-400 dark:hover:text-red-400"
                  @click.stop="removeFavoriteTask(task.taskId)"
              >
                <x-mark-icon class="w-3.5 h-3.5"/>
              </button>

              <button
                  v-else
                  class="ml-1 pr-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-yellow-500 dark:hover:text-yellow-400"
                  @click.stop="addFavoriteTask(task)"
              >
                <star-icon-outline class="w-3.5 h-3.5"/>
              </button>
            </div>
          </template>
          {{ task.tooltip }}
        </n-tooltip>
      </div>
    </div>

    <!-- Description textbox -->
    <div class="flex space-x-2 mb-5">
      <n-form-item path="description" class="flex-grow" :show-label="false">
        <n-mention
            ref="descriptionRef"
            v-model:value="formValue.task.description"
            :options="mentionable"
            :render-label="renderMentionLabel"
            placeholder="Describe what you worked on"
            type="textarea"
            :disabled="loadingClickup && clickUpItems.length === 0"
            class="bg-white text-gray-800 dark:bg-gray-800 dark:text-gray-200"
        />
      </n-form-item>
    </div>

    <!-- Create and cancel buttons -->
    <div class="flex justify-end space-x-2">
      <n-button
          round
          :disabled="loadingCreate || loading"
          @click="cancelTaskCreation"
          class="bg-gray-200 text-gray-800 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
      >
        Cancel
      </n-button>
      <n-button
          round
          type="primary"
          :disabled="loadingCreate || loading"
          :loading="loadingCreate || loading"
          @click="createTask"
          class="bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800"
      >
        Create
      </n-button>
    </div>
  </n-form>

  <TaskCreatorForm
      ref="taskCreatorFormRef"
      v-model:show="showCreateTaskModal"
      :initial-name="searchPattern"
      :hierarchy="clickUpItems"
      @created="onTaskCreated"
  />
</template>


<style scoped>

</style>