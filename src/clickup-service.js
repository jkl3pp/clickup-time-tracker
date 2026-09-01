import request from 'request';
import store from '@/store';
import cache from '@/cache';
import {ClickUpItemFactory, ClickUpType} from "@/model/ClickUpModels";

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

function _logTime() {
    return new Date().toLocaleTimeString('en-GB'); // HH:MM:SS, 24h
}

// Global rate-limit gate — one shared pause for all requests instead of each
// 429'd request sleeping (and logging) on its own
let _rateLimitGate = null; // non-null while a pause is in effect
let _rateLimitPauses = 0; // how many pauses so far, reported in walk summaries
let _completedThisWindow = 0; // successful requests since the last pause ended
let _lastRateLimitHeaders = ''; // e.g. "remaining 57/100", from the most recent response

function _pauseForRateLimit(seconds) {
    if (_rateLimitGate) return _rateLimitGate; // join the pause already in progress
    _rateLimitPauses++;
    console.warn(`[${_logTime()}] ClickUp rate limit hit after ${_completedThisWindow} successful requests this window — pausing all requests for ${seconds}s (last seen x-ratelimit: ${_lastRateLimitHeaders || 'n/a'})`);
    _rateLimitGate = new Promise(resolve => setTimeout(() => {
        _rateLimitGate = null;
        _completedThisWindow = 0;
        console.log(`[${_logTime()}] Rate-limit pause over — resuming requests`);
        resolve();
    }, seconds * 1000));
    return _rateLimitGate;
}

async function throttledRequest(options) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        if (_rateLimitGate) await _rateLimitGate; // wait out a global pause before taking a slot
        await _acquireSlot();
        if (_rateLimitGate) { _releaseSlot(); continue; } // pause began while we waited for a slot
        let response;
        try {
            response = await new Promise((resolve, reject) => {
                request({ timeout: DEFAULT_CLICKUP_TIMEOUT, ...options }, (error, response) => {
                    if (error) reject(error);
                    else resolve(response);
                });
            });
        } finally {
            // Release before any 429 wait so the slot isn't held during the pause
            _releaseSlot();
        }
        if (response.headers['x-ratelimit-remaining'] !== undefined) {
            _lastRateLimitHeaders = `remaining ${response.headers['x-ratelimit-remaining']}/${response.headers['x-ratelimit-limit'] || '?'}`;
        }
        if (response.statusCode !== 429) {
            _completedThisWindow++;
            return response;
        }
        await _pauseForRateLimit(parseInt(response.headers['retry-after'] || '5', 10));
    }
}

// Cache keys
export const HIERARCHY_CACHE_KEY = 'hierarchy';
export const HIERARCHY_METADATA_CACHE_KEY = 'hierarchy_metadata';
// Sync state for the cached task hierarchy. Deliberately stored through the
// cache (not the plain store) so flushing caches on a settings change drops the
// tree and its sync state together.
const HIERARCHY_SYNC_CACHE_KEY = 'hierarchy_sync';
const USERS_CACHE_KEY = 'users';

// Store keys
export const STORE_KEY_USER_ID = 'settings.clickup_user_id';

// Timeout and pagination constants
const DEFAULT_CLICKUP_TIMEOUT = 30000; // 30 seconds
const CLICKUP_TASKS_PER_PAGE = 100; // ClickUp API pagination limit

// Cache duration
const CACHE_DEFAULT = 24 * 7 * 60 * 60; // 7 days in seconds

// Incremental-refresh tuning
const DELTA_OVERLAP_MS = 5 * 60 * 1000; // re-ask for slightly older changes to absorb clock skew
const DELTA_MIN_INTERVAL_MS = 5 * 60 * 1000; // don't ask again this soon after a sync
const FULL_RESYNC_INTERVAL_MS = CACHE_DEFAULT * 1000; // deltas can't see deletions; rebuild weekly

// One in-flight hierarchy load at a time. The main process preloads on startup
// while the renderer asks on mount, and both used to run the whole thing twice.
let _hierarchyInFlight = null;

// Cheap stable digest of the saved selection — a delta is only valid while the
// scope it was fetched for is unchanged
function _selectionFingerprint(selection) {
    const json = JSON.stringify(selection || null);
    let hash = 5381;
    for (let i = 0; i < json.length; i++) {
        hash = ((hash * 33) ^ json.charCodeAt(i)) >>> 0;
    }
    return `${json.length}-${hash.toString(36)}`;
}

// When the cached tree predates any sync state, its cache expiry tells us when
// it was written, which is a safe delta baseline
function _cachedHierarchyWrittenAt() {
    const expiresAt = ((cache.all() || {}).expires_at || {})[HIERARCHY_CACHE_KEY];
    if (!expiresAt) return null;
    return Math.round((expiresAt - CACHE_DEFAULT) * 1000);
}

function _insertSortedByName(parent, node) {
    if (!parent.children) parent.children = [];
    parent.children.push(node);
    parent.children.sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, {sensitivity: 'base'}));
}

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
    failedFetches: 0,
    _lastDeltaStats: null,


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

                store.set(STORE_KEY_USER_ID, user.id)

                resolve(true)
            });
        })
    },

    async getCurrentUserId() {
        const stored = store.get(STORE_KEY_USER_ID);
        if (stored) return stored;

        return new Promise((resolve, reject) => {
            request({
                method: 'GET',
                url: `${BASE_URL}/user`,
                headers: {
                    'Authorization': store.get('settings.clickup_access_token'),
                    'Content-Type': 'application/json'
                },
                timeout: DEFAULT_CLICKUP_TIMEOUT,
            }, (error, response) => {
                if (error) return reject(error)
                const user = JSON.parse(response.body).user
                if (!user) return reject('Invalid response')
                store.set(STORE_KEY_USER_ID, user.id)
                resolve(user.id)
            });
        })
    },

    // Retry wrapper function. Requests carry their own socket-level timeout
    // (see throttledRequest), so waiting for a concurrency slot or a rate-limit
    // backoff never counts as a failure here.
    async withTimeoutAndRetry(fn, retries = 5, retryDelay = 1000) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                console.error(`Attempt ${attempt} failed: ${error.message}`);
                if (attempt === retries) {
                    console.error(`Max retries reached for ${fn.name}`);
                    this.failedFetches++;
                    throw error; // Never swallow into [] — a partial tree must not be cached
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
        // Share one load: the main process preloads on startup while the
        // renderer asks on mount, and running both doubles the request cost
        // against a shared budget
        if (_hierarchyInFlight) {
            // Don't make a caller queue behind a refresh that is already
            // running — the cached tree is complete as of the last sync, and
            // the refresh in progress will land in the cache for next time
            const cached = cache.get(HIERARCHY_CACHE_KEY)
            if (cached) return cached
            return _hierarchyInFlight;
        }
        _hierarchyInFlight = this._loadCachedHierarchy()
            .finally(() => { _hierarchyInFlight = null; });
        return _hierarchyInFlight;
    },

    async _loadCachedHierarchy() {
        try {
            const cached = cache.get(HIERARCHY_CACHE_KEY)
            const selection = this._activeSelection()

            if (cached) {
                // Top up the cached tree with what changed since the last sync
                // instead of rebuilding it
                if (selection) {
                    const refreshed = await this._refreshCachedHierarchy(cached, selection)
                    if (refreshed) return refreshed
                    console.log("Cached hierarchy can't be refreshed in place, rebuilding")
                } else {
                    console.log("Got hierarchy from cache")
                    return cached
                }
            }

            // Snapshot rather than reset: an overlapping walk must not be able to
            // zero this walk's failure count
            const failedBefore = this.failedFetches
            const startedAt = Date.now()

            let hierarchy = await this.getHierarchy()

            if (this.failedFetches > failedBefore) {
                throw new Error(`Hierarchy fetch incomplete: ${this.failedFetches - failedBefore} request(s) failed after retries; not caching partial data`)
            }

            cache.put(
                HIERARCHY_CACHE_KEY,
                hierarchy,
                CACHE_DEFAULT
            )
            if (selection) {
                cache.put(
                    HIERARCHY_SYNC_CACHE_KEY,
                    {lastSyncMs: startedAt, fullSyncAtMs: startedAt, selectionFingerprint: _selectionFingerprint(selection)},
                    CACHE_DEFAULT
                )
            } else {
                cache.clear(HIERARCHY_SYNC_CACHE_KEY)
            }
            return hierarchy
        } catch (e) {
            console.error(e)
            throw e
        }
    },

    // Clears both hierarchy and metadata caches
    // Use this when settings change (team ID, access token, hierarchy filter)
    // Individual refresh operations should clear their specific cache only
    clearCachedHierarchy() {
        cache.clear(HIERARCHY_CACHE_KEY)
        cache.clear(HIERARCHY_METADATA_CACHE_KEY)
        cache.clear(HIERARCHY_SYNC_CACHE_KEY)
    },

    /*
     * Internal: Fetches complete hierarchy (all spaces/folders/lists/tasks)
     * This is the original getHierarchy() logic for backwards compatibility
     */
    async _getFullHierarchy() {
        console.log("Getting FULL hierarchy from ClickUp");
        // Not swallowed: without spaces the whole walk is empty, which must never be cached
        const spaces = await this.withTimeoutAndRetry(() => this.getSpaces());

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
     * Fetch one page of the filtered team-tasks endpoint.
     * Throws on transport errors, non-200 responses and ClickUp {err} bodies —
     * ClickUp returns errors with HTTP 200 sometimes, and a silently-empty page
     * here would end up cached as a complete tree.
     */
    async _getTeamTaskPage(queryPairs, page) {
        const query = queryPairs.concat([`page=${page}`]).join('&');
        const response = await throttledRequest({
            method: 'GET',
            url: `${teamRootUrl()}/task?${query}`,
            headers: {
                'Authorization': store.get('settings.clickup_access_token'),
                'Content-Type': 'application/json'
            }
        });
        if (response.statusCode !== 200) {
            throw new Error(`Team task fetch failed with HTTP ${response.statusCode} (page ${page})`);
        }
        const body = JSON.parse(response.body);
        if (body.err) {
            throw new Error(`Team task fetch failed: ${body.err}`);
        }
        this.requests++; // count completed requests, not started ones
        return body;
    },

    /*
     * Sweep all pages of /team/{id}/task for the given filter params
     * (e.g. ['project_ids[]=123', 'project_ids[]=456']).
     * Returns raw task objects; subtasks arrive as flat entries with .parent set.
     */
    async _sweepTeamTasks(filterPairs) {
        const base = ['subtasks=true', 'include_closed=true'].concat(filterPairs);
        const tasks = [];
        let page = 0;
        for (;;) {
            const body = await this.withTimeoutAndRetry(() => this._getTeamTaskPage(base, page));
            tasks.push(...(body.tasks || []));
            // The API's own end-of-results flag; anything else means done
            if (body.last_page === false) page++;
            else break;
        }
        return tasks;
    },

    /*
     * Translate the saved selection into team-task filter scopes.
     * knownSpaceIds, when given, drops selection entries for spaces that no
     * longer exist; pass null to keep every entry.
     */
    _deriveSelectionScopes(selection, knownSpaceIds) {
        const folderScopes = [];    // selected folders → one project_ids[] sweep
        const spaceListScopes = []; // explicitly selected space-level lists → one list_ids[] sweep
        const spaceScopes = [];     // spaces with selectAll flags → one space_ids[] sweep
        Object.entries(selection.spaces).forEach(([spaceId, spaceConfig]) => {
            if (knownSpaceIds && !knownSpaceIds.has(spaceId)) return;
            if (spaceConfig.selectAllFolders || spaceConfig.selectAllLists) {
                spaceScopes.push(spaceId);
            }
            if (!spaceConfig.selectAllFolders) {
                Object.values(spaceConfig.folders || {}).forEach(folderConfig => {
                    folderScopes.push({ spaceId, folderConfig });
                });
            }
            if (!spaceConfig.selectAllLists) {
                Object.values(spaceConfig.lists || {}).forEach(listConfig => {
                    spaceListScopes.push({ spaceId, listConfig });
                });
            }
        });
        return {folderScopes, spaceListScopes, spaceScopes};
    },

    _buildSweeps({folderScopes, spaceListScopes, spaceScopes}) {
        const sweeps = [];
        if (folderScopes.length > 0) {
            sweeps.push({ label: `project_ids[] (${folderScopes.length} folders)`, pairs: folderScopes.map(f => `project_ids[]=${f.folderConfig.id}`) });
        }
        if (spaceListScopes.length > 0) {
            sweeps.push({ label: `list_ids[] (${spaceListScopes.length} lists)`, pairs: spaceListScopes.map(l => `list_ids[]=${l.listConfig.id}`) });
        }
        if (spaceScopes.length > 0) {
            sweeps.push({ label: `space_ids[] (${spaceScopes.length} spaces)`, pairs: spaceScopes.map(id => `space_ids[]=${id}`) });
        }
        return sweeps;
    },

    /*
     * Selection semantics of the old container walk, applied per task:
     * a task is in scope when its home list is selected — explicitly, via its
     * folder's selectAllLists, via the space's selectAllFolders (foldered
     * tasks) or the space's selectAllLists (folderless tasks).
     * folder.hidden === true is ClickUp's marker for "folderless list".
     */
    _taskMatchesSelection(task, selection) {
        if (!task.list || !task.space) return false;
        const spaceConfig = selection.spaces[task.space.id];
        if (!spaceConfig) return false;
        const folderless = !task.folder || task.folder.hidden;
        if (folderless) {
            return !!(spaceConfig.selectAllLists || (spaceConfig.lists && spaceConfig.lists[task.list.id]));
        }
        if (spaceConfig.selectAllFolders) return true;
        const folderConfig = spaceConfig.folders && spaceConfig.folders[task.folder.id];
        if (!folderConfig) return false;
        return !!(folderConfig.selectAllLists || (folderConfig.lists && folderConfig.lists[task.list.id]));
    },

    /*
     * Internal: Fetches filtered hierarchy based on user selection.
     * Instead of walking space → folder → list → tasks (hundreds of requests),
     * this sweeps GET /team/{id}/task scoped to the selection — tasks carry
     * their space/folder/list inline, so the tree is rebuilt from task payloads
     * plus one getSpaces call and one getFolderedLists call per selected folder.
     * Tasks are placed by their home list only; a list with zero tasks still
     * appears when it was prefetched or explicitly selected, so the task
     * creator can create into it.
     */
    async _getFilteredHierarchy(selection) {
        const startedAt = performance.now();
        const pausesBefore = _rateLimitPauses;
        console.log(`[${_logTime()}] Getting FILTERED hierarchy via team-task sweep`);
        console.log(`Selection: ${JSON.stringify(selection)}`);

        if (!selection || !selection.spaces) {
            console.warn("Invalid selection structure");
            return [];
        }

        // Spaces first: names/colors for the tree, and it feeds the factory's
        // colorMap so the folders/lists/tasks built below inherit space colors.
        // Not swallowed: without spaces the whole walk is empty, which must never be cached
        const allSpaces = await this.withTimeoutAndRetry(() => this.getSpaces());
        const spaceNodesById = new Map(allSpaces.map(space => [space.id, space]));

        // Derive the sweep scope from the selection
        const {folderScopes, spaceListScopes} = this._deriveSelectionScopes(selection, new Set(spaceNodesById.keys()));

        // Pre-build folder and list nodes for selected folders (one request per
        // folder). This is what keeps lists with zero tasks visible.
        // Values: {node, spaceId} for folders; {node, parentType, parentId} for lists.
        const folderNodesById = new Map();
        const listNodesById = new Map();
        for (const { spaceId, folderConfig } of folderScopes) {
            const folderNode = factory.createFolder({ id: folderConfig.id, name: folderConfig.name, space: { id: spaceId } });
            folderNodesById.set(folderConfig.id, { node: folderNode, spaceId });
            const allLists = await this.withTimeoutAndRetry(() => this.getFolderedLists(folderConfig.id));
            const lists = folderConfig.selectAllLists
                ? allLists
                : allLists.filter(list => folderConfig.lists && folderConfig.lists[list.id]);
            lists.forEach(list => listNodesById.set(list.id, { node: list, parentType: 'folder', parentId: folderConfig.id }));
        }
        // Explicitly selected space-level lists: built from the stored selection,
        // no request needed
        for (const { spaceId, listConfig } of spaceListScopes) {
            if (listNodesById.has(listConfig.id)) continue;
            const listNode = factory.createList({ id: listConfig.id, name: listConfig.name, space: { id: spaceId } });
            listNodesById.set(listConfig.id, { node: listNode, parentType: 'space', parentId: spaceId });
        }

        // Sweep the team-task endpoint, one sweep per scope type (combined
        // filter params have unverified semantics), deduped by task id
        const sweeps = this._buildSweeps(this._deriveSelectionScopes(selection, new Set(spaceNodesById.keys())));

        const rawTasksById = new Map();
        for (const sweep of sweeps) {
            const requestsBefore = this.requests;
            const tasks = await this._sweepTeamTasks(sweep.pairs);
            console.log(`[${_logTime()}] Sweep ${sweep.label}: ${tasks.length} tasks in ${this.requests - requestsBefore} page(s)`);
            tasks.forEach(task => {
                if (!rawTasksById.has(task.id)) rawTasksById.set(task.id, task);
            });
        }

        // Bucket in-scope tasks by their home list
        const tasksByListId = new Map();
        for (const task of rawTasksById.values()) {
            if (!this._taskMatchesSelection(task, selection)) continue;
            if (!tasksByListId.has(task.list.id)) tasksByListId.set(task.list.id, []);
            tasksByListId.get(task.list.id).push(task);
        }

        // Lists we didn't prefetch (selectAll* space scopes): synthesize their
        // containers from the task payloads. Empty lists can't appear for these
        // scopes — there is no task to learn them from.
        for (const [listId, tasks] of tasksByListId) {
            if (listNodesById.has(listId)) continue;
            const sample = tasks[0];
            const spaceId = sample.space.id;
            const listNode = factory.createList({ id: listId, name: sample.list.name, space: { id: spaceId } });
            if (!sample.folder || sample.folder.hidden) {
                listNodesById.set(listId, { node: listNode, parentType: 'space', parentId: spaceId });
            } else {
                if (!folderNodesById.has(sample.folder.id)) {
                    const folderNode = factory.createFolder({ id: sample.folder.id, name: sample.folder.name, space: { id: spaceId } });
                    folderNodesById.set(sample.folder.id, { node: folderNode, spaceId });
                }
                listNodesById.set(listId, { node: listNode, parentType: 'folder', parentId: sample.folder.id });
            }
        }

        // Attach tasks to lists, then assemble lists → folders → spaces.
        // Only spaces that end up owning content appear in the tree.
        let acceptedTaskCount = 0;
        for (const [listId, rawTasks] of tasksByListId) {
            listNodesById.get(listId).node.addChildren(this._assignSubtasksToParentTasks(rawTasks));
            acceptedTaskCount += rawTasks.length;
        }

        const usedSpaceIds = new Set();
        for (const { node, parentType, parentId } of listNodesById.values()) {
            if (parentType === 'folder') {
                folderNodesById.get(parentId).node.addChild(node);
            } else if (spaceNodesById.has(parentId)) {
                spaceNodesById.get(parentId).addChild(node);
                usedSpaceIds.add(parentId);
            }
        }
        for (const { node, spaceId } of folderNodesById.values()) {
            if (spaceNodesById.has(spaceId)) {
                spaceNodesById.get(spaceId).addChild(node);
                usedSpaceIds.add(spaceId);
            }
        }

        const result = allSpaces.filter(space => usedSpaceIds.has(space.id));

        const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
        console.log(`[${_logTime()}] Filtered hierarchy finished: ${result.length} spaces, ${listNodesById.size} lists, ${acceptedTaskCount} tasks, ${this.requests} requests, ${_rateLimitPauses - pausesBefore} rate-limit pause(s), ${elapsed}s`);
        return result;
    },

    /*
     * The selection currently in force, or null when hierarchy filtering is off
     * or unconfigured (incremental refresh only applies to the filtered path)
     */
    _activeSelection() {
        const filter = store.get('settings.hierarchy_filter');
        if (!filter || !filter.enabled || !filter.selection) return null;
        const spaces = filter.selection.spaces;
        if (!spaces || Object.keys(spaces).length === 0) return null;
        return filter.selection;
    },

    /*
     * Fetch only the tasks that changed since sinceMs, over the same scopes the
     * full sync uses. Typically one request per scope.
     */
    async _fetchHierarchyDelta(selection, sinceMs) {
        this.requests = 0;
        const sweeps = this._buildSweeps(this._deriveSelectionScopes(selection, null));
        const rawTasksById = new Map();
        for (const sweep of sweeps) {
            const tasks = await this._sweepTeamTasks(sweep.pairs.concat([`date_updated_gt=${sinceMs}`]));
            tasks.forEach(task => {
                if (!rawTasksById.has(task.id)) rawTasksById.set(task.id, task);
            });
        }
        return [...rawTasksById.values()];
    },

    /*
     * Index a cached (plain, prototype-less) tree so the merge can find nodes
     * and the array that holds them
     */
    _indexCachedHierarchy(tree) {
        const spaces = new Map();
        const folders = new Map();
        const lists = new Map();
        const tasks = new Map();

        const indexTaskTree = (parent, listId) => {
            (parent.children || []).forEach(child => {
                if (child.type === ClickUpType.TASK || child.type === ClickUpType.SUBTASK) {
                    tasks.set(child.id, {node: child, parent, listId});
                    indexTaskTree(child, listId);
                }
            });
        };

        (tree || []).forEach(space => {
            spaces.set(space.id, space);
            (space.children || []).forEach(child => {
                if (child.type === ClickUpType.FOLDER) {
                    folders.set(child.id, {node: child, spaceId: space.id});
                    (child.children || []).forEach(list => {
                        if (list.type !== ClickUpType.LIST) return;
                        lists.set(list.id, {node: list, spaceId: space.id});
                        indexTaskTree(list, list.id);
                    });
                } else if (child.type === ClickUpType.LIST) {
                    lists.set(child.id, {node: child, spaceId: space.id});
                    indexTaskTree(child, child.id);
                }
            });
        });

        return {spaces, folders, lists, tasks};
    },

    /*
     * Copy the mutable fields of a task payload onto a tree node. Patched in
     * place rather than rebuilt so a re-parented task keeps its own subtasks.
     */
    _applyTaskFields(node, raw, spaceColor) {
        node.value = raw.id;
        node.name = raw.name;
        node.label = raw.name;
        node.custom_id = raw.custom_id || null;
        node.date_closed = raw.date_closed != null ? raw.date_closed : null;
        node.type = raw.parent != null ? ClickUpType.SUBTASK : ClickUpType.TASK;
        node.disable = false;
        if (spaceColor && !node.color) node.color = spaceColor;
    },

    /*
     * Apply changed tasks to the cached tree in place.
     * Returns the tree, or null when something can't be placed faithfully — the
     * caller then falls back to a full sync rather than serving a tree with a
     * silent gap in it.
     */
    _mergeDeltaIntoTree(tree, rawTasks, selection) {
        const index = this._indexCachedHierarchy(tree);
        const stats = {added: 0, updated: 0, moved: 0, removed: 0};

        const forget = (node) => {
            index.tasks.delete(node.id);
            (node.children || []).forEach(forget);
        };
        const detach = (entry) => {
            const siblings = entry.parent.children || [];
            const at = siblings.indexOf(entry.node);
            if (at !== -1) siblings.splice(at, 1);
            forget(entry.node);
        };

        // Find or create the list a task belongs in. Folders are synthesised
        // from the task payload; a missing space can't be (the team-task
        // endpoint gives space ids only), so that forces a full sync.
        const ensureList = (raw) => {
            const known = index.lists.get(raw.list.id);
            if (known) return known;
            const spaceNode = index.spaces.get(raw.space.id);
            if (!spaceNode) return null;
            const listNode = factory.createList({id: raw.list.id, name: raw.list.name});
            listNode.color = spaceNode.color;
            let parentNode = spaceNode;
            if (raw.folder && !raw.folder.hidden) {
                let folderEntry = index.folders.get(raw.folder.id);
                if (!folderEntry) {
                    const folderNode = factory.createFolder({id: raw.folder.id, name: raw.folder.name});
                    folderNode.color = spaceNode.color;
                    if (!spaceNode.children) spaceNode.children = [];
                    spaceNode.children.push(folderNode);
                    folderEntry = {node: folderNode, spaceId: raw.space.id};
                    index.folders.set(raw.folder.id, folderEntry);
                }
                parentNode = folderEntry.node;
            }
            if (!parentNode.children) parentNode.children = [];
            parentNode.children.push(listNode);
            const entry = {node: listNode, spaceId: raw.space.id};
            index.lists.set(raw.list.id, entry);
            return entry;
        };

        // Parents before children, so a subtask arriving with its brand-new
        // parent finds it already in the tree
        const ordered = [...rawTasks].sort((a, b) => (a.parent == null ? 0 : 1) - (b.parent == null ? 0 : 1));

        for (const raw of ordered) {
            const existing = index.tasks.get(raw.id);

            // Swept but no longer selected — it moved out of scope, so drop it
            if (!this._taskMatchesSelection(raw, selection)) {
                if (existing) {
                    detach(existing);
                    stats.removed++;
                }
                continue;
            }

            const listEntry = ensureList(raw);
            if (!listEntry) return null;

            // Subtasks hang off their parent when we have it, otherwise off the
            // list — degraded but visible, which beats vanishing
            let container = listEntry.node;
            if (raw.parent != null) {
                const parentEntry = index.tasks.get(raw.parent);
                if (parentEntry) container = parentEntry.node;
            }

            const spaceColor = (index.spaces.get(raw.space.id) || {}).color;

            if (existing) {
                this._applyTaskFields(existing.node, raw, spaceColor);
                if (existing.parent !== container) {
                    const siblings = existing.parent.children || [];
                    const at = siblings.indexOf(existing.node);
                    if (at !== -1) siblings.splice(at, 1);
                    _insertSortedByName(container, existing.node);
                    index.tasks.set(raw.id, {node: existing.node, parent: container, listId: listEntry.node.id});
                    stats.moved++;
                } else {
                    stats.updated++;
                }
                continue;
            }

            const node = raw.parent != null ? factory.createSubtask(raw) : factory.createTask(raw);
            node.color = node.color || spaceColor;
            _insertSortedByName(container, node);
            index.tasks.set(raw.id, {node, parent: container, listId: listEntry.node.id});
            stats.added++;
        }

        this._lastDeltaStats = stats;
        return tree;
    },

    /*
     * Bring a cached tree up to date without rebuilding it.
     * Returns the tree to serve, or null when a full sync is required.
     */
    async _refreshCachedHierarchy(cached, selection) {
        const fingerprint = _selectionFingerprint(selection);
        const sync = cache.get(HIERARCHY_SYNC_CACHE_KEY);
        let sinceMs;
        let fullSyncAtMs;

        if (sync && sync.lastSyncMs) {
            // Scope changed under us — a delta can't pull in what was previously
            // out of scope
            if (sync.selectionFingerprint !== fingerprint) return null;
            // Deltas never see deletions, so rebuild from scratch periodically
            if (Date.now() - (sync.fullSyncAtMs || sync.lastSyncMs) > FULL_RESYNC_INTERVAL_MS) return null;
            if (Date.now() - sync.lastSyncMs < DELTA_MIN_INTERVAL_MS) {
                console.log(`Got hierarchy from cache (synced ${Math.round((Date.now() - sync.lastSyncMs) / 1000)}s ago)`);
                return cached;
            }
            sinceMs = sync.lastSyncMs;
            fullSyncAtMs = sync.fullSyncAtMs || sync.lastSyncMs;
        } else {
            // A tree cached before this feature existed: date it from its own
            // cache expiry rather than resyncing 2,000 tasks or, worse,
            // pretending it is current
            const writtenAt = _cachedHierarchyWrittenAt();
            if (!writtenAt) return null;
            sinceMs = writtenAt;
            fullSyncAtMs = writtenAt;
        }

        const sweepStartedAt = Date.now();
        let rawTasks;
        try {
            rawTasks = await this._fetchHierarchyDelta(selection, sinceMs - DELTA_OVERLAP_MS);
        } catch (e) {
            // Quiet on purpose: the cached tree is intact and complete as of the
            // last sync, and the timestamp isn't advanced, so the next open retries
            console.warn(`[${_logTime()}] Hierarchy delta refresh failed, serving cached tree: ${e.message}`);
            return cached;
        }

        // Re-read immediately before merging: the renderer writes this same key
        // when it injects a task found outside the filter, and that write may
        // have landed while the delta was in flight
        const base = cache.get(HIERARCHY_CACHE_KEY) || cached;
        const merged = this._mergeDeltaIntoTree(base, rawTasks, selection);
        if (!merged) {
            console.log(`[${_logTime()}] Hierarchy delta touched an unknown space — falling back to a full sync`);
            return null;
        }

        const stats = this._lastDeltaStats;
        cache.put(HIERARCHY_CACHE_KEY, merged, CACHE_DEFAULT);
        cache.put(HIERARCHY_SYNC_CACHE_KEY, {lastSyncMs: sweepStartedAt, fullSyncAtMs, selectionFingerprint: fingerprint}, CACHE_DEFAULT);
        console.log(`[${_logTime()}] Hierarchy delta: ${rawTasks.length} changed task(s) in ${this.requests} request(s) — ${stats.added} added, ${stats.updated} updated, ${stats.moved} moved, ${stats.removed} removed`);
        return merged;
    },

    /*
     * Builds hierarchy of spaces, folders, and lists WITHOUT tasks
     * Used for hierarchy selection UI in settings
     */
    async getHierarchyMetadata() {
        this.requests = 0;
        const startedAt = performance.now();
        const pausesBefore = _rateLimitPauses;
        console.log(`[${_logTime()}] Getting hierarchy metadata (no tasks) from ClickUp`);

        // Not swallowed: without spaces the whole walk is empty, which must never be cached
        const spaces = await this.withTimeoutAndRetry(() => this.getSpaces());

        console.log(`Got ${spaces.length} spaces from ClickUp (${this.requests} rq)`);

        if (spaces.length > 0) {
            await Promise.all(spaces.map(async (space) => {
                console.log(`Getting folders and lists for space ${space.name} (${this.requests} rq)`);

                // Fetch folders with retry and timeout logic. The folders come back
                // with their lists inline, so there is no per-folder list request —
                // that alone was ~276 of the walk's ~393 requests.
                const folders = await this.withTimeoutAndRetry(() => this.getFolders(space.id, true)).catch(e => {
                    console.error(e);
                    return [];
                });
                console.log(`Got ${folders.length} folders for space ${space.name} (${this.requests} rq)`);

                if (folders.length > 0) {
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

            const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
            console.log(`[${_logTime()}] Hierarchy metadata walk finished: ${spaces.length} spaces, ${this.requests} requests, ${_rateLimitPauses - pausesBefore} rate-limit pause(s), ${elapsed}s`);

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

            // Snapshot rather than reset: an overlapping walk must not be able to
            // zero this walk's failure count
            const failedBefore = this.failedFetches

            let metadata = await this.getHierarchyMetadata()

            if (this.failedFetches > failedBefore) {
                throw new Error(`Hierarchy metadata fetch incomplete: ${this.failedFetches - failedBefore} request(s) failed after retries; not caching partial data`)
            }

            // The workspace always has spaces, so an empty tree means truncation
            if (!metadata || metadata.length === 0) {
                throw new Error('Hierarchy metadata fetch returned no spaces; not caching')
            }

            return cache.put(
                HIERARCHY_METADATA_CACHE_KEY,
                metadata,
                CACHE_DEFAULT
            )
        } catch (e) {
            console.error(e)
            throw e
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
        const response = await throttledRequest({
            method: 'GET',
            mode: 'no-cors',
            url: `${BASE_URL}/team/${store.get('settings.clickup_team_id')}/space?archived=false'`,
            headers: {
                'Authorization': store.get('settings.clickup_access_token'),
                'Content-Type': 'application/json'
            }
        });
        this.requests++; // count completed requests, not started ones
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
    *
    * With withLists, each folder is returned with the lists ClickUp already
    * embeds in this response attached as children, saving one
    * getFolderedLists request per folder. Verified 2026-09-01 across 277
    * folders: the inline lists[] matches GET /folder/{id}/list?archived=false
    * exactly on ids and names, and carries no archived lists.
    */
    async getFolders(spaceId, withLists = false) {
        const response = await throttledRequest({
            method: 'GET',
            url: `${BASE_URL}/space/${spaceId}/folder?archived=false`,
            headers: {
                'Authorization': store.get('settings.clickup_access_token'),
                'Content-Type': 'application/json'
            }
        });
        this.requests++; // count completed requests, not started ones
        const folders = JSON.parse(response.body).folders || [];
        return folders.map(folder => {
            const folderItem = factory.createFolder(folder);
            if (withLists && Array.isArray(folder.lists) && folder.lists.length > 0) {
                folderItem.addChildren(folder.lists.map(list => factory.createList(list)));
            }
            return folderItem;
        });
    },

    /*
    * Get all lists from a folder
    */
    async getFolderedLists(FolderId) {
        const response = await throttledRequest({
            method: 'GET',
            url: `${BASE_URL}/folder/${FolderId}/list?archived=false`,
            headers: {
                'Authorization': store.get('settings.clickup_access_token'),
                'Content-Type': 'application/json'
            }
        });
        this.requests++; // count completed requests, not started ones
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
        const response = await throttledRequest({
            method: 'GET',
            mode: 'no-cors',
            url: `${BASE_URL}/space/${spaceId}/list?archived=false`,
            headers: {
                'Authorization': store.get('settings.clickup_access_token'),
                'Content-Type': 'application/json'
            }
        });
        this.requests++; // count completed requests, not started ones
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
                this.requests++; // count completed requests, not started ones
                const results = JSON.parse(response.body).tasks || [];

                tasks.push(...results);
                hasMore = results.length === CLICKUP_TASKS_PER_PAGE; // Continue if the page is full
                page++;

            } catch (e) {
                console.error(`Error fetching tasks for page ${page}:`, e);
                this.failedFetches++; // A half-fetched list is truncation too
                hasMore = false; // Stop on error
            }
        }

        return this._assignSubtasksToParentTasks(tasks);
    },

    async getTask(taskId, raw = false) {
        return this._fetchTaskById(taskId, {raw, useCustomId: false});
    },

    async getTaskByCustomId(customId, raw = false) {
        return this._fetchTaskById(customId, {raw, useCustomId: true});
    },

    async _fetchTaskById(taskId, {raw = false, useCustomId = false} = {}) {
        const qs = {
            include_subtasks: true,
            include_markdown_description: false,
        };
        if (useCustomId) {
            qs.custom_task_ids = true;
            qs.team_id = store.get('settings.clickup_team_id');
        }

        return new Promise((resolve, reject) => {
            request({
                method: 'GET',
                mode: 'no-cors',
                url: `${BASE_URL}/task/${taskId}`,
                qs,
                headers: {
                    'Authorization': store.get('settings.clickup_access_token'),
                    'Content-Type': 'application/json'
                }
            }, (error, response) => {
                if (error) return reject(error);
                const body = JSON.parse(response.body) || {};
                // ClickUp returns {err, ECODE} when not found. Treat as null instead of rejecting.
                if (body.err) return resolve(null);
                resolve(body);
            });
        }).then(task => {
            if (!task) return null;
            if (!raw) {
                task = factory.createTask(task);
            }
            return task;
        }).catch(e => {
            console.error(e);
            return null;
        });
    },

    /*
     * Fetch the most recently updated team tasks (first page only).
     * Used as a fallback search source when a query yields zero local matches.
     */
    async getRecentTeamTasks(limit = 50) {
        return new Promise((resolve, reject) => {
            request({
                method: 'GET',
                url: `${teamRootUrl()}/task`,
                qs: {
                    page: 0,
                    order_by: 'updated',
                    include_closed: true,
                    subtasks: true,
                },
                headers: {
                    'Authorization': store.get('settings.clickup_access_token'),
                    'Content-Type': 'application/json'
                },
                timeout: DEFAULT_CLICKUP_TIMEOUT,
            }, (error, response) => {
                if (error) return reject(error);
                const body = JSON.parse(response.body) || {};
                const tasks = body.tasks || [];
                resolve(tasks.slice(0, limit));
            });
        }).catch(e => {
            console.error('getRecentTeamTasks failed:', e);
            return [];
        });
    },

    async getListStatuses(listId) {
        return new Promise((resolve, reject) => {
            request({
                method: 'GET',
                url: `${BASE_URL}/list/${listId}`,
                headers: {
                    'Authorization': store.get('settings.clickup_access_token'),
                    'Content-Type': 'application/json'
                },
                timeout: DEFAULT_CLICKUP_TIMEOUT,
            }, (error, response) => {
                if (error) return reject(error)
                const list = JSON.parse(response.body)
                resolve(list.statuses || [])
            });
        })
    },

    createClickUpTask(listId, name, assignees = [], status = null) {
        const startTime = performance.now();
        const url = `${BASE_URL}/list/${listId}/task`;

        return new Promise((resolve, reject) => {
            request({
                method: 'POST',
                url: url,
                headers: {
                    'Authorization': store.get('settings.clickup_access_token'),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name,
                    assignees,
                    ...(status && {status}),
                }),
                timeout: DEFAULT_CLICKUP_TIMEOUT,
            }, (error, response) => {
                const elapsed = (performance.now() - startTime).toFixed(2);
                console.log(`[API TIMING] POST ${url} - ${elapsed}ms`);

                if (error) return reject(error)
                const body = JSON.parse(response.body)

                if (body.err) {
                    return reject(body.err)
                }

                resolve(body)
            })
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
                include_location_names: true,
            }

            if (space_id) params.space_id = space_id;
            if (folder_id) params.folder_id = folder_id;
            if (list_id) params.list_id = list_id;
            if (task_id) params.task_id = task_id;
            if (userId) params.assignee = userId;

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
