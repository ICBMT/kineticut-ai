/**
 * Layout engines.
 *
 * Every engine returns a flat Float32Array of [x, y, z] triplets indexed by
 * node index. The 3D scene simply animates towards whatever this produces, so
 * switching layout is a smooth morph rather than a jump.
 */

const TIER_HEIGHT = 104; // keep in sync with LayoutStage::TIER_HEIGHT

/** The default: the server-computed architectural decks. */
/**
 * Vertical order of the architectural decks — the same order the PHP side uses
 * for `App\Enums\Layer::tierSlot()`, so switching from the layer view to
 * modules or spiral keeps each node on its own tier.
 *
 * The client payload carries the layer *slug* but not its tier, and reading
 * `node.layerTier` here silently produced `undefined` for every node: modules
 * collapsed onto one plane (a flat ring) and spiral's "layer, then importance"
 * sort did nothing. Resolve the tier from the slug instead.
 */
const LAYER_TIERS = {
    entry: 0,
    http: 1,
    application: 2,
    view: 3,
    domain: 4,
    data: 5,
    infrastructure: 6,
    test: 7,
    structure: 8,
    external: 9,
};

const tierOf = (node) => LAYER_TIERS[node?.layer] ?? 8;

export function layersLayout(nodes) {
    const positions = new Float32Array(nodes.length * 3);

    nodes.forEach((node, index) => {
        positions[index * 3] = node.x;
        positions[index * 3 + 1] = node.y;
        positions[index * 3 + 2] = node.z;
    });

    return positions;
}

/**
 * One helix, ordered by layer then importance — reads like a DNA strand.
 *
 * The rungs are sized to the graph rather than fixed: the old version spread
 * 130 nodes across a 150px-tall column at a 210px radius, which read as a flat
 * disc seen from above and buried every label in the middle. A fixed vertical
 * pitch and a radius that grows with the strand keep the nodes a comfortable
 * distance apart whatever the project's size.
 */
export function spiralLayout(nodes) {
    const positions = new Float32Array(nodes.length * 3);
    const ordered = [...nodes].sort((a, b) => (tierOf(a) - tierOf(b)) || (b.weight - a.weight));

    const count = ordered.length;
    // ~26px of strand per node, capped so a huge graph stays navigable.
    const height = Math.min(2400, Math.max(420, count * 26));
    const radius = Math.min(420, Math.max(190, 120 + count * 0.9));
    const turns = Math.max(2, Math.min(9, count / 34));

    ordered.forEach((node, index) => {
        const t = count > 1 ? index / (count - 1) : 0;
        const angle = t * Math.PI * 2 * turns;

        positions[node.index * 3] = Math.cos(angle) * radius;
        positions[node.index * 3 + 1] = (0.5 - t) * height;
        positions[node.index * 3 + 2] = Math.sin(angle) * radius;
    });

    return positions;
}

/** Cluster by module: one disc per module, arranged on a big circle. */
/**
 * Cluster by module: one disc per module, arranged on a ring.
 *
 * The ring is sized from the clusters it has to hold, not from the module
 * *count*. `120 + modules * 26` ignored how big each cluster was, so a project
 * with a few large modules pushed its discs straight through each other and the
 * camera fitted a ring that ran off the stage. Layers are still kept as height,
 * so this view answers "which module owns what" without losing "which layer it
 * belongs to".
 */
export function modulesLayout(nodes) {
    const positions = new Float32Array(nodes.length * 3);
    const groups = new Map();

    nodes.forEach((node) => {
        const key = node.module ?? 'App';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(node);
    });

    const modules = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

    // Radius a cluster needs, from the golden-angle packing of its members.
    const clusterRadius = (size) => 30 + Math.sqrt(Math.max(1, size)) * 17;

    /*
     * Pack the discs outward from the centre, biggest first.
     *
     * A fixed ring has to be wide enough for its two widest neighbours — one
     * fat cluster beside another pushed the ring's radius out for every cluster
     * on it, and on a real project that inflated the map to 3 300px across.
     * Walking a golden-angle spiral and taking the first spot that clears every
     * disc already placed keeps the module map compact whatever the mix of
     * cluster sizes is, and leaves the reader's eye a clear gap between groups.
     */
    const placed = [];
    const clearance = 1.14;

    modules.forEach(([, members]) => {
        const radius = clusterRadius(members.length);

        if (placed.length === 0) {
            placed.push({ x: 0, z: 0, radius });

            return;
        }

        let spot = { x: 0, z: 0 };

        for (let attempt = 1; attempt < 4000; attempt++) {
            const angle = attempt * 2.399963;
            const distance = Math.sqrt(attempt) * 26;

            spot = { x: Math.cos(angle) * distance, z: Math.sin(angle) * distance };

            const clear = placed.every((other) => Math.hypot(spot.x - other.x, spot.z - other.z) >= (radius + other.radius) * clearance);

            if (clear) break;
        }

        placed.push({ ...spot, radius });
    });

    const tierHeight = 96;

    modules.forEach(([, members], groupIndex) => {
        const cx = placed[groupIndex].x;
        const cz = placed[groupIndex].z;
        const inner = clusterRadius(members.length);

        // Highest weight first as the anchor, the rest spiral out around it.
        const orderedMembers = [...members].sort((a, b) => b.weight - a.weight);

        orderedMembers.forEach((node, index) => {
            const phi = index * 2.399963;
            // `+ 0.75` keeps the anchor node off the exact centre, so it is never
            // sitting on top of the first node to spiral out around it.
            const r = inner * Math.sqrt((index + 0.75) / (orderedMembers.length + 0.75));

            positions[node.index * 3] = cx + Math.cos(phi) * r;
            positions[node.index * 3 + 1] = tierOf(node) * tierHeight;
            positions[node.index * 3 + 2] = cz + Math.sin(phi) * r;
        });
    });

    return positions;
}

/**
 * @param  string  $mode  `layers`, `modules` or `spiral`. Anything else — an
 *         unknown value, or a `?layout=` link from before a mode was retired —
 *         falls through to the architectural decks rather than throwing.
 */
export function computeLayout(mode, nodes, edges, visible) {
    switch (mode) {
        case 'modules':
            return modulesLayout(nodes);
        case 'spiral':
            return spiralLayout(nodes);
        default:
            return layersLayout(nodes);
    }
}

export { TIER_HEIGHT };
