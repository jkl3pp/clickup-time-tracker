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
  NTreeSelect,
  useNotification,
} from "naive-ui";
import {ArrowPathIcon, ArrowTurnDownRightIcon} from "@heroicons/vue/20/solid";
import {DocumentCheckIcon} from "@heroicons/vue/24/outline";
import {Folder, List, Planet} from '@vicons/ionicons5'
import {CircleFilled} from "@vicons/carbon";
import {computed, defineEmits, h, nextTick, onMounted, ref} from "vue";
import {ipcRenderer} from 'electron';
import clickupService from "@/clickup-service";
import store from "@/store";
import removeAccents from 'remove-accents';
import {cloneDeep} from "lodash";


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

let createForm = ref(null);

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
        if (!withSubtasks && item.type === 'subtask') {
          return false;
        }

        // Exclude closed items if not allowed
        if(!withClosed && item.date_closed !== null) {
          return false;
        }

        return true;
      });
};



const options = computed(() => {
  return filterRecursive(cloneDeep(clickUpItems.value), withClosed.value, withSubtasks.value)
})

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

function buildAncestorIds(items, ancestorIds = []) {
  for (const item of items) {
    const childAncestorIds = [...ancestorIds, item.id]
    if (item.type === 'task' || item.type === 'subtask') {
      item.ancestorIds = ancestorIds
    }
    // Pre-compute normalized search fields to avoid per-keystroke removeAccents() calls
    item._searchFields = [item.label, item.name, item.custom_id, item.id, item.value]
        .filter(Boolean)
        .map(v => normalize(String(v)))
    if (item.children && item.children.length > 0) {
      buildAncestorIds(item.children, childAncestorIds)
    }
  }
}

// Cached per-query shortcut lookup — computed once per query string, not per option
let _lastQuery = null;
let _lastShortcut = null;

function resolveShortcut(q) {
  if (q === _lastQuery) return _lastShortcut;
  const shortcuts = store.get('settings.search_shortcuts') || [];
  const firstWord = q.split(/\s+/)[0];
  _lastShortcut = shortcuts.find(sc => normalize(sc.keyword || '') === firstWord) || null;
  _lastQuery = q;
  return _lastShortcut;
}

function filter(query, option) {
  const q = normalize(query);

  // Check if query starts with a configured shortcut keyword
  if (option && option.ancestorIds !== undefined) {
    const matchedShortcut = resolveShortcut(q);

    if (matchedShortcut) {
      const ids = matchedShortcut.selectedKeys || [];
      if (ids.length > 0 && !ids.some(id => option.ancestorIds.includes(id))) return false;
      const remainingQuery = q.split(/\s+/).slice(1).join(' ').trim();
      if (!remainingQuery) return true;
      return originalFilter(remainingQuery, option);
    }
  }

  return originalFilter(q, option);
}

function originalFilter(q, option) {
  if (option && option._searchFields) {
    return option._searchFields.some(f => f.includes(q));
  }
  // Fallback for nodes without pre-computed fields
  const fields = [];
  if (option && option.label) fields.push(option.label);
  if (option && option.name) fields.push(option.name);
  if (option && option.custom_id) fields.push(String(option.custom_id));
  if (option && option.id) fields.push(String(option.id));
  if (option && option.value) fields.push(String(option.value));
  return fields.some(v => normalize(v).includes(q));
}

function normalize(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return removeAccents(s.toLowerCase()).trim();
}

// Auto-highlight first matching task in dropdown as the user types
const treeSelectRef = ref(null);
const _navKeys = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab', 'Shift', 'Control', 'Alt', 'Meta']);

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

let _highlightTimer = null;

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

// Fetch Clickup spaces on mount
onMounted(async () => {
  // Only fetch if we don't already have data
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
      class="text-gray-800 dark:text-gray-200 p-4 rounded-md"
  >
    <n-h1 class="text-gray-900 dark:text-gray-100 mb-4">What are you working on?</n-h1>

    <div class="flex space-x-2 mb-4">
      <n-form-item path="taskId" class="flex-grow" :show-label="false">
        <n-config-provider class="flex-grow" :theme-overrides="customTheme">
          <div @keyup.capture="onSearchKeyup" class="flex-grow">
          <n-tree-select
              ref="treeSelectRef"
              v-model:value="formValue.task.taskId"
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
              class="bg-white text-gray-800 dark:bg-gray-800 dark:text-gray-200 border dark:border-gray-700"
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

    <!-- Description textbox -->
    <div class="flex space-x-2 mb-4">
      <n-form-item path="description" class="flex-grow" :show-label="false">
        <n-mention
            v-model:value="formValue.task.description"
            :options="mentionable"
            :render-label="renderMentionLabel"
            placeholder="Describe what you worked on"
            type="textarea"
            :disabled="loadingClickup && clickUpItems.length === 0"
            class="bg-white text-gray-800 dark:bg-gray-800 dark:text-gray-200 border dark:border-gray-700"
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
</template>


<style scoped>

</style>

