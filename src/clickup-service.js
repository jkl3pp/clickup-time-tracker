import request from 'request';
import store from '@/store';
import cache from '@/cache';
import {ClickUpItemFactory} from "@/model/ClickUpModels";

const BASE_URL = 'https://api.clickup.com/api/v2';

// Concurrency limiter — caps parallel ClickUp API requests to avoid hitting rate limits
const MAX_CONCURRENT = 8;
let _activeRequests = 0;
const _requestQueue = [];

function _acquireSlot() {
    return new Promise(resolve => {
        if (_activeRequests < MAX_CONCURRENT) { _activeRequests++; resolve(); }
        else _requestQueue.push(resolve);
    });
}

function _releaseSlot() {
    _activeRequests--;
    if (_requestQueue.length > 0) { _activeRequests++; _requestQueue.shift()(); }
}

async function throttledRequest(options) {
    await _acquireSlot();
    try {
        const response = await new Promise((resolve, reject) => {
            request(options, (error, response) => {
                if (error) reject(error);
                else resolve(response);
            });
        });
        if (response.statusCode === 429) {
            const retryAfter = parseInt(response.headers['retry-after'] || '5', 10);
            console.warn(`ClickUp rate limit hit, retrying in ${retryAfter}s`);
            await new Promise(r => setTimeout(r, retryAfter * 1000));
            return throttledRequest(options);
        }
        return response;
    } finally {
        _releaseSlot();
    }
}

// Cache keys
export const HIERARCHY_CACHE_KEY = 'hierarchy';
export const HIERARCHY_METADATA_CACHE_KEY = 'hierarchy_metadata';
const USERS_CACHE_KEY = 'users';

// Timeout and pagination constants
const DEFAULT_CLICKUP_TIMEOUT = 30000; // 30 seconds
const CLICKUP_TASKS_PER_PAGE = 100; // ClickUp API pagination limit

// Cache duration
const CACHE_DEFAULT = 24 * 7 * 60 * 60; // 7 days in seconds

// Factory
// The factory is used to create the correct model objects from the API response.
// But, sometimes you don't want to create a model object, but just the api dump. So maybe an idea for future
// refactoring, would to turn the factory optioinal based on a parameter. But for now, this works.
const factory = new ClickUpItemFactory();

function teamRootUrl() {
    return `${BASE_URL}/team/${store.get('settings.clickup_team_id')}`
}

export default {
    requests: 0,


    /*
     * Checks if the given token is valid by making a request to the user endpoint.
     */
    tokenValid(token) {
        return new Promise((resolve, reject) => {
            request({
                method: 'GET',
                mode: 'no-cors',
                url: BASE_URL + '/user',
                headers: {
                    'Authorization': token,
                    'Content-Type': 'application/json'
                }
            }, (error, response) => {
                if (error) return reject(error)

                const user = JSON.parse(response.body).user

                if (!user) reject('Invalid response')

                resolve(true)
            });
        })
    },

    // Timeout and retry wrapper function
    async withTimeoutAndRetry(fn, timeout = 120000, retries = 5, retryDelay = 1000) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await Promise.race([
                    fn(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
                    )
                ]);
            } catch (error) {
                console.error(`Attempt ${attempt} failed: ${error.message}`);
                if (attempt === retries) {
                    console.error(`Max retries reached for ${fn.name}`);
                    return []; // Return an empty result after max retries
                }
                await new Promise(resolve => setTimeout(resolve, retryDelay * attempt)); // Optional delay before retry
            }
        }
    },

    /*
     * Builds a hierarchy of spaces, folders, lists, tasks and subtasks, from a team.
     * Can be used to display the treeview options.
     * Supports filtering based on hierarchy_filter settings.
     */
    async getHierarchy() {
        this.requests = 0;
        const hierarchyFilter = store.get('settings.hierarchy_filter');

        // If filtering disabled or not configured, fetch everything (existing behavior)
        if (!hierarchyFilter || !hierarchyFilter.enabled || !hierarchyFilter.selection) {
            return this._getFullHierarchy();
        }

        // Check if selection is empty
        const hasSelection = hierarchyFilter.selection.spaces &&
            Object.keys(hierarchyFilter.selection.spaces).length > 0;

        if (!hasSelection) {
            console.warn("Hierarchy filter enabled but no selection configured, fetching nothing");
            return [];
        }

        // Use filtered approach
        return this._getFilteredHierarchy(hierarchyFilter.selection);
    },

    async getCachedHierarchy() {
        try {
            const cached = cache.get(HIERARCHY_CACHE_KEY)

            if (cached) {
                console.log("Got hierarchy from cache")
                return cached
            }

            let hierarchy = await this.getHierarchy().catch(e => {
                console.error(e)
            })
            return cache.put(
                HIERARCHY_CACHE_KEY,
                hierarchy,
                CACHE_DEFAULT
            )
        } catch (e) {
            console.error(e)
        }
    },

    // Clears both hierarchy and metadata caches
    // Use this when settings change (team ID, access token, hierarchy filter)
    // Individual refresh operations should clear their specific cache only
    clearCachedHierarchy() {
        cache.clear(HIERARCHY_CACHE_KEY)
        cache.clear(HIERARCHY_METADATA_CACHE_KEY)
    },

    /*
     * Internal: Fetches complete hierarchy (all spaces/folders/lists/tasks)
     * This is the original getHierarchy() logic for backwards compatibility
     */
    async _getFullHierarchy() {
        console.log("Getting FULL hierarchy from ClickUp");
        const spaces = await this.getSpaces().catch(e => {
            console.error(e);
        });

        try {
            console.log(`Got ${spaces.length} spaces from ClickUp (${this.requests} rq)`);
            if (spaces.length > 0) {
                await Promise.all(spaces.map(async (space) => {
                    console.log(`Getting folders and lists for space ${space.name} (${this.requests} rq)`);

                    // Fetch folders with retry and timeout logic
                    const folders = await this.withTimeoutAndRetry(() => this.getFolders(space.id)).catch(e => {
                        console.error(e);
                        return [];
                    });
                    console.log(`Got ${folders.length} folders for space ${space.name} (${this.requests} rq)`);

                    if (folders.length > 0) {
                        await Promise.all(folders.map(async (folder) => {
                            const folderLists = await this.withTimeoutAndRetry(() => this.getFolderedLists(folder.id)).catch(e => {
                                console.error(e);
                                return [];
                            });
                            console.log(`Got ${folderLists.length} lists for folder ${folder.name} (space ${space.name}) (${this.requests} rq)`);

                            if (folderLists.length > 0) {
                                await Promise.all(folderLists.map(async (folderList) => {
                                    const tasks = await this.withTimeoutAndRetry(() => this.getTasksFromList(folderList.id)).catch(e => {
                                        console.error(e);
                                        return [];
                                    });
                                    console.log(`Got ${tasks.length} tasks for list ${folderList.name} (${this.requests} rq)`);
                                    folderList.addChildren(tasks);
                                })).catch(e => console.error(e));
                                folder.addChildren(folderLists);
                            }
                        })).catch(e => console.error(e));
                        space.addChildren(folders);
                    }

                    // Fetch lists directly in space with retry and timeout logic
                    const lists = await this.withTimeoutAndRetry(() => this.getLists(space.id)).catch(e => {
                        console.error(e);
                        return [];
                    });
                    console.log(`Got ${lists.length} lists for space ${space.name} (${this.requests} rq)`);

                    if (lists.length > 0) {
                        await Promise.all(lists.map(async (list) => {
                            const tasks = await this.withTimeoutAndRetry(() => this.getTasksFromList(list.id)).catch(e => {
                                console.error(e);
                                return [];
                            });
                            console.log(`Got ${tasks.length} tasks for list ${list.name} (${this.requests} rq)`);
                            list.addChildren(tasks);
                        })).catch(e => console.error(e));
                        space.addChildren(lists);
                    }
                })).catch(e => console.error(e));
                return spaces;
            }
        } catch (e) {
            console.error(e);
        }

        return [];
    },

    /*
     * Helper: Check if we should process items (either selectAll flag or explicit selection)
     */
    _shouldProcess(selectAllFlag, itemsObject) {
        return selectAllFlag || (itemsObject && Object.keys(itemsObject).length > 0);
    },

    /*
     * Helper: Fetches tasks for all lists and adds them as children
     */
    async _fetchTasksForLists(lists) {
        if (lists.length === 0) return;

        await Promise.all(lists.map(async (list) => {
            const tasks = await this.withTimeoutAndRetry(() =>
                this.getTasksFromList(list.id)
            ).catch(e => {
                console.error(e);
                return [];
            });
            console.log(`Got ${tasks.length} tasks for list ${list.name} (${this.requests} rq)`);
            list.addChildren(tasks);
        })).catch(e => console.error(e));
    },

    /*
     * Internal: Fetches filtered hierarchy based on user selection
     * Only fetches from selected spaces/folders/lists
     * Supports selectAll* flags to include new items automatically
     * Always fetches tasks for selected lists
     */
    async _getFilteredHierarchy(selection) {
        console.log("Getting FILTERED hierarchy from ClickUp");
        console.log(`Selection: ${JSON.stringify(selection)}`);

        if (!selection || !selection.spaces) {
            console.warn("Invalid selection structure");
            return [];
        }

        // Get all spaces first
        const allSpaces = await this.getSpaces().catch(e => {
            console.error(e);
            return [];
        });

        // Filter to selected spaces
        const selectedSpaceIds = Object.keys(selection.spaces);
        const filteredSpaces = allSpaces.filter(space => selectedSpaceIds.includes(space.id));

        console.log(`Filtered to ${filteredSpaces.length}/${allSpaces.length} spaces (${this.requests} rq)`);

        if (filteredSpaces.length === 0) {
            return [];
        }

        // For each selected space, fetch selected folders/lists
        await Promise.all(filteredSpaces.map(async (space) => {
            const spaceConfig = selection.spaces[space.id];
            console.log(`Processing space: ${space.name} (${spaceConfig.folders ? Object.keys(spaceConfig.folders).length : 0} folders, ${spaceConfig.lists ? Object.keys(spaceConfig.lists).length : 0} lists)`);

            // Process folders if any are configured OR if selectAllFolders is true
            if (this._shouldProcess(spaceConfig.selectAllFolders, spaceConfig.folders)) {
                // Fetch all folders for this space
                const allFolders = await this.withTimeoutAndRetry(() =>
                    this.getFolders(space.id)
                ).catch(e => {
                    console.error(e);
                    return [];
                });

                // Filter to selected folders OR all if selectAllFolders is true
                const filteredFolders = spaceConfig.selectAllFolders
                    ? allFolders
                    : allFolders.filter(folder => Object.keys(spaceConfig.folders).includes(folder.id));

                console.log(`Filtered to ${filteredFolders.length}/${allFolders.length} folders in space ${space.name} (${this.requests} rq)`);

                // For each selected folder, get its lists
                await Promise.all(filteredFolders.map(async (folder) => {
                    const folderConfig = (spaceConfig.folders && spaceConfig.folders[folder.id]) || {};

                    // If selectAllFolders is true, treat each folder as having selectAllLists: true
                    const shouldSelectAllLists = spaceConfig.selectAllFolders || folderConfig.selectAllLists;

                    // Fetch all lists in folder
                    const allLists = await this.withTimeoutAndRetry(() =>
                        this.getFolderedLists(folder.id)
                    ).catch(e => {
                        console.error(e);
                        return [];
                    });

                    // Filter to selected lists OR all if selectAllLists is true
                    const filteredLists = shouldSelectAllLists
                        ? allLists
                        : allLists.filter(list => Object.keys(folderConfig.lists || {}).includes(list.id));

                    console.log(`Filtered to ${filteredLists.length}/${allLists.length} lists in folder ${folder.name} (${this.requests} rq)`);

                    // Fetch tasks for each list
                    await this._fetchTasksForLists(filteredLists);
                    if (filteredLists.length > 0) {
                        folder.addChildren(filteredLists);
                    }
                })).catch(e => console.error(e));

                if (filteredFolders.length > 0) {
                    space.addChildren(filteredFolders);
                }
            }

            // Process space-level lists (not in folders) if any are configured OR if selectAllLists is true
            if (this._shouldProcess(spaceConfig.selectAllLists, spaceConfig.lists)) {
                // Fetch all space-level lists
                const allLists = await this.withTimeoutAndRetry(() =>
                    this.getLists(space.id)
                ).catch(e => {
                    console.error(e);
                    return [];
                });

                // Filter to selected lists OR all if selectAllLists is true
                const filteredLists = spaceConfig.selectAllLists
                    ? allLists
                    : allLists.filter(list => Object.keys(spaceConfig.lists).includes(list.id));

                console.log(`Filtered to ${filteredLists.length}/${allLists.length} space-level lists in ${space.name} (${this.requests} rq)`);

                // Fetch tasks for each list
                await this._fetchTasksForLists(filteredLists);
                if (filteredLists.length > 0) {
                    space.addChildren(filteredLists);
                }
            }
        })).catch(e => console.error(e));

        console.log(`Filtered hierarchy complete (${this.requests} total requests)`);
        return filteredSpaces;
    },

    /*
     * Builds hierarchy of spaces, folders, and lists WITHOUT tasks
     * Used for hierarchy selection UI in settings
     */
    async getHierarchyMetadata() {
        this.requests = 0;
        console.log("Getting hierarchy metadata (no tasks) from ClickUp");

        const spaces = await this.getSpaces().catch(e => {
            console.error(e);
            return [];
        });

        console.log(`Got ${spaces.length} spaces from ClickUp (${this.requests} rq)`);

        if (spaces.length > 0) {
            await Promise.all(spaces.map(async (space) => {
                console.log(`Getting folders and lists for space ${space.name} (${this.requests} rq)`);

                // Fetch folders with retry and timeout logic
                const folders = await this.withTimeoutAndRetry(() => this.getFolders(space.id)).catch(e => {
                    console.error(e);
                    return [];
                });
                console.log(`Got ${folders.length} folders for space ${space.name} (${this.requests} rq)`);

                if (folders.length > 0) {
                    await Promise.all(folders.map(async (folder) => {
                        const folderLists = await this.withTimeoutAndRetry(() => this.getFolderedLists(folder.id)).catch(e => {
                            console.error(e);
                            return [];
                        });
                        console.log(`Got ${folderLists.length} lists for folder ${folder.name} (${this.requests} rq)`);
                        // Don't fetch tasks - just add lists
                        if (folderLists.length > 0) {
                            folder.addChildren(folderLists);
                        }
                    })).catch(e => console.error(e));
                    space.addChildren(folders);
                }

                // Fetch lists directly in space
                const lists = await this.withTimeoutAndRetry(() => this.getLists(space.id)).catch(e => {
                    console.error(e);
                    return [];
                });
                console.log(`Got ${lists.length} lists for space ${space.name} (${this.requests} rq)`);

                if (lists.length > 0) {
                    space.addChildren(lists);
                }
            })).catch(e => console.error(e));

            return spaces;
        }

        return [];
    },

    async getCachedHierarchyMetadata() {
        try {
            const cached = cache.get(HIERARCHY_METADATA_CACHE_KEY)

            if (cached) {
                console.log("Got hierarchy metadata from cache")
                return cached
            }

            let metadata = await this.getHierarchyMetadata().catch(e => {
                console.error(e)
            })
            return cache.put(
                HIERARCHY_METADATA_CACHE_KEY,
                metadata,
                CACHE_DEFAULT
            )
        } catch (e) {
            console.error(e)
        }
    },

    /*
    * Get a single space from a team, by id (for now unused)
     */
    // TODO: ClickUp API has a path for getting a single space, but it doesn't work, always returns invalid id, so we
    //  have to get all spaces and filter them. This is not ideal, but it works. Luckily, there(usually) are not that many
    async getSpace(spaceId) {
        let spaces = await this.getSpaces()
            .then(spaces => {
                return spaces.filter(space => space.id === spaceId)
            }).catch(e => {
                console.error(e)
            })
        return spaces[0]
    },

    /*
    * Get all spaces from a team
     */
    async getSpaces() {
        this.requests++;
        const response = await throttledRequest({
            method: 'GET',
            mode: 'no-cors',
            url: `${BASE_URL}/team/${store.get('settings.clickup_team_id')}/space?archived=false'`,
            headers: {
                'Authorization': store.get('settings.clickup_access_token'),
                'Content-Type': 'application/json'
            }
        });
        const spaces = JSON.parse(response.body).spaces || [];
        return spaces.map(space => factory.createSpace(space));
    },

    async getFolder(folderId) {
        return new Promise((resolve, reject) => {
            request({
                method: 'GET',
                url: `${BASE_URL}/folder/${folderId}`,
                headers: {
                    'Authorization': store.get('settings.clickup_access_token'),
                    'Content-Type': 'application/json'
                }
            }, (error, response) => {
                if (error) return reject(error)
                resolve(JSON.parse(response.body) || [])
            });
        }).then(folder => {
            folder = factory.createFolder(folder)
            // console.log("Folders received from ClickUp")
            // console.log(folders)
            return folder
        }).catch(e => {
            console.error(e)
        })
    },

    /*
    * Get all folders from a space
    */
    async getFolders(spaceId) {
        this.requests++;
        const response = await throttledRequest({
            method: 'GET',
            url: `${BASE_URL}/space/${spaceId}/folder?archived=false`,
            headers: {
                'Authorization': store.get('settings.clickup_access_token'),
                'Content-Type': 'application/json'
            }
        });
        const folders = JSON.parse(response.body).folders || [];
        return folders.map(folder => factory.createFolder(folder));
    },

    /*
    * Get all lists from a folder
    */
    async getFolderedLists(FolderId) {
        this.requests++;
        const response = await throttledRequest({
            method: 'GET',
            url: `${BASE_URL}/folder/${FolderId}/list?archived=false`,
            headers: {
                'Authorization': store.get('settings.clickup_access_token'),
                'Content-Type': 'application/json'
            }
        });
        const lists = JSON.parse(response.body).lists || [];
        return lists.map(list => factory.createList(list));
    },

    async getList(listId) {
        return new Promise((resolve, reject) => {
            request({
                method: 'GET',
                url: `${BASE_URL}/list/${listId}`,
                headers: {
                    'Authorization': store.get('settings.clickup_access_token'),
                    'Content-Type': 'application/json'
                }
            }, (error, response) => {
                if (error) return reject(error)
                resolve(JSON.parse(response.body) || [])
            });
        }).then(list => {
            list = factory.createList(list)
            return list
        }).catch(e => {
            console.error(e)
        })
    },
    async getLists(spaceId) {
        this.requests++;
        const response = await throttledRequest({
            method: 'GET',
            mode: 'no-cors',
            url: `${BASE_URL}/space/${spaceId}/list?archived=false`,
            headers: {
                'Authorization': store.get('settings.clickup_access_token'),
                'Content-Type': 'application/json'
            }
        });
        const lists = JSON.parse(response.body).lists || [];
        return lists.map(list => factory.createList(list));
    },

    _assignSubtasksToParentTasks(results) {
        // Map to store all tasks by their IDs
        const taskMap = {};

        // Array to store root-level tasks
        const tasks = [];

        // First pass: Create task and subtask objects and store them in taskMap
        results.forEach(taskData => {
            taskMap[taskData.id] = taskData.parent == null
                ? factory.createTask(taskData)
                : factory.createSubtask(taskData);
        });

        // Second pass: Link subtasks to their parent tasks
        results.forEach(taskData => {
            const task = taskMap[taskData.id];
            if (taskData.parent != null) {
                const parentTask = taskMap[taskData.parent];
                if (parentTask) {
                    parentTask.addChild(task);
                }
            } else {
                // Root-level task, add to tasks array
                tasks.push(task);
            }
        });

        // Function to sort tasks and their subtasks alphabetically by name
        const sortTasks = (tasks) => {
            tasks.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
            tasks.forEach(task => {
                if (typeof task.children !== 'undefined' && task.children.length > 0) {
                    sortTasks(task.children);
                }
            });
        };

        // Sort the root tasks and their subtasks
        sortTasks(tasks);

        return tasks;
    },
    /*
     * Get all tasks from a list, handling pagination
     */
    async getTasksFromList(listId) {
        const tasks = [];
        let page = 0;
        let hasMore = true;

        while (hasMore) {
            this.requests++;

            try {
                const response = await throttledRequest({
                    method: 'GET',
                    url: `${BASE_URL}/list/${listId}/task`,
                    qs: {
                        archived: false,
                        include_markdown_description: false,
                        subtasks: true,
                        include_closed: true,
                        page: page
                    },
                    headers: {
                        'Authorization': store.get('settings.clickup_access_token'),
                        'Content-Type': 'application/json'
                    }
                });
                const results = JSON.parse(response.body).tasks || [];

                tasks.push(...results);
                hasMore = results.length === CLICKUP_TASKS_PER_PAGE; // Continue if the page is full
                page++;

            } catch (e) {
                console.error(`Error fetching tasks for page ${page}:`, e);
                hasMore = false; // Stop on error
            }
        }

        return this._assignSubtasksToParentTasks(tasks);
    },

    async getTask(taskId, raw = false) {
        return new Promise((resolve, reject) => {
            request({
                method: 'GET',
                mode: 'no-cors',
                url: `${BASE_URL}/task/${taskId}?include_subtasks=true&include_markdown_description=false`,
                headers: {
                    'Authorization': store.get('settings.clickup_access_token'),
                    'Content-Type': 'application/json'
                }
            }, (error, response) => {
                if (error) return reject(error)
                resolve(JSON.parse(response.body) || [])
            });
        }).then(task => {
            if (!raw) {
                task = factory.createTask(task)
            }
            return task
        }).catch(e => {
            console.error(e)
        })
    },

    async getColorsBySpace() {
        return this.getSpaces().then(spaces => {
            // console.log("Spaces for color pallete:")
            // console.log(spaces)
            let colors = new Map()
            if (spaces) {
                spaces.forEach(space => {
                    colors.set(space.id, space.color)
                })
            }
            return colors
        }).catch(e => {
            console.error(e)
        })
    },

    /*
    * Get all time tracking entries within a given range
    */
    async getTimeTrackingRange(start, end, userId = '', space_id = '', folder_id = '', list_id = '', task_id = '') {
        if ((!start && start === undefined) || (!end && end === undefined)) return;
        const startTime = performance.now();
        return new Promise((resolve, reject) => {
            const params = {
                start_date: start.getTime(),
                end_date: end.getTime(),
                space_id: space_id,
                folder_id: folder_id,
                list_id: list_id,
                task_id: task_id,
                include_location_names: true,
            }

            // Only set assignee when argument was given
            if (userId) {
                params.assignee = userId
            }

            const url = `${teamRootUrl()}/time_entries?` + new URLSearchParams(params);

            request({
                method: 'GET',
                mode: 'no-cors',
                url: url,

                headers: {
                    'Authorization': store.get('settings.clickup_access_token'),
                    'Content-Type': 'application/json'
                }
            }, (error, response) => {
                const elapsed = (performance.now() - startTime).toFixed(2);
                console.log(`[API TIMING] GET ${url} - ${elapsed}ms`);

                if (error) return reject(error)
                const body = JSON.parse(response.body)

                if (body.err) { // This friggin api... return a decent response code for fuck sake
                    reject(body.err)
                }
                resolve(body.data || [])
            });
        }).then(timeTackingData => {
            return timeTackingData.filter(item => {
                return item.start >= start.getTime() && item.end <= end.getTime();
            })
        })
    },

    /*
     * Create a new time tracking entry
     */
    createTimeTrackingEntry(taskId, description, start, end) {
        const startTime = performance.now();
        const url = `${teamRootUrl()}/time_entries`;

        return new Promise((resolve, reject) => {

            request({
                method: 'POST',
                url: url,
                headers: {
                    'Authorization': store.get('settings.clickup_access_token'),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    description,
                    "tid": taskId,
                    "start": start.valueOf(),
                    "duration": end.valueOf() - start.valueOf(),
                }),
                timeout: DEFAULT_CLICKUP_TIMEOUT,
            }, (error, response) => {
                const elapsed = (performance.now() - startTime).toFixed(2);
                console.log(`[API TIMING] POST ${url} - ${elapsed}ms`);

                if (error) return reject(error)
                const body = JSON.parse(response.body)

                if (body.error) {
                    reject(body.err)
                }

                resolve(typeof (body.data[0]) !== 'undefined' ? body.data[0] : body.data)
            })
        })
    },

    /*
     * Update an exisiting time tracking entry
     */
    updateTimeTrackingEntry(entryId, description, start, end) {
        const startTime = performance.now();
        const url = `${teamRootUrl()}/time_entries/${entryId}`;

        return new Promise((resolve, reject) => {

            request({
                method: 'PUT',
                url: url,
                headers: {
                    'Authorization': store.get('settings.clickup_access_token'),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    description,
                    "start": start.valueOf(),
                    "duration": end.valueOf() - start.valueOf(),
                }),
                timeout: DEFAULT_CLICKUP_TIMEOUT,
            }, (error, response) => {
                const elapsed = (performance.now() - startTime).toFixed(2);
                console.log(`[API TIMING] PUT ${url} - ${elapsed}ms`);

                if (error) return reject(error)
                const body = JSON.parse(response.body)

                if (body.error) {
                    reject(body.err)
                }

                resolve(body.data[0])
            })
        })
    },

    /*
     * Deleta a time tracking entry
     */
    deleteTimeTrackingEntry(entryId) {
        const startTime = performance.now();
        const url = `${teamRootUrl()}/time_entries/${entryId}`;

        return new Promise((resolve, reject) => {

            request({
                method: 'DELETE',
                url: url,
                headers: {
                    'Authorization': store.get('settings.clickup_access_token'),
                    'Content-Type': 'application/json'
                },
                timeout: DEFAULT_CLICKUP_TIMEOUT
            }, (error, response) => {
                const elapsed = (performance.now() - startTime).toFixed(2);
                console.log(`[API TIMING] DELETE ${url} - ${elapsed}ms`);

                if (error) return reject(error)
                resolve(JSON.parse(response.body).data[0])
            })
        })
    },

    /*
     * Fetch all members from all teams you have access to
     */
    getUsers() {
        return new Promise((resolve, reject) => {

            request({
                method: 'GET',
                url: `${BASE_URL}/team/`,
                headers: {
                    'Authorization': store.get('settings.clickup_access_token'),
                    'Content-Type': 'application/json'
                }
            }, (error, response) => {
                if (error) return reject(error)

                const teams = JSON.parse(response.body).teams
                const users = teams
                    .flatMap(team => team.members)
                    .map(member => member.user)
                    .filter(user => user.role !== 4) // Remove guests
                    .filter((user, index, self) => self.indexOf(user) === index) // only unique id's
                    .sort(function (a, b) { // sort alphabetically by name
                        if (a.username === b.username) return 0

                        return a.username < b.username
                            ? -1
                            : 1
                    })

                resolve(users)
            })
        })
    },

    /*
     * Fetch users from cache
     */
    async getCachedUsers() {
        const cached = cache.get(USERS_CACHE_KEY)

        if (cached) {
            return cached
        }

        return cache.put(
            USERS_CACHE_KEY,
            await this.getUsers(),
            CACHE_DEFAULT
        )
    },
}
