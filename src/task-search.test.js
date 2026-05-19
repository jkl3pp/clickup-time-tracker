import {describe, it, expect} from 'vitest';
import {searchTasks} from './task-search.js';

function makeTasks(names) {
    return names.map((name, index) => ({
        id: `task-${index}`,
        name,
        custom_id: null,
        disable: false,
    }));
}

function namesMatched(tasks, result) {
    const ids = new Set([...result.exact, ...result.fuzzy]);
    return tasks.filter(t => ids.has(t.id)).map(t => t.name);
}

describe('searchTasks: exact multi-token', () => {
    it('matches all tokens as substrings regardless of order', () => {
        const tasks = makeTasks([
            'Réunion avec Nicolas',
            'Nicolas est présent',
            'Sprint planning',
        ]);
        const result = searchTasks(tasks, 'Reunion Nico');
        expect(namesMatched(tasks, result)).toEqual(['Réunion avec Nicolas']);
        expect(result.exact.size).toBe(1);
    });

    it('is accent-insensitive', () => {
        const tasks = makeTasks(['Réunion stratégique', 'Autre chose']);
        const result = searchTasks(tasks, 'reunion');
        expect(result.exact.has('task-0')).toBe(true);
    });

    it('is case-insensitive', () => {
        const tasks = makeTasks(['Réunion Nicolas']);
        const result = searchTasks(tasks, 'NICOLAS');
        expect(result.exact.has('task-0')).toBe(true);
    });
});

describe('searchTasks: fuzzy (typos)', () => {
    it('matches "ncio" to "Nico" (transposition)', () => {
        const tasks = makeTasks(['Nico', 'Autre']);
        const result = searchTasks(tasks, 'ncio');
        expect(result.fuzzy.has('task-0')).toBe(true);
    });

    it('matches "ncio" to "Nicolas" (window inside longer word)', () => {
        const tasks = makeTasks(['Nicolas', 'Autre']);
        const result = searchTasks(tasks, 'ncio');
        expect(result.fuzzy.has('task-0')).toBe(true);
    });

    it('does NOT match "ncio" to "fonctionne"', () => {
        const tasks = makeTasks(['La recherche fonctionne']);
        const result = searchTasks(tasks, 'ncio');
        expect(result.fuzzy.has('task-0')).toBe(false);
        expect(result.exact.has('task-0')).toBe(false);
    });

    it('does NOT match "ncio" to "incohérence"', () => {
        const tasks = makeTasks(['Bug incohérence']);
        const result = searchTasks(tasks, 'ncio');
        expect(result.fuzzy.has('task-0')).toBe(false);
        expect(result.exact.has('task-0')).toBe(false);
    });

    it('does NOT match "ncio" to "fonctionnement"', () => {
        const tasks = makeTasks(['Améliorer fonctionnement']);
        const result = searchTasks(tasks, 'ncio');
        expect(result.fuzzy.has('task-0')).toBe(false);
    });

    it('does NOT match "ncio" to "d\'incohérence" (apostrophe word)', () => {
        const tasks = makeTasks(["Bug d'incohérence détecté"]);
        const result = searchTasks(tasks, 'ncio');
        expect(result.fuzzy.has('task-0')).toBe(false);
    });

    it('does NOT match "ncio" to "Incohérence"', () => {
        const tasks = makeTasks(['Incohérence de données']);
        const result = searchTasks(tasks, 'ncio');
        expect(result.fuzzy.has('task-0')).toBe(false);
    });

    it('does NOT match "ncio" to a variety of unrelated words', () => {
        const tasks = makeTasks([
            'Conception sprint 9',
            'Une notion importante',
            'Correction minuscule',
            'Opinion tranchée',
            'Version finale',
        ]);
        const result = searchTasks(tasks, 'ncio');
        expect(result.fuzzy.size).toBe(0);
        expect(result.exact.size).toBe(0);
    });

    it('does NOT match "ncio" to words with mid-word "ncio"-like windows', () => {
        const tasks = makeTasks([
            "renvoi sur l'ancien site",
            'Importer les bilans comptable anciens',
            'Pas de city pour le reverse San Francisco ?',
            'Nouvelle convention nommage de commits',
            'sentry monitoring',
        ]);
        const result = searchTasks(tasks, 'ncio');
        expect(result.fuzzy.size).toBe(0);
        expect(result.exact.size).toBe(0);
    });
});

describe('searchTasks: ordering contract', () => {
    it('exact matches take precedence over fuzzy', () => {
        const tasks = makeTasks(['Nico', 'Ncio direct']);
        const result = searchTasks(tasks, 'ncio');
        // "Ncio direct" has "ncio" as substring, so it matches exact.
        // "Nico" is a transposition, so it matches fuzzy.
        expect(result.exact.has('task-1')).toBe(true);
        expect(result.fuzzy.has('task-0')).toBe(true);
    });
});

describe('searchTasks: edge cases', () => {
    it('returns empty sets for empty query', () => {
        const tasks = makeTasks(['Anything']);
        const result = searchTasks(tasks, '');
        expect(result.exact.size).toBe(0);
        expect(result.fuzzy.size).toBe(0);
    });

    it('skips fuzzy for tokens under 4 chars', () => {
        const tasks = makeTasks(['Reunion avec Nico']);
        // "nic" (3 chars) would be too permissive for fuzzy
        const result = searchTasks(tasks, 'nic');
        // substring match still works: "nic" is in "nico"
        expect(result.exact.has('task-0')).toBe(true);
    });

    it('matches custom_id exact', () => {
        const tasks = [{id: '1', name: 'Something', custom_id: 'ALP-86', disable: false}];
        const result = searchTasks(tasks, 'ALP-86');
        expect(result.exact.has('1')).toBe(true);
    });
});
