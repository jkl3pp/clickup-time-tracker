<template>
  <!-- START | Drag handle -->
  <div class="h-6 bg-gray-200 dark:bg-gray-700" style="-webkit-app-region: drag"></div>
  <!-- END | Drag handle -->

  <div class="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200">
    <n-form ref="form" :model="model" :rules="rules" size="large">
      <n-form-item label="ClickUp Access token" path="clickup_access_token" placeholder="pk_">
        <n-input v-model:value="model.clickup_access_token" clearable class="dark:bg-gray-800 dark:text-gray-200" />
      </n-form-item>

      <n-form-item label="ClickUp Team ID" path="clickup_team_id">
        <n-input v-model:value="model.clickup_team_id" clearable class="dark:bg-gray-800 dark:text-gray-200" />
      </n-form-item>
      <div class="flex space-x-4">
        <n-form-item label="Day starts at" path="day_start" class="flex-grow">
          <n-select v-model:value="model.day_start" :options="hours" class="dark:bg-gray-800 dark:text-gray-200">
            <template #arrow>
              <ClockIcon class="w-4 dark:text-gray-300" />
            </template>
          </n-select>
        </n-form-item>

        <n-form-item label="Day ends at" path="day_end" class="flex-grow">
          <n-select v-model:value="model.day_end" :options="hours" class="dark:bg-gray-800 dark:text-gray-200">
            <template #arrow>
              <ClockIcon class="w-4 dark:text-gray-300" />
            </template>
          </n-select>
        </n-form-item>
      </div>

      <!-- START | Feature toggles -->
      <div class="relative p-4 bg-white dark:bg-gray-800 border dark:border-gray-700 rounded-lg shadow-sm">
        <label class="absolute px-1.5 bg-white dark:bg-gray-800 -left-0.5 -top-3">Optional features</label>

        <n-form-item :show-feedback="false" :show-label="false" path="show_weekend">
          <n-switch v-model:value="model.show_weekend" :default-value="true" />
          <label class="ml-3 text-gray-800 dark:text-gray-200">Show weekends</label>
        </n-form-item>

        <n-form-item :show-feedback="false" :show-label="false" path="admin_features_enabled">
          <n-switch v-model:value="model.admin_features_enabled" :default-value="false" />
          <label class="ml-3 text-gray-800 dark:text-gray-200">
            Enable admin features
            <div class="text-sm text-gray-500 dark:text-gray-400">You must be a CU admin to use this</div>
          </label>
        </n-form-item>

        <n-form-item :show-feedback="false" :show-label="false" path="enable_statistics">
          <n-switch v-model:value="model.enable_statistics" :default-value="false" />
          <label class="ml-3 text-gray-800 dark:text-gray-200">Enable Statistics view</label>
        </n-form-item>

        <n-form-item :show-feedback="false" :show-label="false" path="show_start_end_time">
          <n-switch v-model:value="model.show_start_end_time" :default-value="true" />
          <label class="ml-3 text-gray-800 dark:text-gray-200">
            Start and End time
            <div class="text-sm text-gray-500 dark:text-gray-400">Show Start and End time of time entries</div>
          </label>
        </n-form-item>

        <n-form-item :show-feedback="false" :show-label="false" path="show_duration">
          <n-switch v-model:value="model.show_duration" :default-value="true" />
          <label class="ml-3 text-gray-800 dark:text-gray-200">
            Duration
            <div class="text-sm text-gray-500 dark:text-gray-400">Show Duration of time entries</div>
          </label>
        </n-form-item>

        <n-form-item :show-feedback="false" :show-label="false" path="require_description">
          <n-switch v-model:value="model.require_description" :default-value="false" />
          <label class="ml-3 text-gray-800 dark:text-gray-200">
            Require descriptions
            <div class="text-sm text-gray-500 dark:text-gray-400">Leave task IDs empty to require for all tasks</div>
          </label>
        </n-form-item>
        <n-form-item :show-label="false" :show-feedback="false" path="internal_task_id" class="mt-1 ml-12">
          <n-input v-model:value="model.internal_task_id" :disabled="!model.require_description" placeholder="Task IDs, comma-separated (optional)" clearable class="dark:bg-gray-800 dark:text-gray-200" />
        </n-form-item>

        <hr class="my-6 dark:border-gray-700" />
        <!-- START | Hierarchy Selection -->
        <label class="absolute px-1.5 bg-white dark:bg-gray-800 -ml-4 -mt-9">Hierarchy Selection</label>

        <n-form-item :show-feedback="false" :show-label="false" path="hierarchy_filter.enabled">
          <n-switch v-model:value="model.hierarchy_filter.enabled" @update:value="onHierarchyFilterToggle" />
          <label class="ml-3 text-gray-800 dark:text-gray-200">
            Enable hierarchy filtering
            <div class="text-sm text-gray-500 dark:text-gray-400">
              Only fetch selected items (improves performance)
            </div>
          </label>
        </n-form-item>

        <div v-if="model.hierarchy_filter && model.hierarchy_filter.enabled" class="mt-4">
          <div class="flex gap-2 mb-4">
            <n-button @click="loadHierarchyForSelection(hierarchyLoaded)" :loading="loadingHierarchy" secondary>
              <template #icon>
                <arrow-path-icon class="w-4" />
              </template>
              {{ hierarchyLoaded ? 'Refresh' : 'Load' }} Hierarchy
            </n-button>

            <n-button v-if="hierarchyLoaded" @click="selectAllHierarchy" secondary type="success">
              Select All
            </n-button>

            <n-button v-if="hierarchyLoaded" @click="deselectAllHierarchy" secondary type="warning">
              Deselect All
            </n-button>
          </div>

          <n-form-item v-if="hierarchyLoaded" label="Select items to track" path="hierarchy_filter.selection">
            <n-tree-select v-model:value="selectedHierarchyKeys" :options="hierarchyTreeOptions" :checkable="true"
              :cascade="true" :check-strategy="'parent'" :show-path="true" :multiple="true" :default-expand-all="false"
              :filterable="true" :render-prefix="renderHierarchyIcon" placeholder="Select lists to track..."
              class="w-full dark:bg-gray-800 dark:text-gray-200" />
          </n-form-item>

          <div v-if="hierarchyLoaded && selectedHierarchyKeys.length === 0"
            class="text-yellow-600 dark:text-yellow-400 text-sm">
            ⚠️ No items selected - no tasks will be available
          </div>
        </div>

        <hr class="my-6 dark:border-gray-700" />
        <!-- END | Hierarchy Selection -->

        <!-- START | Search Shortcuts -->
        <label class="absolute px-1.5 bg-white dark:bg-gray-800 -ml-4 -mt-9">Search Shortcuts</label>

        <div v-if="!hierarchyLoaded" class="mb-4 flex items-center gap-2">
          <n-button @click="loadHierarchyForSelection(hierarchyLoaded)" :loading="loadingHierarchy" secondary
            size="small">
            <template #icon><arrow-path-icon class="w-4" /></template>
            Load hierarchy
          </n-button>
          <span class="text-sm text-gray-500 dark:text-gray-400">Required to configure shortcuts</span>
        </div>

        <n-form-item :show-label="false" :show-feedback="false" path="search_shortcuts">
          <n-dynamic-input v-model:value="model.search_shortcuts" :on-create="onAddShortcut" :min="0" :max="10">
            <template #create-button-default>
              Add a shortcut
            </template>
            <template #default="{ value }">
              <div style="display: flex; align-items: center; width: 100%; gap: 8px">
                <n-input v-model:value="value.keyword" placeholder="Keyword" type="text"
                  class="dark:bg-gray-800 dark:text-gray-200" style="width: 120px; flex-shrink: 0" />
                <n-tree-select v-model:value="value.selectedKeys" :options="hierarchyTreeOptions" :checkable="true"
                  :cascade="true" :check-strategy="'parent'" :multiple="true" :filterable="true"
                  :render-prefix="renderHierarchyIcon" :disabled="!hierarchyLoaded"
                  placeholder="Select spaces, folders or lists..."
                  class="dark:bg-gray-800 dark:text-gray-200" style="flex: 1" />
              </div>
            </template>
          </n-dynamic-input>
        </n-form-item>
        <hr class="my-6 dark:border-gray-700" />
        <!-- END | Search Shortcuts -->

        <!-- START | Theme -->
        <label class="absolute px-1.5 bg-white dark:bg-gray-800 -ml-4 -mt-9">Theme</label>

        <n-form-item :show-feedback="false" :show-label="false" path="theme_mode">
          <n-radio-group v-model:value="model.theme_mode" name="theme_mode">
            <n-radio-button value="light">Light</n-radio-button>
            <n-radio-button value="dark">Dark</n-radio-button>
            <n-radio-button value="system">System</n-radio-button>
          </n-radio-group>
        </n-form-item>

        <hr class="my-6 dark:border-gray-700" />
        <!-- END | Theme -->
        <!-- END | Feature toggles -->

        <!-- START | Styling -->
        <label class="absolute px-1.5 bg-white dark:bg-gray-800 -ml-4 -mt-9">Style</label>

        <n-form-item label="Background image url (optional)" path="background_image_url">
          <n-input v-model:value="model.background_image_url" clearable class="dark:bg-gray-800 dark:text-gray-200" />
        </n-form-item>

        <label class="text-gray-800 dark:text-gray-200">Color of tracking entries</label>
        <div class="grid grid-cols-2 gap-4 w-full">
          <n-form-item :show-feedback="false" :show-label="false" path="custom_color_enabled">
            <n-switch v-model:value="model.custom_color_enabled" @update:value="setDefaultColor" />
            <label class="ml-3 text-gray-800 dark:text-gray-200">Enable custom color</label>
          </n-form-item>

          <n-form-item :show-label="false" :show-feedback="false" class="w-full" path="color">
            <n-color-picker v-model:value="model.color" :disabled="!(model.custom_color_enabled)" :modes="['hex']"
              class="w-full" />
          </n-form-item>
        </div>

        <hr class="my-6 dark:border-gray-700" />
        <!-- END | Styling -->

        <!-- START | Goals -->
        <label class="absolute px-1.5 bg-white dark:bg-gray-800 -ml-4 -mt-9">Goals</label>
        <n-form-item :show-feedback="false" :show-label="false" path="enable_goals">
          <n-switch v-model:value="model.enable_goals" :default-value="true" :disabled="!model.enable_statistics"
            @update:value="val => { if (val) model.enable_statistics = true }" />
          <label class="ml-3 text-gray-800 dark:text-gray-200">Show goals in statistics</label>
        </n-form-item>
        <n-form-item :show-label="false" :show-feedback="false" path="goals">
          <n-dynamic-input v-model:value="model.goals" :on-create="onAddGoal" :disabled="!model.enable_statistics"
            :min="0" :max="4">
            <template #create-button-default>
              Add a goal
            </template>
            <template #default="{ value }">
              <div style="display: flex; align-items: center; width: 100%">
                <n-select v-model:value="value.type" :options="clickUpTypeOptions" :render-label="renderDropDownIcon"
                  class="mr-2.5 dark:bg-gray-800 dark:text-gray-200" style="width: 200px" placeholder="Type" />
                <n-input v-model:value="value.clickUpId" placeholder="ClickUp Id" type="text"
                  class="mr-2.5 dark:bg-gray-800 dark:text-gray-200" />
                <n-input-number v-model:value="value.goal" :min="0" :max="168" style="width: 175px" />
              </div>
            </template>
          </n-dynamic-input>
        </n-form-item>
        <hr class="my-6 dark:border-gray-700" />
        <!-- END | Goals -->

        <!-- START | Danger zone -->
        <label class="absolute px-1.5 bg-white dark:bg-gray-800 -ml-4 -mt-9">Danger zone</label>
        <n-popconfirm :show-icon="false" @positive-click="flushCaches">
          <template #activator>
            <n-button secondary size="small" type="warning" class="bg-yellow-500 dark:bg-yellow-700">
              Flush caches
            </n-button>
          </template>
          This will clear all locally cached<br />
          ClickUp tasks & team members
        </n-popconfirm>
        <!-- END | Danger zone -->
      </div>

      <div class="flex justify-end mt-4 space-x-2">
        <n-button round @click="cancel" class="bg-gray-200 dark:bg-gray-700 dark:text-gray-200">
          Cancel
        </n-button>
        <n-button round type="primary" @click="persist" class="bg-blue-600 dark:bg-blue-800">
          Save
        </n-button>
      </div>
    </n-form>

    <div class="flex flex-col p-3 space-y-4 shadow-inner bg-gray-50 dark:bg-gray-900 text-gray-800 dark:text-gray-200">
      <h2 class="text-xl font-bold text-gray-700 dark:text-gray-200">Instructions</h2>
      <p>Click & drag in order to create a new tracking entry</p>

      <h3 class="text-lg font-bold text-gray-700 dark:text-gray-200">Styling</h3>
      <p>It is possible to give all tracking entries the same color...</p>

      <h3 class="text-lg font-bold text-gray-700 dark:text-gray-200">Goals</h3>
      <p>When statistics are enabled...</p>

      <h2 class="text-lg font-bold text-gray-700 dark:text-gray-200">Keybindings</h2>

      <div class="flex">
        <kbd
          class="inline-flex items-center px-2 mr-2 font-sans text-sm font-medium text-gray-400 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded">
          ⌘ + D
        </kbd>
        Duplicate the selected entry
      </div>
      <div class="flex">
        <kbd
          class="inline-flex items-center px-2 mr-2 font-sans text-sm font-medium text-gray-400 border border-gray-300 rounded dark:text-gray-300 dark:border-gray-600">
          ⌘ +
          <backspace-icon class="w-4 ml-1 dark:text-gray-300" />
        </kbd>
        <span class="text-gray-800 dark:text-gray-200">Delete the selected entry</span>
      </div>

      <div class="flex">
        <kbd
          class="inline-flex items-center px-2 mr-2 font-sans text-sm font-medium text-gray-400 border border-gray-300 rounded dark:text-gray-300 dark:border-gray-600">
          ⌘ + X
        </kbd>
        <span class="text-gray-800 dark:text-gray-200">Refresh background image cache</span>
      </div>

      <div class="flex">
        <kbd
          class="inline-flex items-center px-2 mr-2 font-sans text-sm font-medium text-gray-400 border border-gray-300 rounded dark:text-gray-300 dark:border-gray-600">
          ⌘ + R
        </kbd>
        <span class="text-gray-800 dark:text-gray-200">Refresh the current screen (for troubleshooting)</span>
      </div>

      <div class="flex">
        <kbd
          class="inline-flex items-center px-2 mr-2 font-sans text-sm font-medium text-gray-400 border border-gray-300 rounded dark:text-gray-300 dark:border-gray-600">
          ⌘ + V
        </kbd>
        <span class="text-gray-800 dark:text-gray-200">alias for</span>
        <kbd
          class="inline-flex items-center px-2 ml-2 font-sans text-sm font-medium text-gray-400 border border-gray-300 rounded dark:text-gray-300 dark:border-gray-600">
          ⌘ + D
        </kbd>
      </div>
    </div>
  </div>
</template>

<script>
import { h, ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import {
  NForm,
  NFormItem,
  NInput,
  NSelect,
  NSwitch,
  NButton,
  NPopconfirm,
  NColorPicker,
  useNotification,
  NDynamicInput,
  NInputNumber,
  NIcon,
  NTreeSelect,
  NRadioGroup,
  NRadioButton,
} from "naive-ui";
import { BackspaceIcon, ClockIcon, ArrowPathIcon } from "@heroicons/vue/24/outline";
import { ipcRenderer } from 'electron';
import clickupService from '@/clickup-service';
import store from "@/store";
import cache from "@/cache";
import { ClickUpType } from "@/model/ClickUpModels";

import { Planet, List, Folder } from '@vicons/ionicons5'
import { CircleFilled } from "@vicons/carbon";

export default {
  components: {
    NForm,
    NFormItem,
    NInput,
    NSelect,
    NSwitch,
    NButton,
    NPopconfirm,
    BackspaceIcon,
    ClockIcon,
    ArrowPathIcon,
    NColorPicker,
    NDynamicInput,
    NInputNumber,
    NTreeSelect,
    NRadioGroup,
    NRadioButton,
  },

  setup() {
    const form = ref(null);
    const router = useRouter();
    const notification = useNotification();
    const model = ref(store.get("settings") || {});
    const hours = ref(Array.from(Array(25).keys()).map((i) => ({ label: `${i}:00`, value: i })));
    let custom_color = ref(false);

    if (!model.value.theme_mode) {
      model.value.theme_mode = 'system';
    }

    // Initialize hierarchy_filter if not exists
    if (!model.value.hierarchy_filter) {
      model.value.hierarchy_filter = {
        enabled: false,
        version: 1,
        selection: {
          spaces: {}
        }
      };
    }

    // Hierarchy selection refs
    const hierarchyLoaded = ref(false);
    const loadingHierarchy = ref(false);
    const hierarchyTreeOptions = ref([]);
    const selectedHierarchyKeys = ref([]);

    const clickUpTypeOptions = [
      {
        label: 'Space',
        value: ClickUpType.SPACE,
        icon: Planet,
      },
      {
        label: 'Folder',
        value: ClickUpType.FOLDER,
        icon: Folder,
      },
      {
        label: 'List',
        value: ClickUpType.LIST,
        icon: List,
      },
      {
        label: 'Task',
        value: ClickUpType.TASK,
        icon: CircleFilled,
      },
    ];

    // Hierarchy selection functions
    function onHierarchyFilterToggle(enabled) {
      if (!enabled) {
        // Clear selection when disabling
        hierarchyLoaded.value = false;
        hierarchyTreeOptions.value = [];
        selectedHierarchyKeys.value = [];
      }
    }

    async function loadHierarchyForSelection(forceRefresh = false) {
      // Delay showing loading indicator to avoid flash for cached data
      const loadingTimeout = setTimeout(() => {
        loadingHierarchy.value = true;
      }, 200); // Only show loading if it takes more than 200ms

      try {
        const hierarchy = await new Promise((resolve, reject) => {
          // Use refresh handler if forceRefresh is true (clears cache)
          const eventName = forceRefresh ? "refresh-clickup-hierarchy-metadata" : "get-clickup-hierarchy-metadata";
          ipcRenderer.removeAllListeners("set-clickup-hierarchy-metadata");
          ipcRenderer.removeAllListeners("fetch-clickup-hierarchy-metadata-error");
          ipcRenderer.send(eventName);
          ipcRenderer.once("set-clickup-hierarchy-metadata", (event, data) => {
            resolve(data);
          });
          ipcRenderer.once("fetch-clickup-hierarchy-metadata-error", (event, error) => {
            reject(error);
          });
        });

        // Clear the timeout if we got data quickly (from cache)
        clearTimeout(loadingTimeout);

        // Transform to NTreeSelect format
        hierarchyTreeOptions.value = transformToTreeSelectFormat(hierarchy);

        // Load existing selection if any
        if (model.value.hierarchy_filter?.selection) {
          selectedHierarchyKeys.value = extractSelectedKeys(model.value.hierarchy_filter.selection);
        }

        hierarchyLoaded.value = true;
        notification.success({ title: "Hierarchy loaded!", duration: 1500 });
      } catch (error) {
        clearTimeout(loadingTimeout); // Clear timeout on error too
        console.error(error);
        // Disarm the previously loaded tree: it may be stale or truncated, and
        // persist() rebuilds the selection from whatever tree is displayed
        hierarchyLoaded.value = false;
        notification.error({
          title: "Failed to load hierarchy",
          content: "Please check your connection and try again"
        });
      } finally {
        loadingHierarchy.value = false;
      }
    }

    function renderHierarchyIcon(option) {
      let icon;
      const color = option.option.color || '#gray';

      switch (option.option.type) {
        case 'space':
          icon = Planet;
          break;
        case 'folder':
          icon = Folder;
          break;
        case 'list':
          icon = List;
          break;
        default:
          icon = List;
      }

      return h(NIcon, { size: '15px', color: color }, { default: () => h(icon) });
    }

    function selectAllHierarchy() {
      // Recursively collect all list IDs from the tree
      const collectAllListIds = (nodes) => {
        const ids = [];
        if (!nodes) return ids;

        nodes.forEach(node => {
          // Add this node's key (spaces, folders, lists all have keys)
          ids.push(node.key);

          // Recursively collect from children
          if (node.children) {
            ids.push(...collectAllListIds(node.children));
          }
        });

        return ids;
      };

      selectedHierarchyKeys.value = collectAllListIds(hierarchyTreeOptions.value);
    }

    function deselectAllHierarchy() {
      selectedHierarchyKeys.value = [];
    }

    // Helper functions for hierarchy tree transformation
    function transformToTreeSelectFormat(hierarchy) {
      if (!hierarchy || !Array.isArray(hierarchy)) return [];
      return hierarchy.map(space => ({
        key: space.id,
        label: space.name,
        type: space.type,
        color: space.color,
        disabled: false,
        children: transformChildren(space.children || [])
      }));
    }

    function transformChildren(items) {
      if (!items || !Array.isArray(items)) return undefined;
      const children = items.map(item => ({
        key: item.id,
        label: item.name,
        type: item.type,
        color: item.color,
        disabled: false,
        children: item.children ? transformChildren(item.children) : undefined
      }));
      return children.length > 0 ? children : undefined;
    }

    function extractSelectedKeys(selection) {
      const keys = [];
      if (!selection || !selection.spaces) return keys;

      Object.values(selection.spaces).forEach(space => {
        // If space has selectAll flags set, add the space key itself (parent selection)
        if (space.selectAllFolders || space.selectAllLists) {
          keys.push(space.id);
        } else {
          // Otherwise, check folders and lists individually

          // Check folders
          if (space.folders) {
            Object.values(space.folders).forEach(folder => {
              // If folder has selectAllLists, add the folder key (parent selection)
              if (folder.selectAllLists) {
                keys.push(folder.id);
              } else {
                // Otherwise, add individual list keys
                if (folder.lists) {
                  Object.values(folder.lists).forEach(list => {
                    if (list.selected) keys.push(list.id);
                  });
                }
              }
            });
          }

          // Check space-level lists
          if (space.lists) {
            Object.values(space.lists).forEach(list => {
              if (list.selected) keys.push(list.id);
            });
          }
        }
      });

      return keys;
    }

    function buildSelectionStructure(selectedKeys, treeOptions) {
      const selection = { spaces: {} };
      const keySet = new Set(selectedKeys);

      treeOptions.forEach(space => {
        // Check if this space key itself is in the selection (parent selected)
        const spaceKeySelected = keySet.has(space.key);

        const spaceData = {
          id: space.key,
          name: space.label,
          selected: true,
          selectAllFolders: false,
          selectAllLists: false,
          folders: {},
          lists: {}
        };

        if (space.children) {
          const folders = space.children.filter(c => c.type === 'folder');
          const spaceLists = space.children.filter(c => c.type === 'list');

          // Check if any child keys are selected
          const hasChildKeysSelected = selectedKeys.some(key =>
            key !== space.key &&
            space.children.some(child => child.key === key ||
              (child.children && child.children.some(grandchild => grandchild.key === key))
            )
          );

          // If space key is selected but no children keys → select all children
          if (spaceKeySelected && !hasChildKeysSelected) {
            spaceData.selectAllFolders = true;
            spaceData.selectAllLists = true;
          } else {
            // Process folders
            if (folders.length > 0) {
              let allFoldersSelected = true;

              folders.forEach(folder => {
                const folderKeySelected = keySet.has(folder.key);
                const folderLists = folder.children || [];
                const selectedListsInFolder = folderLists.filter(list => keySet.has(list.key));

                // If folder key is selected but no list keys → select all lists
                if (folderKeySelected && selectedListsInFolder.length === 0) {
                  spaceData.folders[folder.key] = {
                    id: folder.key,
                    name: folder.label,
                    selected: true,
                    selectAllLists: true,
                    lists: {}
                  };
                } else if (selectedListsInFolder.length > 0) {
                  spaceData.folders[folder.key] = {
                    id: folder.key,
                    name: folder.label,
                    selected: true,
                    selectAllLists: selectedListsInFolder.length === folderLists.length,
                    lists: {}
                  };

                  selectedListsInFolder.forEach(list => {
                    spaceData.folders[folder.key].lists[list.key] = {
                      id: list.key,
                      name: list.label,
                      selected: true
                    };
                  });
                } else {
                  allFoldersSelected = false;
                }
              });

              // Check if all folders are selected
              spaceData.selectAllFolders = Object.keys(spaceData.folders).length === folders.length && allFoldersSelected;
            }

            // Process space-level lists
            if (spaceLists.length > 0) {
              const selectedSpaceLists = spaceLists.filter(list => keySet.has(list.key));

              selectedSpaceLists.forEach(list => {
                spaceData.lists[list.key] = {
                  id: list.key,
                  name: list.label,
                  selected: true
                };
              });

              // Check if all space-level lists are selected
              if (selectedSpaceLists.length === spaceLists.length && folders.length === 0) {
                spaceData.selectAllLists = true;
              }
            }
          }
        }

        selection.spaces[space.key] = spaceData;
      });

      return selection;
    }

    function mustFlushCachesAfterPersist() {
      const oldFilter = store.get('settings.hierarchy_filter');
      const newFilter = model.value.hierarchy_filter;

      // Either the CU access token or team id has changed
      const credentialsChanged = model.value.clickup_access_token !== store.get('settings.clickup_access_token')
        || model.value.clickup_team_id !== store.get('settings.clickup_team_id');

      // Hierarchy filter changed
      const filterChanged = JSON.stringify(oldFilter) !== JSON.stringify(newFilter);

      return credentialsChanged || filterChanged;
    }

    // Auto-load hierarchy on mount if filtering is enabled and has selection
    onMounted(() => {
      if (model.value.hierarchy_filter?.enabled) {
        const hasSelection = model.value.hierarchy_filter.selection?.spaces &&
          Object.keys(model.value.hierarchy_filter.selection.spaces).length > 0;

        // Only load if we don't already have the hierarchy data
        if (hasSelection && hierarchyTreeOptions.value.length === 0) {
          // Auto-load hierarchy to show current selection
          loadHierarchyForSelection();
        } else if (hasSelection && hierarchyTreeOptions.value.length > 0) {
          // We already have the data, just mark as loaded
          hierarchyLoaded.value = true;
        }
      }
    });

    return {
      form,
      model,
      hours,
      custom_color,
      clickUpTypeOptions,
      // Hierarchy selection
      hierarchyLoaded,
      loadingHierarchy,
      hierarchyTreeOptions,
      selectedHierarchyKeys,
      onHierarchyFilterToggle,
      loadHierarchyForSelection,
      renderHierarchyIcon,
      selectAllHierarchy,
      deselectAllHierarchy,
      renderDropDownIcon: (option) => {
        return [
          h('div', { style: 'display: flex; align-items: center;' }, [
            h(NIcon, { size: '15px', id: 'cascader-icon' }, { default: () => h(option.icon) }),
            h('span', { style: 'margin-left: 8px;' }, option.label)
          ])
        ]
      },

      persist() {
        form.value
          .validate()
          .then(() => {
            // Convert selectedHierarchyKeys back to nested structure.
            // Requires a loaded, non-empty tree — rebuilding from an empty or
            // failed tree would silently drop the stored selection.
            if (model.value.hierarchy_filter?.enabled && hierarchyLoaded.value && hierarchyTreeOptions.value.length > 0) {
              model.value.hierarchy_filter.selection = buildSelectionStructure(
                selectedHierarchyKeys.value,
                hierarchyTreeOptions.value
              );
            }

            if (mustFlushCachesAfterPersist()) {
              cache.flush();
            }

            store.set({ settings: model.value });

            router.replace({ name: "time-tracker" });

            notification.success({ title: "Settings saved!", duration: 1500 });
          })
          .catch((errors) => console.error(errors));
      },

      cancel() {
        router.replace({ name: "time-tracker" });
      },

      flushCaches() {
        cache.flush()

        notification.success({ title: "All caches flushed!", duration: 1500 });
      },

      setDefaultColor(event) {
        if (!event) {
          model.value.color = "#ADD8E67F";
        }
      },

      onAddGoal() {
        return {
          type: undefined,
          clickUpId: undefined,
          goal: 0
        }
      },

      onAddShortcut() {
        return {
          keyword: '',
          selectedKeys: [],
        }
      },


      rules: {
        clickup_access_token: [
          {
            required: true,
            min: 43,
            message: "Please input your ClickUp Access Token",
            trigger: ["input", "blur"],
          },
          {
            required: true,
            validator: (rule, value) => clickupService.tokenValid(value),
            message: "This token couldn't be validated with ClickUp. Please verify.",
            trigger: ['blur']
          }
        ],
        clickup_team_id: [
          {
            required: true,
            min: 1,
            message: "Please input your ClickUp Team ID",
            trigger: ["input", "blur"],
          },
          // TODO: Add async validity checker
        ],
        day_start: [
          {
            required: true,
            validator(rule, value) {
              if (Number(value) >= Number(model.value.day_end)) {
                return new Error("Must be less than the end of day");
              }
              return true;
            },
            trigger: ["input", "blur"],
          },
        ],
        day_end: [
          {
            required: true,
            validator(rule, value) {
              if (Number(value) <= Number(model.value.day_start)) {
                return new Error("Must be more than the start of day");
              }
              return true;
            },
            trigger: ["input", "blur"],
          },
        ]
      },
    };
  },
};
</script>
