import removeAccents from 'remove-accents';

const MIN_FUZZY_TOKEN_LENGTH = 4;

export function normalize(value) {
    if (value === null || value === undefined) return '';
    return removeAccents(String(value).toLowerCase()).trim();
}

export function flattenTasks(tree) {
    const tasks = [];
    walkTree(tree, tasks);
    return tasks;
}

function walkTree(items, accumulator) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
        if (item.disable === false) {
            accumulator.push(item);
        }
        if (item.children) {
            walkTree(item.children, accumulator);
        }
    }
}

function tokenize(query) {
    return normalize(query).split(/\s+/).filter(Boolean);
}

function searchableHaystack(task) {
    return normalize(`${task.name || ''} ${task.custom_id || ''} ${task.id || ''}`);
}

function taskWords(task) {
    return normalize(`${task.name || ''} ${task.custom_id || ''}`)
        .split(/\s+/)
        .filter(word => word.length >= 2);
}

function allowedDistance(tokenLength) {
    if (tokenLength <= 4) return 1;
    if (tokenLength <= 7) return 2;
    return 3;
}

function damerauLevenshtein(a, b) {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    const dp = Array.from({length: m + 1}, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost,
            );
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
            }
        }
    }
    return dp[m][n];
}

function tokenMatchesAnyWord(token, words) {
    const maxDist = allowedDistance(token.length);
    for (const word of words) {
        // Same-length-ish: direct word comparison.
        if (Math.abs(word.length - token.length) <= maxDist) {
            if (damerauLevenshtein(token, word) <= maxDist) return true;
        }
        // Longer word: allow the token to match only the PREFIX of the word.
        // This catches "ncio" against "Nicolas" (prefix "nico") without matching
        // arbitrary mid-word substrings like "ancien", "convention" or "Francisco".
        if (word.length > token.length) {
            const prefix = word.substring(0, token.length);
            if (damerauLevenshtein(token, prefix) <= maxDist) return true;
        }
    }
    return false;
}

export function searchTasks(tasks, query) {
    const exact = new Set();
    const fuzzy = new Set();

    const tokens = tokenize(query);
    if (tokens.length === 0) {
        return {exact, fuzzy};
    }

    const remainingForFuzzy = [];
    for (const task of tasks) {
        const haystack = searchableHaystack(task);
        const matchesAllTokens = tokens.every(token => haystack.includes(token));
        if (matchesAllTokens) {
            exact.add(task.id);
        } else {
            remainingForFuzzy.push(task);
        }
    }

    const anyTokenTooShort = tokens.some(token => token.length < MIN_FUZZY_TOKEN_LENGTH);
    if (anyTokenTooShort) {
        return {exact, fuzzy};
    }

    for (const task of remainingForFuzzy) {
        const words = taskWords(task);
        const allTokensMatch = tokens.every(token => tokenMatchesAnyWord(token, words));
        if (allTokensMatch) {
            fuzzy.add(task.id);
        }
    }

    return {exact, fuzzy};
}
