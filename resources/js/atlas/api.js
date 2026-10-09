/**
 * Thin JSON client for the AtlasScope API.
 */
export function createApi(root) {
    const url = (name) => root.dataset[name];

    /*
     * `soft` is for the one endpoint that answers "there is nothing to draw
     * yet" with a status rather than a body: `graph()` replies 202 while a scan
     * is still running and reads `ready` out of that. Everywhere else a 404 is
     * a genuine "no such thing" — swallowing it handed the inspector an error
     * payload (`{error: 'Node not found.'}`) as if it were a node, and it threw
     * on the first field that was missing.
     */
    const get = async (endpoint, params = {}, { soft = false } = {}) => {
        const target = new URL(endpoint, window.location.origin);

        Object.entries(params).forEach(([key, value]) => {
            if (value !== null && value !== undefined && value !== '') {
                target.searchParams.set(key, value);
            }
        });

        const response = await fetch(target, {
            headers: { Accept: 'application/json' },
            credentials: 'same-origin',
        });

        if (soft && (response.status === 202 || response.status === 404)) {
            return response.json().catch(() => ({ ready: false }));
        }

        if (!response.ok) {
            throw new Error(`Request failed (${response.status}) for ${target.pathname}`);
        }

        return response.json();
    };

    return {
        graph: () => get(url('graphUrl'), {}, { soft: true }),
        status: () => get(url('statusUrl')),
        events: (after = 0) => get(url('eventsUrl'), { after }),
        node: (key) => get(url('nodeUrl').replace('__KEY__', encodeURIComponent(key).replace(/%2F/gi, '/'))),
        file: (path, from = 0, to = 0) => get(url('fileUrl'), { path, from, to }),
        exportUrl: () => url('exportUrl'),
        projectUrl: () => url('projectUrl'),
    };
}
