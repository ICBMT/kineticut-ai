import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

/**
 * The 3D observatory renderer.
 *
 * Design goals, in order:
 *   1. Legibility — related code clusters, layers read top-to-bottom, labels
 *      appear exactly where they help.
 *   2. Performance — nodes are drawn with a handful of InstancedMeshes and
 *      every edge lives in one buffer, so thousands of nodes stay smooth.
 *   3. Feel — smooth morphing between layouts, glow, particles along traced
 *      request journeys.
 */

const GEOMETRY_BY_TYPE = {
    model: 'box',
    table: 'disc',
    migration: 'disc',
    route: 'octa',
    controller: 'ico',
    middleware: 'ico',
    service: 'ico',
    action: 'ico',
    policy: 'ico',
    request: 'card',
    resource: 'card',
    view: 'card',
    component: 'card',
    test: 'tetra',
    job: 'tetra',
    event: 'tetra',
    listener: 'tetra',
    notification: 'tetra',
    mailable: 'tetra',
    livewire: 'ico',
};

/*
 * The three tiers differ in *definition*, not just in how much there is.
 *
 *   samples        MSAA on the post-processing buffers. The renderer's own
 *                  `antialias` flag does nothing once a composer is in the
 *                  chain — EffectComposer allocates its buffers without
 *                  multisampling — so bloom without `samples` was drawing every
 *                  silhouette with a stair-stepped edge.
 *   bloom*         Threshold, radius and strength. A low threshold blooms the
 *                  whole scene and lifts every dark shape into the haze around
 *                  it; a high one blooms only what is genuinely bright. The
 *                  tighter radius keeps the glow around a node instead of
 *                  smearing it across its neighbours.
 *   labelBoost     Label textures are drawn at `devicePixelRatio * labelBoost`.
 *                  Sprites are rescaled by distance, so a label that is
 *                  magnified on screen needs pixels that were never there —
 *                  this is the difference between legible text and a smear.
 *   edgeWidth      Relationship lines are fat lines measured in CSS pixels, so
 *                  they stay the same weight at every zoom and get the shader's
 *                  own edge feathering. `edgeOpacity` compensates for the extra
 *                  pixels an additive line now covers.
 */
const QUALITY = {
    high: {
        pixelRatio: 2, bloom: true, glow: 1, labels: 46, starfield: 1400,
        samples: 4,
        bloomStrength: 0.55, bloomRadius: 0.42, bloomThreshold: 0.5,
        labelBoost: 1.5,
        edgeWidth: 2, edgeOpacity: 0.34,
    },
    balanced: {
        pixelRatio: 1.5, bloom: false, glow: 0.85, labels: 30, starfield: 900,
        samples: 4,
        bloomStrength: 0.5, bloomRadius: 0.4, bloomThreshold: 0.55,
        labelBoost: 1.25,
        edgeWidth: 1.7, edgeOpacity: 0.32,
    },
    performance: {
        pixelRatio: 1, bloom: false, glow: 0.6, labels: 14, starfield: 420,
        samples: 0,
        bloomStrength: 0.5, bloomRadius: 0.4, bloomThreshold: 0.6,
        labelBoost: 1,
        edgeWidth: 1.3, edgeOpacity: 0.3,
    },
};

const tmpMatrix = new THREE.Matrix4();
const tmpColor = new THREE.Color();
const tmpVector = new THREE.Vector3();
const tmpVector2 = new THREE.Vector3();

export class AtlasScene {
    constructor(canvas, callbacks = {}) {
        this.canvas = canvas;
        this.callbacks = callbacks;
        // Called with (progress 0..1, moving) while a layout switch animates.
        this.onLayoutProgress = callbacks.onLayoutProgress ?? null;
        this.quality = 'high';
        this.labelsEnabled = true;
        this.matricesDirty = true;
        this.decks = [];

        // Focus mode: when something is selected, everything unrelated to it is
        // dimmed so the selection and its neighbours are the only bright things
        // on screen. `focusMix` animates 0 → 1 so the change is not a hard cut.
        this.focusEnabled = true;
        this.focusKeys = new Set();
        this.tracePath = null;
        this.tracePathSet = new Set();
        this.traceEdgeKeys = new Set();
        this.focusMix = 0;
        this.focusTarget = 0;
        this.adjacency = new Map();
        this.autoRotate = false;

        this.nodes = [];
        this.edges = [];
        this.indexByKey = new Map();
        this.groups = new Map();

        this.current = null;
        this.target = null;
        this.scales = null;
        this.targetScales = null;
        this.dirty = false;

        this.hovered = -1;
        this.primary = null;
        this.highlightKeys = new Set();

        this.labelSprites = new Map();
        this.labelPool = [];

        this.pointer = new THREE.Vector2(-10, -10);
        this.raycaster = new THREE.Raycaster();
        this.lastPick = 0;
        this.frames = 0;
        this.lastFps = performance.now();
        this.clock = new THREE.Clock();
        this.cameraTween = null;
        this.traceParticles = null;

        this.#initThree();
        this.#bindEvents();
        this.#loop();
    }

    /* ------------------------------------------------------------- setup -- */

    #initThree() {
        const preset = QUALITY[this.quality];

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            alpha: true,
            powerPreference: 'high-performance',
        });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatio));
        this.renderer.setClearAlpha(0);
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.12;

        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.FogExp2(0x05070d, 0.00062);

        this.camera = new THREE.PerspectiveCamera(48, 1, 1, 12000);
        this.camera.position.set(420, 300, 620);

        this.controls = new OrbitControls(this.camera, this.canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.085;
        this.controls.rotateSpeed = 0.5;
        this.controls.zoomSpeed = 0.62;
        this.controls.panSpeed = 0.72;
        this.controls.minDistance = 40;
        this.controls.maxDistance = 5200;
        this.controls.maxPolarAngle = Math.PI * 0.92;
        this.controls.autoRotateSpeed = 0.42;
        // Zoom towards the pointer instead of the screen centre, and pan in the
        // plane you are looking at — both make the atlas feel like an object
        // rather than a camera on rails.
        this.controls.zoomToCursor = true;
        this.controls.screenSpacePanning = true;

        // A trackpad pinch arrives as ctrl+wheel. Letting it through would zoom
        // the whole page mid-orbit, which reads as the site "jumping".
        this.canvas.addEventListener('wheel', (event) => {
            if (event.ctrlKey) event.preventDefault();
        }, { passive: false });

        // The moment the user grabs the camera, any scripted move is abandoned:
        // a tween fighting a drag is the other half of that jumping feeling.
        this.controls.addEventListener('start', () => {
            this.cameraTween = null;
            this.interacting = true;
        });
        this.controls.addEventListener('end', () => {
            this.interacting = false;
        });

        this.scene.add(new THREE.HemisphereLight(0x9fd4ff, 0x0a1020, 1.05));

        const key = new THREE.DirectionalLight(0xffffff, 0.95);
        key.position.set(320, 620, 280);
        this.scene.add(key);

        const rim = new THREE.DirectionalLight(0x6ad0ff, 0.5);
        rim.position.set(-420, -180, -360);
        this.scene.add(rim);

        const warm = new THREE.DirectionalLight(0xffd9a0, 0.22);
        warm.position.set(-260, 240, 420);
        this.scene.add(warm);

        this.deckGroup = new THREE.Group();
        this.nodeGroup = new THREE.Group();
        this.edgeGroup = new THREE.Group();
        this.labelGroup = new THREE.Group();
        this.overlayGroup = new THREE.Group();

        this.scene.add(this.starfield());
        this.scene.add(this.deckGroup, this.edgeGroup, this.nodeGroup, this.labelGroup, this.overlayGroup);

        this.glowTexture = this.#radialTexture(128, 0.06, 0.55);

        // selection furniture
        this.selectionRing = new THREE.Mesh(
            new THREE.TorusGeometry(1.7, 0.042, 12, 96),
            new THREE.MeshBasicMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.95 })
        );
        this.selectionRing.rotation.x = Math.PI / 2;
        this.selectionRing.visible = false;
        this.overlayGroup.add(this.selectionRing);

        this.haloSprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: this.#radialTexture(128, 0.02, 0.42),
            color: 0x8fd0ff,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        }));
        this.haloSprite.scale.set(12, 12, 1);
        this.haloSprite.visible = false;
        this.overlayGroup.add(this.haloSprite);

        this.hoverRing = new THREE.Mesh(
            new THREE.TorusGeometry(1.9, 0.018, 10, 96),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })
        );
        this.hoverRing.rotation.x = Math.PI / 2;
        this.hoverRing.visible = false;
        this.overlayGroup.add(this.hoverRing);

        // fat lines for the selected / traced relationships
        this.highlightMaterial = new LineMaterial({
            linewidth: 2.6,
            vertexColors: true,
            transparent: true,
            opacity: 0.96,
            dashed: false,
            // Same feathered coverage as the relationship lines, so a traced
            // path has the same clean edge where it crosses a node.
            alphaToCoverage: true,
            resolution: new THREE.Vector2(1, 1),
        });
        this.highlightLines = null;

        this.#setupComposer();
        this.resize();
    }

    /**
     * A composer buffer for the current tier.
     *
     * EffectComposer's default target is allocated with no `samples`, so the
     * `antialias: true` on the renderer — which does not apply to a render
     * target — was silently doing nothing on this path, and every node edge
     * drawn through bloom came out aliased. Handing it a multisampled target is
     * what makes the presets look as smooth as the direct path, and `samples`
     * is fixed when the buffer is allocated, which is why switching tier has to
     * hand the composer fresh buffers.
     */
    #composerTarget(size) {
        const target = new THREE.WebGLRenderTarget(size.x, size.y, {
            type: THREE.HalfFloatType,
            samples: QUALITY[this.quality].samples,
        });
        target.texture.name = 'atlas.composer';

        return target;
    }

    /** Reallocate the composer buffers when the tier's sample count changes. */
    #syncComposerSamples() {
        const samples = QUALITY[this.quality].samples;

        if (!this.composer || this.composer.renderTarget1.samples === samples) return;

        const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());

        ['renderTarget1', 'renderTarget2'].forEach((key) => {
            this.composer[key].dispose();
            this.composer[key] = this.#composerTarget(size);
        });

        this.resize();
    }

    #setupComposer() {
        const preset = QUALITY[this.quality];
        const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
        const target = this.#composerTarget(size);

        this.composer = new EffectComposer(this.renderer, target);
        this.composer.addPass(new RenderPass(this.scene, this.camera));

        // Bloom is additive light: a low threshold lifts the whole frame and
        // turns crisp shapes into a haze, so it is tuned to catch only what is
        // actually bright and to fall off close to it.
        this.bloomBase = preset.bloomStrength;
        this.bloom = new UnrealBloomPass(
            new THREE.Vector2(size.x, size.y),
            preset.bloomStrength,
            preset.bloomRadius,
            preset.bloomThreshold,
        );
        this.composer.addPass(this.bloom);
        this.composer.addPass(new OutputPass());
    }

    starfield() {
        const preset = QUALITY[this.quality];
        const count = preset.starfield;
        const positions = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);

        for (let i = 0; i < count; i++) {
            const radius = 1400 + Math.random() * 3600;
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);

            positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = radius * Math.cos(phi) * 0.6;
            positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);

            const tint = 0.4 + Math.random() * 0.6;
            colors[i * 3] = tint * 0.6;
            colors[i * 3 + 1] = tint * 0.8;
            colors[i * 3 + 2] = tint;
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        this.starPoints = new THREE.Points(geometry, new THREE.PointsMaterial({
            size: 3.4,
            vertexColors: true,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
            sizeAttenuation: true,
            map: this.#radialTexture(64, 0.02, 0.5),
            blending: THREE.AdditiveBlending,
        }));

        return this.starPoints;
    }

    #radialTexture(size, inner, mid) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const context = canvas.getContext('2d');
        const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);

        gradient.addColorStop(0, `rgba(255,255,255,${1 - inner})`);
        gradient.addColorStop(inner + 0.1, `rgba(255,255,255,${mid})`);
        gradient.addColorStop(1, 'rgba(255,255,255,0)');

        context.fillStyle = gradient;
        context.fillRect(0, 0, size, size);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;

        return texture;
    }

    /* ------------------------------------------------------------- graph -- */

    setGraph(graph) {
        this.disposeGraph();

        this.nodes = graph.nodes;
        this.edges = graph.edges;
        this.indexByKey = new Map();

        this.adjacency = new Map();

        this.nodes.forEach((node, index) => {
            node.index = index;
            this.indexByKey.set(node.key, node);
            this.adjacency.set(node.key, new Set());
        });

        this.edges.forEach((edge) => {
            this.adjacency.get(edge.source)?.add(edge.target);
            this.adjacency.get(edge.target)?.add(edge.source);
        });

        this.current = new Float32Array(this.nodes.length * 3);
        this.target = new Float32Array(this.nodes.length * 3);
        this.scales = new Float32Array(this.nodes.length);
        this.targetScales = new Float32Array(this.nodes.length);

        this.nodes.forEach((node, index) => {
            this.current[index * 3] = node.x;
            this.current[index * 3 + 1] = node.y;
            this.current[index * 3 + 2] = node.z;
            this.target[index * 3] = node.x;
            this.target[index * 3 + 1] = node.y;
            this.target[index * 3 + 2] = node.z;
            this.scales[index] = 1;
            this.targetScales[index] = 1;
        });

        this.#buildNodeMeshes();
        this.matricesDirty = true;
        this.#buildGlow();
        this.#buildEdges();
        this.#buildDecks(graph);
        this.dirty = true;
    }

    /*
     * One geometry per shape, shared by every node that uses it — an instanced
     * draw, so the tessellation is paid once and not per node. The subdivision
     * levels are set so a silhouette reads as a curve rather than a polygon:
     * the sphere is 80 faces instead of 20, the disc 48 sides instead of 26.
     * The crystal shapes (octahedron, tetrahedron) keep their hard facets on
     * purpose — a bevel there would read as a smudge, not as detail.
     */
    #geometryFor(kind) {
        switch (kind) {
            case 'box':
                return new THREE.BoxGeometry(1.5, 1.5, 1.5);
            case 'disc':
                return new THREE.CylinderGeometry(0.95, 0.95, 0.42, 48);
            case 'octa':
                return new THREE.OctahedronGeometry(1.1, 0);
            case 'tetra':
                return new THREE.TetrahedronGeometry(1.15, 0);
            case 'card':
                return new THREE.BoxGeometry(1.5, 1.0, 0.16);
            case 'ico':
            default:
                return new THREE.IcosahedronGeometry(0.92, 1);
        }
    }

    #buildNodeMeshes() {
        const buckets = new Map();
        this.nodeBaseColors = new Array(this.nodes.length);

        this.nodes.forEach((node) => {
            const kind = GEOMETRY_BY_TYPE[node.type] ?? 'ico';
            if (!buckets.has(kind)) buckets.set(kind, []);
            buckets.get(kind).push(node.index);
        });

        buckets.forEach((indexes, kind) => {
            const geometry = this.#geometryFor(kind);
            const material = new THREE.MeshStandardMaterial({
                roughness: 0.34,
                metalness: 0.22,
                envMapIntensity: 0.5,
                flatShading: kind === 'tetra' || kind === 'octa',
            });

            const mesh = new THREE.InstancedMesh(geometry, material, indexes.length);
            mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
            mesh.frustumCulled = false;

            indexes.forEach((nodeIndex, slot) => {
                tmpColor.set(this.nodes[nodeIndex].color ?? '#88a0c0');
                this.nodeBaseColors[nodeIndex] = tmpColor.clone();
                mesh.setColorAt(slot, tmpColor);
                tmpMatrix.makeScale(0, 0, 0);
                mesh.setMatrixAt(slot, tmpMatrix);
            });

            if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

            this.groups.set(kind, { mesh, indexes });
            this.nodeGroup.add(mesh);
        });
    }

    #buildGlow() {
        const positions = new Float32Array(this.nodes.length * 3);
        const colors = new Float32Array(this.nodes.length * 3);

        this.nodes.forEach((node, index) => {
            positions[index * 3] = node.x;
            positions[index * 3 + 1] = node.y;
            positions[index * 3 + 2] = node.z;

            tmpColor.set(node.color ?? '#88a0c0');
            colors[index * 3] = tmpColor.r;
            colors[index * 3 + 1] = tmpColor.g;
            colors[index * 3 + 2] = tmpColor.b;
        });

        this.glowBaseColors = colors.slice();

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));

        this.glowPoints = new THREE.Points(geometry, new THREE.PointsMaterial({
            size: 17,
            vertexColors: true,
            transparent: true,
            opacity: 0.5 * QUALITY[this.quality].glow,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            map: this.#radialTexture(128, 0.02, 0.4),
        }));
        this.glowPoints.frustumCulled = false;
        this.glowPoints.raycast = () => {};
        this.nodeGroup.add(this.glowPoints);
    }

    /*
     * Relationships are drawn as fat lines rather than GL_LINES.
     *
     * A core line is one device pixel wide, which both looks thin and fuzzy on a
     * high-density display and cannot be widened — `linewidth` is ignored by
     * every WebGL implementation. Fat lines are real geometry, so the width is
     * in screen pixels at any zoom, and the material feathers the edges in the
     * shader, which is the difference between a line that reads as a drawn
     * connection and one that reads as a smear.
     *
     * The geometry is built from the same 6-floats-per-segment layout the rest
     * of the class already writes into, and `setPositions`/`setColors` keep that
     * very array as their interleaved buffer — so the per-frame update path is
     * unchanged in cost: write floats, mark dirty.
     */
    #buildEdges() {
        const preset = QUALITY[this.quality];
        const count = this.edges.length;
        const positions = new Float32Array(count * 6);
        const colors = new Float32Array(count * 6);

        const position = (key) => {
            const node = this.indexByKey.get(key);

            if (!node) return [0, 0, 0];

            // `current` is where the node actually is, which is not where the
            // layout says it should be while a switch is still animating.
            return this.current
                ? [this.current[node.index * 3], this.current[node.index * 3 + 1], this.current[node.index * 3 + 2]]
                : [node.x, node.y, node.z];
        };

        this.edges.forEach((edge, index) => {
            const [sx, sy, sz] = position(edge.source);
            const [tx, ty, tz] = position(edge.target);

            positions.set([sx, sy, sz, tx, ty, tz], index * 6);

            const color = new THREE.Color(edge.color ?? '#4b6584');
            const intensity = Math.min(1, 0.45 + edge.weight / 6);

            colors.set([color.r * intensity, color.g * intensity, color.b * intensity,
                color.r * intensity, color.g * intensity, color.b * intensity], index * 6);
        });

        this.edgeBaseColors = colors.slice();
        this.edgePositions = positions;
        this.edgeColors = colors;

        const geometry = new LineSegmentsGeometry();
        geometry.setPositions(positions);
        geometry.setColors(colors);

        this.edgeBaseOpacity = preset.edgeOpacity;
        this.edgeMaterial = new LineMaterial({
            linewidth: preset.edgeWidth,
            vertexColors: true,
            transparent: true,
            opacity: preset.edgeOpacity,
            dashed: false,
            // The shader's own feathering plus MSAA coverage: lines that end
            // where they say they end, rather than dissolving into the deck.
            alphaToCoverage: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            resolution: new THREE.Vector2(...this.#viewport()),
        });

        this.edgeMesh = new LineSegments2(geometry, this.edgeMaterial);
        this.edgeMesh.frustumCulled = false;
        this.edgeMesh.raycast = () => {};
        this.edgeGroup.add(this.edgeMesh);
    }

    /**
     * The buffers the edge updaters write into.
     *
     * `LineSegmentsGeometry` keeps positions and colours as interleaved buffers
     * — six floats per segment, start then end — so these are the very arrays
     * uploaded to the GPU, and writing to them is writing to the geometry.
     */
    #edgePositions() {
        return this.edgePositions ?? null;
    }

    #edgeColors() {
        return this.edgeColors ?? null;
    }

    /** One translucent deck per architectural layer, ordered top to bottom. */
    #buildDecks(graph) {
        const tiers = new Map();
        this.decks = [];

        this.nodes.forEach((node) => {
            const entry = tiers.get(node.layer) ?? { y: node.y, color: node.color, radius: 0, label: node.layer_label, count: 0 };
            entry.radius = Math.max(entry.radius, Math.hypot(node.x, node.z));
            entry.count++;
            tiers.set(node.layer, entry);
        });

        tiers.forEach((info, layerKey) => {
            const radius = info.radius + 74;

            const disc = new THREE.Mesh(
                new THREE.CircleGeometry(radius, 72),
                new THREE.MeshBasicMaterial({
                    color: new THREE.Color(info.color ?? '#31405c'),
                    transparent: true,
                    opacity: 0.045,
                    side: THREE.DoubleSide,
                    depthWrite: false,
                })
            );
            disc.rotation.x = -Math.PI / 2;
            disc.position.y = info.y - 12;
            disc.raycast = () => {};
            this.deckGroup.add(disc);

            const ring = new THREE.Mesh(
                new THREE.RingGeometry(radius - 0.9, radius, 128),
                new THREE.MeshBasicMaterial({
                    color: new THREE.Color(info.color ?? '#31405c'),
                    transparent: true,
                    opacity: 0.3,
                    side: THREE.DoubleSide,
                    depthWrite: false,
                })
            );
            ring.rotation.x = -Math.PI / 2;
            ring.position.y = info.y - 12;
            ring.raycast = () => {};
            this.deckGroup.add(ring);

            const sprite = this.#makeLabel(`${info.label.toUpperCase()}  ·  ${info.count}`, info.color ?? '#8ea6c8', { scale: 0.62, opacity: 0.6 });

            // Anchor deck labels to the near-left rim, but never further out
            // than the stage can show — a very wide deck would otherwise push
            // its own label off screen.
            const offset = Math.min(radius * 0.74, 230);
            sprite.position.set(-offset, info.y + 26, offset);
            this.deckGroup.add(sprite);

            // Kept together so a deck that loses every node to a filter can be
            // hidden along with its rim and its label, and so focus mode can dim
            // the decks the selection does not touch.
            this.decks.push({
                layer: layerKey,
                parts: [disc, ring, sprite],
                baseOpacity: [disc.material.opacity, ring.material.opacity, sprite.material.opacity],
            });
        });
    }

    /* ---------------------------------------------------------- positions -- */

    setLayout(positions) {
        this.matricesDirty = true;

        this.target.set(positions);
        this.dirty = true;

        // Layout switches are a visible event, not just a uniform swap: the
        // nodes travel, and the UI shows that travel as a progress bar.
        this.layoutDistance = this.#remainingTravel();
        this.layoutProgress = this.layoutDistance > 0 ? 0 : 1;
        this.layoutMoving = this.layoutDistance > 0;
        this.#reportLayoutProgress(true);
    }

    /** Total distance every node still has to travel to reach its target. */
    #remainingTravel() {
        let total = 0;

        for (let index = 0; index < this.nodes.length; index++) {
            const base = index * 3;

            total += Math.abs(this.target[base] - this.current[base])
                + Math.abs(this.target[base + 1] - this.current[base + 1])
                + Math.abs(this.target[base + 2] - this.current[base + 2]);
        }

        return total;
    }

    /** Tell whoever is listening how far the morph has got, at 1% resolution. */
    #reportLayoutProgress(force = false) {
        if (!this.onLayoutProgress) return;

        const percent = Math.round((this.layoutProgress ?? 1) * 100);

        if (force || percent !== this.lastLayoutPercent) {
            this.lastLayoutPercent = percent;
            this.onLayoutProgress(this.layoutProgress ?? 1, this.layoutMoving === true);
        }
    }

    setVisibility(visibleNodes, visibleEdges) {
        this.matricesDirty = true;

        for (let index = 0; index < this.nodes.length; index++) {
            this.targetScales[index] = visibleNodes[index] ? 1 : 0;
        }

        // Edge visibility is tracked explicitly: a filtered-out edge is
        // collapsed onto a point and skipped by the geometry refresh, and it
        // has to be able to come back when the filter is removed again.
        if (!this.edgeHidden || this.edgeHidden.length !== this.edges.length) {
            this.edgeHidden = new Uint8Array(this.edges.length);
        }

        // A deck with nothing left on it is noise — drop it with its label.
        if (this.decks.length) {
            const populated = new Set();

            this.nodes.forEach((node) => {
                if (visibleNodes[node.index]) populated.add(node.layer);
            });

            this.decks.forEach((deck) => {
                const show = populated.has(deck.layer);

                deck.parts.forEach((part) => { part.visible = show; });
            });
        }

        const edgePositions = this.#edgePositions();

        this.edges.forEach((edge, index) => {
            const visible = visibleEdges[index] === 1;

            this.edgeHidden[index] = visible ? 0 : 1;

            if (!visible && edgePositions) {
                // collapse the segment onto a single point
                const x = edgePositions[index * 6];
                const y = edgePositions[index * 6 + 1];
                const z = edgePositions[index * 6 + 2];
                edgePositions.set([x, y, z, x, y, z], index * 6);
            }
        });

        this.#touchEdgePositions();
        this.dirty = true;
        this.#refreshEdgeGeometry();
        this.#refreshGlow();
    }

    /**
     * Edges are stored in one buffer. When nodes move we simply read the live
     * node positions back out, which keeps every relationship glued to its
     * endpoints no matter which layout is active.
     */
    #refreshEdgeGeometry() {
        const array = this.#edgePositions();

        if (!array) return;

        this.edges.forEach((edge, index) => {
            if (this.edgeHidden?.[index]) return;

            const sourceIndex = this.indexByKey.get(edge.source)?.index;
            const targetIndex = this.indexByKey.get(edge.target)?.index;

            if (sourceIndex === undefined || targetIndex === undefined) return;

            const base = index * 6;
            array[base] = this.current[sourceIndex * 3];
            array[base + 1] = this.current[sourceIndex * 3 + 1];
            array[base + 2] = this.current[sourceIndex * 3 + 2];
            array[base + 3] = this.current[targetIndex * 3];
            array[base + 4] = this.current[targetIndex * 3 + 1];
            array[base + 5] = this.current[targetIndex * 3 + 2];
        });

        this.#touchEdgePositions();

        this.#refreshGlow();
    }

    /**
     * Upload the edge buffers after an in-place write.
     *
     * The positions and colours live in `InstancedInterleavedBuffer`s that the
     * line geometry uploaded once, so `needsUpdate` on the buffer is what tells
     * the renderer to re-read them; there is nothing to recompute on the CPU.
     */
    #touchEdgePositions() {
        const positions = this.edgeMesh?.geometry?.attributes?.instanceStart?.data;

        if (positions) positions.needsUpdate = true;
    }

    #touchEdgeColors() {
        const colors = this.edgeMesh?.geometry?.attributes?.instanceColorStart?.data;

        if (colors) colors.needsUpdate = true;
    }

    /**
     * The glow layer is a single Points object covering every node, so a
     * filtered-out node has to be pushed out of the camera's reach explicitly —
     * otherwise the "hidden" nodes keep glowing on their deck.
     */
    #refreshGlow() {
        if (!this.glowPoints) return;

        const attribute = this.glowPoints.geometry.getAttribute('position');
        const array = attribute.array;

        for (let index = 0; index < this.nodes.length; index++) {
            const hidden = this.targetScales[index] < 0.5;

            array[index * 3] = hidden ? 0 : this.current[index * 3];
            array[index * 3 + 1] = hidden ? -1e6 : this.current[index * 3 + 1];
            array[index * 3 + 2] = hidden ? 0 : this.current[index * 3 + 2];
        }

        attribute.needsUpdate = true;
    }

    /* ------------------------------------------------------------- focus -- */

    /** Dim everything except the selection and everything it touches. */
    setFocusEnabled(enabled) {
        this.focusEnabled = enabled;
        this.#updateFocusTarget();

        return this.focusEnabled;
    }

    #updateFocusTarget() {
        this.focusTarget = this.focusEnabled && this.highlightKeys?.size > 0 ? 1 : 0;
    }

    /** The selection plus its direct neighbours. */
    #computeFocusKeys() {
        const keys = new Set();

        this.highlightKeys?.forEach((key) => {
            if (!this.indexByKey.has(key)) return;

            keys.add(key);
            this.adjacency.get(key)?.forEach((neighbour) => keys.add(neighbour));
        });

        // While a journey is being traced, the whole path stays lit.
        this.tracePath?.forEach((key) => keys.add(key));

        return keys;
    }

    /**
     * Tint the whole scene for a focus strength of 0 (everything lit) to 1
     * (only the focused cluster lit). Called a handful of times per transition,
     * so it works straight off the cached base colours.
     */
    #applyFocus(mix) {
        const focused = this.focusKeys;
        const dim = 1 - 0.8 * mix;

        /*
         * Three tiers while a journey is traced, not two.
         *
         * `focusKeys` is the path *plus every neighbour of every step*, which is
         * what makes a plain selection useful — you see what the thing you picked
         * touches. On a journey that same set is dozens of nodes hanging off six
         * steps, and lighting them all equally is what turned the traced chain
         * into one big bright slab. So: the chain gets the lift, its neighbours
         * recede to context, everything else is dimmed.
         */
        const chain = this.tracePath?.length ? this.tracePathSet : null;

        this.groups.forEach(({ mesh, indexes }) => {
            if (!mesh.instanceColor) return;

            indexes.forEach((nodeIndex, slot) => {
                const base = this.nodeBaseColors[nodeIndex];

                if (!base) return;

                const node = this.nodes[nodeIndex];
                const lit = focused.has(node.key);

                if (lit && (!chain || chain.has(node.key))) {
                    /*
                     * A modest lift. The old 1.3x plus a bloom pass turned a big
                     * focused cluster into a bright slab with no shape left in
                     * it — but the chain is only a handful of nodes, so it can
                     * afford more than the context around it.
                     */
                    tmpColor.copy(base).multiplyScalar(1 + 0.2 * mix).addScalar(0.03 * mix);
                } else if (lit) {
                    // Context: a neighbour of the chain, there to be recognised
                    // but not to compete with it.
                    tmpColor.copy(base).multiplyScalar(1 - 0.45 * mix);
                } else {
                    tmpColor.copy(base).multiplyScalar(dim);

                    /*
                     * Routes are the one node type allowed to give up its colour
                     * completely. There are dozens of them sitting on the same
                     * deck, so when one route is chosen the rest go grey and the
                     * chosen route — plus everything it reaches — is the only
                     * thing still reading as live.
                     */
                    if (node.type === 'route') {
                        this.#desaturate(tmpColor, mix);
                        // …and then pushed further back than everything else.
                        tmpColor.multiplyScalar(0.55);
                    }
                }

                mesh.setColorAt(slot, tmpColor);
            });

            mesh.instanceColor.needsUpdate = true;
        });

        if (this.glowPoints) {
            const attribute = this.glowPoints.geometry.getAttribute('color');
            const base = this.glowBaseColors;

            for (let index = 0; index < this.nodes.length; index++) {
                const node = this.nodes[index];
                const lit = focused.has(node.key);
                const onChain = !chain || chain.has(node.key);
                const factor = lit && onChain ? 1 + 0.14 * mix : (lit ? 1 - 0.5 * mix : dim * 0.85);

                let r = base[index * 3] * factor;
                let g = base[index * 3 + 1] * factor;
                let b = base[index * 3 + 2] * factor;

                // The bloom has to lose the hue too, or unfocused routes keep
                // glowing in colour through the dimming.
                if ((!lit || !onChain) && node.type === 'route' && !focused.has(node.key)) {
                    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;

                    r = (r + (luma - r) * mix) * 0.5;
                    g = (g + (luma - g) * mix) * 0.5;
                    b = (b + (luma - b) * mix) * 0.5;
                }

                attribute.array[index * 3] = r;
                attribute.array[index * 3 + 1] = g;
                attribute.array[index * 3 + 2] = b;
            }

            attribute.needsUpdate = true;
        }

        const edgeColors = this.#edgeColors();
        const edgeBase = this.edgeBaseColors;

        /*
         * Which edges belong to the story being told.
         *
         * On a plain selection that means any edge touching a focused node. While
         * a journey is traced it means *only* the edges the journey walks —
         * otherwise every relationship hanging off every step lit up too, and the
         * traced chain drowned in the cross-links it passed through.
         */
        const journeyEdges = this.traceEdgeKeys?.size ? this.traceEdgeKeys : null;

        if (edgeColors) {
            this.edges.forEach((edge, index) => {
                const touched = journeyEdges
                    ? journeyEdges.has(index)
                    : focused.has(edge.source) || focused.has(edge.target);

                // Edges that are merely near the journey recede hard; the chain
                // itself stays bright enough to follow.
                const factor = touched ? 1 + 0.5 * mix : (journeyEdges ? 1 - 0.92 * mix : 1 - 0.86 * mix);

                for (let vertex = 0; vertex < 6; vertex++) {
                    edgeColors[index * 6 + vertex] = edgeBase[index * 6 + vertex] * factor;
                }
            });

            this.#touchEdgeColors();
        }

        // Decks the selection does not touch fade back too.
        this.decks?.forEach((deck) => {
            const touched = this.nodes.some((node) => node.layer === deck.layer && focused.has(node.key));
            // Decks are huge translucent discs: holding them at full opacity
            // while dimming everything on them was most of the glare. Even a
            // touched deck steps back a little.
            const factor = touched ? 1 - 0.25 * mix : 1 - 0.6 * mix;

            deck.parts.forEach((part, position) => {
                part.material.opacity = deck.baseOpacity[position] * factor;
            });
        });

        this.edgeMesh.material.opacity = this.edgeBaseOpacity + 0.16 * mix;

        /*
         * Bloom is what actually made a big focused mesh look washed out: the
         * pass is additive, so the more bright geometry there is the more the
         * whole frame lifts. Pull it back as focus comes in.
         */
        if (this.bloom) {
            this.bloom.strength = this.bloomBase * (1 - 0.42 * mix);
        }
    }

    /* --------------------------------------------------------- highlight -- */

    /**
     * Pull a colour towards its own luminance, i.e. towards grey.
     *
     * Rec.709 coefficients, not the Rec.601 ones you see for sRGB: three.js
     * works in linear space here, and these are the weights that keep a greyed
     * node at the same apparent brightness as the coloured one it replaces.
     */
    #desaturate(color, amount) {
        const luma = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;

        color.r += (luma - color.r) * amount;
        color.g += (luma - color.g) * amount;
        color.b += (luma - color.b) * amount;

        return color;
    }


    setHighlight(keys, primary = null) {
        this.highlightKeys = new Set(keys ?? []);
        this.primary = primary;

        this.focusKeys = this.#computeFocusKeys();
        this.#updateFocusTarget();

        if (this.primary) {
            const node = this.indexByKey.get(this.primary);
            if (node) {
                this.selectionRing.visible = true;
                this.haloSprite.visible = true;
                const y = this.current[node.index * 3 + 1];
                this.selectionRing.position.set(this.current[node.index * 3], y - 1.7, this.current[node.index * 3 + 2]);
                this.haloSprite.position.set(this.current[node.index * 3], y, this.current[node.index * 3 + 2]);
            }
        } else {
            this.selectionRing.visible = false;
            this.haloSprite.visible = false;
        }

        this.#rebuildHighlightLines();
        this.#refreshLabels(true);
    }

    #edgeColorFor(kind) {
        const node = this.edges.find((edge) => edge.kind === kind);

        return node?.color ?? '#8fd0ff';
    }

    #rebuildHighlightLines() {
        if (this.highlightLines) {
            this.overlayGroup.remove(this.highlightLines);
            this.highlightLines.geometry.dispose();
            this.highlightLines = null;
        }

        const selected = [...this.highlightKeys];

        if (selected.length === 0) return;

        const positions = [];
        const colors = [];

        this.edges.forEach((edge) => {
            const touches = this.highlightKeys.has(edge.source) && this.highlightKeys.has(edge.target);

            if (!touches) return;

            const sourceIndex = this.indexByKey.get(edge.source)?.index;
            const targetIndex = this.indexByKey.get(edge.target)?.index;

            if (sourceIndex === undefined || targetIndex === undefined) return;

            positions.push(
                this.current[sourceIndex * 3], this.current[sourceIndex * 3 + 1], this.current[sourceIndex * 3 + 2],
                this.current[targetIndex * 3], this.current[targetIndex * 3 + 1], this.current[targetIndex * 3 + 2]
            );

            const color = new THREE.Color(edge.color ?? '#8fd0ff').multiplyScalar(1.5);
            colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
        });

        // Also draw spokes out of the primary node so its reach is obvious.
        if (this.primary) {
            const sourceNode = this.indexByKey.get(this.primary);

            if (sourceNode) {
                this.edges.forEach((edge) => {
                    if (edge.source !== this.primary && edge.target !== this.primary) return;

                    const otherKey = edge.source === this.primary ? edge.target : edge.source;
                    const other = this.indexByKey.get(otherKey);

                    if (!other) return;

                    positions.push(
                        this.current[sourceNode.index * 3], this.current[sourceNode.index * 3 + 1], this.current[sourceNode.index * 3 + 2],
                        this.current[other.index * 3], this.current[other.index * 3 + 1], this.current[other.index * 3 + 2]
                    );

                    const color = new THREE.Color(edge.color ?? '#8fd0ff');
                    colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
                });
            }
        }

        if (positions.length === 0) return;

        const geometry = new LineSegmentsGeometry();
        geometry.setPositions(positions);
        geometry.setColors(colors);

        this.highlightLines = new LineSegments2(geometry, this.highlightMaterial);
        this.highlightLines.frustumCulled = false;
        this.highlightLines.raycast = () => {};
        this.overlayGroup.add(this.highlightLines);
    }

    /* ------------------------------------------------------------- trace -- */

    setTrace(trace) {
        if (this.traceParticles) {
            this.overlayGroup.remove(this.traceParticles.points);
            this.traceParticles.points.geometry.dispose();
            this.traceParticles.points.material.dispose();
            this.traceParticles = null;
        }

        // A journey lights its whole path, so focus mode keeps every step
        // bright even though most of them are not direct neighbours. The edge
        // set is what keeps the *chain* lit rather than every line that happens
        // to touch one of its steps.
        this.tracePath = trace?.path ?? null;
        this.tracePathSet = new Set(trace?.path ?? []);
        this.traceEdgeKeys = new Set(trace?.edges ?? []);
        this.focusKeys = this.#computeFocusKeys();
        this.#updateFocusTarget();

        if (!trace || trace.path.length < 2) return;

        const points = trace.path
            .map((key) => this.indexByKey.get(key))
            .filter(Boolean)
            .map((node) => [this.current[node.index * 3], this.current[node.index * 3 + 1], this.current[node.index * 3 + 2]]);

        if (points.length < 2) return;

        const perSegment = 5;
        const total = (points.length - 1) * perSegment;
        const positions = new Float32Array(total * 3);
        const colors = new Float32Array(total * 3);
        const progress = new Float32Array(total);

        for (let i = 0; i < total; i++) {
            progress[i] = i / total;
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        const material = new THREE.PointsMaterial({
            size: 11,
            vertexColors: true,
            map: this.#radialTexture(64, 0.02, 0.6),
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });

        const pointsObject = new THREE.Points(geometry, material);
        pointsObject.frustumCulled = false;
        pointsObject.raycast = () => {};

        this.overlayGroup.add(pointsObject);

        this.traceParticles = {
            points: pointsObject,
            polyline: points,
            progress,
            speed: 0.22,
            color: new THREE.Color(trace.color ?? '#7dd3fc'),
        };
    }

    #animateTrace(delta) {
        if (!this.traceParticles) return;

        const { points, polyline, progress } = this.traceParticles;
        const positions = points.geometry.getAttribute('position');
        const colors = points.geometry.getAttribute('color');

        // Segment lengths for even travel speed.
        const lengths = [];
        let total = 0;

        for (let i = 0; i < polyline.length - 1; i++) {
            const a = polyline[i];
            const b = polyline[i + 1];
            const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
            lengths.push(length);
            total += length;
        }

        progress.forEach((value, index) => {
            progress[index] = (value + delta * this.traceParticles.speed) % 1;
        });

        progress.forEach((t, index) => {
            const distance = t * total;
            let travelled = 0;
            let segment = 0;

            while (segment < lengths.length - 1 && travelled + lengths[segment] < distance) {
                travelled += lengths[segment];
                segment++;
            }

            const local = Math.min(1, (distance - travelled) / lengths[segment]);
            const a = polyline[segment];
            const b = polyline[segment + 1];

            positions.array[index * 3] = a[0] + (b[0] - a[0]) * local;
            positions.array[index * 3 + 1] = a[1] + (b[1] - a[1]) * local;
            positions.array[index * 3 + 2] = a[2] + (b[2] - a[2]) * local;

            const fade = Math.sin(Math.PI * t) * 0.9 + 0.1;
            const color = this.traceParticles.color;
            colors.array[index * 3] = color.r * fade;
            colors.array[index * 3 + 1] = color.g * fade;
            colors.array[index * 3 + 2] = color.b * fade;
        });

        positions.needsUpdate = true;
        colors.needsUpdate = true;
    }

    /* ------------------------------------------------------------ labels -- */

    /*
     * A label is a canvas painted onto a sprite, and a sprite that is magnified
     * on screen can only ever show the pixels it was painted with. Distance
     * scaling makes that the normal case rather than the exception — flying
     * close to a node magnifies its label several times over — so the canvas is
     * painted at `devicePixelRatio * labelBoost` and mipmapped, which keeps it
     * legible up close and stops it shimmering when it is far away.
     */
    #makeLabel(text, color = '#dbe7f7', options = {}) {
        const scale = options.scale ?? 1;
        const boost = options.boost ?? QUALITY[this.quality].labelBoost;
        const dpr = Math.min(window.devicePixelRatio || 1, 2) * boost;
        const padding = 14;
        const fontSize = 30;

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        context.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;

        const width = Math.ceil(context.measureText(text).width) + padding * 2;
        const height = fontSize + padding;

        canvas.width = Math.ceil(width * dpr);
        canvas.height = Math.ceil(height * dpr);

        const draw = canvas.getContext('2d');
        draw.scale(dpr, dpr);
        draw.font = `600 ${fontSize}px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
        draw.textBaseline = 'middle';
        draw.fillStyle = 'rgba(6, 9, 17, 0.66)';
        draw.strokeStyle = 'rgba(148, 163, 184, 0.4)';
        draw.lineWidth = 2;

        const radius = 12;
        draw.beginPath();
        draw.roundRect(1, 1, width - 2, height - 2, radius);
        draw.fill();
        draw.stroke();

        draw.fillStyle = color;
        draw.fillText(text, padding, height / 2 + 1);

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.anisotropy = this.renderer?.capabilities?.getMaxAnisotropy?.() ?? 1;

        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthWrite: false,
            opacity: options.opacity ?? 1,
        }));

        const worldWidth = (width / fontSize) * 12 * scale;
        const worldHeight = (height / fontSize) * 12 * scale;
        sprite.scale.set(worldWidth, worldHeight, 1);

        // Remembered so the render loop can rescale labels with distance and
        // keep their on-screen size roughly constant.
        sprite.userData.baseWidth = worldWidth;
        sprite.userData.baseHeight = worldHeight;

        return sprite;
    }

    #refreshLabels(force = false) {
        if (!this.labelsEnabled) {
            this.labelSprites.forEach((sprite) => { sprite.visible = false; });

            return;
        }

        const now = performance.now();

        if (!force && now - (this.lastLabelRefresh ?? 0) < 220) return;
        this.lastLabelRefresh = now;

        const preset = QUALITY[this.quality];
        const cameraDistance = this.camera.position.distanceTo(this.controls.target);
        const zoomFactor = THREE.MathUtils.clamp(2600 / Math.max(180, cameraDistance), 0.35, 1.15);
        const budget = Math.round(preset.labels * zoomFactor);

        const wanted = new Map();

        // 1. Always label the selection, hover and trace path.
        this.highlightKeys.forEach((key) => wanted.set(key, 3));

        if (this.hovered >= 0) {
            wanted.set(this.nodes[this.hovered].key, 3);
        }

        // 2. Then the most important visible nodes, nearest to the camera first.
        const candidates = this.nodes
            .filter((node) => this.targetScales[node.index] > 0.5 && !wanted.has(node.key))
            .map((node) => ({
                node,
                score: node.weight + (cameraDistance < 900 ? 18 : 0) - this.camera.position.distanceTo(
                    tmpVector.set(this.current[node.index * 3], this.current[node.index * 3 + 1], this.current[node.index * 3 + 2])
                ) * 0.012,
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, budget);

        candidates.forEach(({ node }) => wanted.set(node.key, 1));

        // Hide labels that dropped out.
        this.labelSprites.forEach((sprite, key) => {
            if (!wanted.has(key)) {
                sprite.visible = false;
            }
        });

        wanted.forEach((priority, key) => {
            const node = this.indexByKey.get(key);

            if (!node) return;

            let sprite = this.labelSprites.get(key);

            if (!sprite) {
                sprite = this.#makeLabel(node.label, priority === 3 ? '#ffffff' : '#cfe0f5', {
                    scale: priority === 3 ? 0.95 : 0.72,
                    opacity: priority === 3 ? 1 : 0.82,
                });
                this.labelSprites.set(key, sprite);
                this.labelGroup.add(sprite);
            }

            sprite.visible = true;
            sprite.position.set(
                this.current[node.index * 3],
                this.current[node.index * 3 + 1] + 3.1 + node.size * 1.4,
                this.current[node.index * 3 + 2]
            );
        });
    }

    /**
     * Labels are world-space sprites, so without this they would read as huge
     * slabs of text when the camera moves in close. Rescaling with distance
     * keeps them legible at every zoom level.
     */
    /** Ease focus strength towards its target and re-tint while it moves. */
    #tickFocus(delta) {
        if (this.focusMix === this.focusTarget) return;

        const blend = Math.min(1, delta * 7);
        this.focusMix += (this.focusTarget - this.focusMix) * blend;

        if (Math.abs(this.focusTarget - this.focusMix) < 0.01) {
            this.focusMix = this.focusTarget;
        }

        this.#applyFocus(this.focusMix);
    }

    #scaleLabels(delta) {
        if (!this.labelSprites.size) return;

        const blend = Math.min(1, delta * 9);

        this.labelSprites.forEach((sprite) => {
            if (!sprite.visible) return;

            const base = sprite.userData.baseWidth;

            if (!base) return;

            const distance = this.camera.position.distanceTo(sprite.position);
            const target = base * THREE.MathUtils.clamp(distance / 1500, 0.26, 1.25);

            sprite.scale.x += (target - sprite.scale.x) * blend;
            sprite.scale.y = sprite.scale.x * (sprite.userData.baseHeight / base);
        });
    }

    setLabels(enabled) {
        this.labelsEnabled = enabled;
        this.#refreshLabels(true);
    }

    /* -------------------------------------------------------- navigation -- */

    /**
     * @param  bool  $animate
     * @param  array  $options  `useTarget` frames where the nodes are *going*.
     *         A layout switch needs that: the nodes are still sitting in their
     *         old positions when the camera is asked to fit, so framing the
     *         current ones pointed the camera at the layout the user just left
     *         while the new one animated in somewhere off screen.
     */
    fitAll(animate = true, options = {}) {
        const visible = this.nodes.filter((node) => this.targetScales[node.index] > 0.5);
        const list = visible.length > 4 ? visible : this.nodes;

        if (list.length === 0) return;

        const source = options.useTarget ? this.target : this.current;
        const box = new THREE.Box3();
        const points = [];

        list.forEach((node) => {
            const point = new THREE.Vector3(
                source[node.index * 3],
                source[node.index * 3 + 1],
                source[node.index * 3 + 2]
            );

            box.expandByPoint(point);
            points.push(point);
        });

        // Aim from the elevated three-quarter view that makes the decks read.
        const direction = options.direction ?? new THREE.Vector3(0.42, 0.42, 1).normalize();

        this.#frameBox(box, { margin: 0.8, ...options, points, direction, duration: animate ? 900 : 0 });
    }

    /**
     * Place the camera so a bounding box fills the viewport with a margin.
     *
     * Framing on a bounding *sphere* is not good enough here: the atlas is a
     * tall stack of wide decks, so a sphere fit leaves half the stage empty and
     * shrinks the labels. Instead the box corners are projected through the
     * camera and the distance is corrected until they sit inside the viewport.
     */
    #frameBox(box, options = {}) {
        if (box.isEmpty()) return;

        const center = box.getCenter(new THREE.Vector3());

        // Fitting the eight box corners is needlessly conservative for a tall
        // stack of round decks: the corners stick out into space no node ever
        // occupies. When the caller can hand over the real points, use them.
        const targets = options.points?.length
            ? options.points
            : [
                new THREE.Vector3(box.min.x, box.min.y, box.min.z),
                new THREE.Vector3(box.min.x, box.min.y, box.max.z),
                new THREE.Vector3(box.min.x, box.max.y, box.min.z),
                new THREE.Vector3(box.min.x, box.max.y, box.max.z),
                new THREE.Vector3(box.max.x, box.min.y, box.min.z),
                new THREE.Vector3(box.max.x, box.min.y, box.max.z),
                new THREE.Vector3(box.max.x, box.max.y, box.min.z),
                new THREE.Vector3(box.max.x, box.max.y, box.max.z),
            ];

        const direction = (options.direction ?? this.camera.position.clone().sub(this.controls.target))
            .clone()
            .normalize();

        // 0.8 leaves a tenth of the stage clear top and bottom, which is where
        // the legend and the trace bar live.
        const margin = options.margin ?? 0.8;
        const start = this.camera.position.clone();
        const startTarget = this.controls.target.clone();
        const sphereRadius = Math.max(40, box.getBoundingSphere(new THREE.Sphere()).radius);
        const fovHalf = THREE.MathUtils.degToRad(this.camera.fov) / 2;

        // Viewed from above, a tall stack projects asymmetrically: the far decks
        // compress towards the middle while the near ones spread out. So the
        // framing pass corrects two things at once — how far away the camera
        // sits, and where it is actually looking.
        const aim = center.clone();
        let distance = sphereRadius / Math.tan(fovHalf);
        for (let pass = 0; pass < 5; pass++) {
            this.camera.position.copy(aim).addScaledVector(direction, distance);
            this.camera.lookAt(aim);
            this.camera.updateMatrixWorld(true);

            let minX = Infinity;
            let maxX = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;

            targets.forEach((target) => {
                const projected = tmpVector.copy(target).project(this.camera);

                minX = Math.min(minX, projected.x);
                maxX = Math.max(maxX, projected.x);
                minY = Math.min(minY, projected.y);
                maxY = Math.max(maxY, projected.y);
            });

            if (!Number.isFinite(minX)) break;

            const extent = Math.max(Math.abs(minX), Math.abs(maxX), Math.abs(minY), Math.abs(maxY));

            if (extent <= 0) break;

            // Nudge the aim so the content sits centred in the viewport.
            const offsetX = (minX + maxX) / 2;
            const offsetY = (minY + maxY) / 2;
            const halfHeight = Math.tan(fovHalf) * distance;
            const halfWidth = halfHeight * this.camera.aspect;

            const right = tmpVector.setFromMatrixColumn(this.camera.matrixWorld, 0).clone();
            const up = tmpVector2.setFromMatrixColumn(this.camera.matrixWorld, 1).clone();

            aim.addScaledVector(right, offsetX * halfWidth).addScaledVector(up, offsetY * halfHeight);

            const correction = extent / margin;
            distance *= correction;

            if (Math.abs(correction - 1) < 0.02 && Math.abs(offsetX) < 0.01 && Math.abs(offsetY) < 0.01) break;
        }

        // Undo the measuring moves so the tween starts from where the user is.
        this.camera.position.copy(start);
        this.controls.target.copy(startTarget);

        this.#moveCamera(aim.clone().addScaledVector(direction, distance), aim, options.duration ?? 900);
    }

    flyTo(key, options = {}) {
        const node = this.indexByKey.get(key);

        if (!node) return;

        const center = new THREE.Vector3(
            this.current[node.index * 3],
            this.current[node.index * 3 + 1],
            this.current[node.index * 3 + 2]
        );

        const distance = options.distance ?? Math.max(90, node.size * 90);
        const direction = this.camera.position.clone().sub(this.controls.target).normalize();

        this.#moveCamera(center.clone().add(direction.multiplyScalar(distance)), center, options.duration ?? 780);
    }

    frameKeys(keys, options = {}) {
        const points = keys
            .map((key) => this.indexByKey.get(key))
            .filter(Boolean)
            .map((node) => new THREE.Vector3(
                this.current[node.index * 3],
                this.current[node.index * 3 + 1],
                this.current[node.index * 3 + 2]
            ));

        if (points.length === 0) return;

        const box = new THREE.Box3().setFromPoints(points);

        // A single node has no volume; give it some before framing.
        if (box.getSize(new THREE.Vector3()).length() < 12) {
            box.expandByScalar(40);
        }

        this.#frameBox(box, {
            ...options,
            points,
            direction: options.direction ?? new THREE.Vector3(0.35, 0.5, 1).normalize(),
            margin: options.margin ?? 0.72,
            duration: options.duration ?? 900,
        });
    }

    /** Click-to-navigate from the minimap. */
    panTo(x, z) {
        const target = new THREE.Vector3(x, this.controls.target.y, z);
        const offset = this.camera.position.clone().sub(this.controls.target);

        this.#moveCamera(target.clone().add(offset), target, 620);
    }

    #moveCamera(position, target, duration) {
        if (duration !== 0 && this.interacting) return;

        if (duration === 0) {
            this.camera.position.copy(position);
            this.controls.target.copy(target);

            return;
        }

        this.cameraTween = {
            fromPosition: this.camera.position.clone(),
            toPosition: position.clone(),
            fromTarget: this.controls.target.clone(),
            toTarget: target.clone(),
            elapsed: 0,
            duration,
        };
    }

    /* ------------------------------------------------------------ picking -- */

    #bindEvents() {
        this.canvas.addEventListener('pointermove', (event) => {
            const rect = this.canvas.getBoundingClientRect();
            this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
            this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
            this.screenX = event.clientX - rect.left;
            this.screenY = event.clientY - rect.top;

            const now = performance.now();

            if (now - this.lastPick > 36) {
                this.lastPick = now;
                this.#pick();
            }
        });

        this.canvas.addEventListener('pointerleave', () => {
            this.pointer.set(-10, -10);
            this.#setHover(-1);
        });

        this.canvas.addEventListener('click', () => {
            if (this.hovered >= 0) {
                this.callbacks.onPick?.(this.nodes[this.hovered].key, this.nodes[this.hovered]);
            } else {
                this.callbacks.onBackgroundClick?.();
            }
        });

        window.addEventListener('resize', () => this.resize());
    }

    #pick() {
        if (!this.nodeGroup.children.length) return;

        this.raycaster.setFromCamera(this.pointer, this.camera);

        let best = null;

        this.groups.forEach(({ mesh, indexes }) => {
            const hits = this.raycaster.intersectObject(mesh, false);

            hits.forEach((hit) => {
                const nodeIndex = indexes[hit.instanceId];

                if (this.nodes[nodeIndex] === undefined || this.targetScales[nodeIndex] < 0.5) return;

                if (!best || hit.distance < best.distance) {
                    best = { distance: hit.distance, nodeIndex };
                }
            });
        });

        this.#setHover(best ? best.nodeIndex : -1);
    }

    #setHover(nodeIndex) {
        if (this.hovered === nodeIndex) return;

        this.hovered = nodeIndex;

        if (nodeIndex >= 0) {
            const node = this.nodes[nodeIndex];
            this.hoverRing.visible = true;
            this.hoverRing.position.set(
                this.current[nodeIndex * 3],
                this.current[nodeIndex * 3 + 1] - 1.7,
                this.current[nodeIndex * 3 + 2]
            );
            this.canvas.style.cursor = 'pointer';
            this.callbacks.onHover?.(node, { x: this.screenX ?? 0, y: this.screenY ?? 0 });
        } else {
            this.hoverRing.visible = false;
            this.canvas.style.cursor = 'grab';
            this.callbacks.onHover?.(null);
        }
    }

    hoveredNode() {
        return this.hovered >= 0 ? this.nodes[this.hovered] : null;
    }

    /** Screen-space position of a node — used to place tooltips and badges. */
    project(key) {
        const node = this.indexByKey.get(key);

        if (!node) return null;

        const vector = new THREE.Vector3(
            this.current[node.index * 3],
            this.current[node.index * 3 + 1],
            this.current[node.index * 3 + 2]
        ).project(this.camera);

        const rect = this.canvas.getBoundingClientRect();

        return {
            x: (vector.x * 0.5 + 0.5) * rect.width,
            y: (-vector.y * 0.5 + 0.5) * rect.height,
            visible: vector.z < 1,
        };
    }

    /** Flat [x,z] pairs for the minimap, in world units. */
    footprint() {
        return this.nodes.map((node) => ({
            x: this.current[node.index * 3],
            z: this.current[node.index * 3 + 2],
            color: node.color,
            visible: this.targetScales[node.index] > 0.5,
            weight: node.weight,
        }));
    }

    /* --------------------------------------------------------- appearance -- */

    setQuality(quality) {
        if (!QUALITY[quality]) return;

        this.quality = quality;
        const preset = QUALITY[quality];

        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatio));
        this.bloom.enabled = preset.bloom;
        this.bloomBase = preset.bloomStrength;
        this.bloom.strength = preset.bloomStrength;
        this.bloom.radius = preset.bloomRadius;
        this.bloom.threshold = preset.bloomThreshold;

        if (this.glowPoints) {
            this.glowPoints.material.opacity = 0.5 * preset.glow;
            this.glowPoints.material.size = 17 * (quality === 'performance' ? 0.75 : 1);
        }

        // Lines are measured in screen pixels, so a new tier means a new width
        // and a new fill budget. Only the width and opacity change — the buffers
        // and the mesh stay exactly where they are.
        if (this.edgeMaterial) {
            this.edgeMaterial.linewidth = preset.edgeWidth;
            this.edgeMaterial.opacity = preset.edgeOpacity;
            this.edgeBaseOpacity = preset.edgeOpacity;
        }

        // Label textures are baked at the tier's density, so the cached ones are
        // now the wrong resolution; they are cheap to repaint and there are at
        // most a few dozen of them on screen.
        this.#resetLabels();
        this.#refreshLabels(true);

        // Reallocates the buffers and resizes the post path.
        this.#syncComposerSamples();
    }

    setAutoRotate(enabled) {
        this.autoRotate = enabled;
        this.controls.autoRotate = enabled;
    }

    /* --------------------------------------------------------------- loop -- */

    /** The canvas box in CSS pixels — what the fat-line shader measures against. */
    #viewport() {
        return [
            this.canvas.clientWidth || this.canvas.parentElement.clientWidth,
            this.canvas.clientHeight || this.canvas.parentElement.clientHeight,
        ];
    }

    resize() {
        const [width, height] = this.#viewport();

        if (width === 0 || height === 0) return;

        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();

        this.renderer.setSize(width, height, false);

        /*
         * The composer resizes its own passes — including bloom's mip chain —
         * by the renderer's pixel ratio. Resizing bloom again here with CSS
         * pixels silently halved that chain on a high-density display, which is
         * exactly the kind of half-resolution glow that reads as blur.
         */
        this.composer.setPixelRatio(this.renderer.getPixelRatio());
        this.composer.setSize(width, height);

        // Fat lines are sized against the viewport in CSS pixels.
        this.highlightMaterial.resolution.set(width, height);
        this.highlightMaterial.needsUpdate = true;

        if (this.edgeMaterial) {
            this.edgeMaterial.resolution.set(width, height);
            this.edgeMaterial.needsUpdate = true;
        }
    }

    #loop() {
        const tick = () => {
            this.raf = requestAnimationFrame(tick);

            const delta = Math.min(0.05, this.clock.getDelta());

            this.#animatePositions(delta);
            this.#animateTrace(delta);
            this.#animateCamera(delta);

            this.controls.update();

            if (this.traceParticles && this.traceParticles.points.geometry.getAttribute('position').needsUpdate) {
                // already updated above
            }

            if (this.lastHighlightRefresh !== this.highlightVersion) {
                this.#rebuildHighlightLines();
                this.lastHighlightRefresh = this.highlightVersion;
            }

            if (this.dirty) {
                this.#refreshEdgeGeometry();
                this.#refreshLabels();
            }

            this.#tickFocus(delta);
            this.#scaleLabels(delta);

            if (this.quality === 'high') {
                this.composer.render();
            } else {
                this.renderer.render(this.scene, this.camera);
            }

            this.#tickFps();
        };

        tick();
    }

    #animatePositions(delta) {
        if (!this.current) return;

        // Follow camera-aware damping: closer cameras get snappier transitions.
        const ease = 1 - Math.pow(0.02, delta);
        let moving = false;

        // A new graph, layout or visibility set snaps every instance, so the
        // per-node change detection below cannot be trusted on its own.
        const rebuild = this.matricesDirty;
        this.matricesDirty = false;

        for (let index = 0; index < this.nodes.length; index++) {
            const base = index * 3;
            let changed = rebuild;

            for (let axis = 0; axis < 3; axis++) {
                const current = this.current[base + axis];
                const target = this.target[base + axis];
                const difference = target - current;

                if (Math.abs(difference) > 0.08) {
                    this.current[base + axis] = current + difference * Math.min(1, ease * 1.4);
                    changed = true;
                    moving = true;
                } else if (current !== target) {
                    this.current[base + axis] = target;
                }
            }

            const scaleTarget = this.targetScales[index];
            const scale = this.scales[index];
            const scaleDifference = scaleTarget - scale;

            if (Math.abs(scaleDifference) > 0.004) {
                this.scales[index] = scale + scaleDifference * Math.min(1, ease * 1.6);
                changed = true;
                moving = true;
            } else if (scale !== scaleTarget) {
                this.scales[index] = scaleTarget;
                changed = true;
            }

            if (changed) {
                this.#writeMatrix(index);
            }
        }

        this.dirty = moving;

        /*
         * Layout-morph progress. `moving` says the nodes are still travelling;
         * the remaining distance as a fraction of the distance this layout
         * started with is a progress bar that reflects the actual animation
         * rather than a timer guessing at it.
         */
        if (this.layoutMoving) {
            const remaining = this.#remainingTravel();

            this.layoutProgress = this.layoutDistance > 0
                ? Math.min(1, Math.max(0, 1 - remaining / this.layoutDistance))
                : 1;

            if (!moving || remaining < 0.5) {
                this.layoutMoving = false;
                this.layoutProgress = 1;
            }

            this.#reportLayoutProgress(!this.layoutMoving);
        }
    }

    #writeMatrix(index) {
        const node = this.nodes[index];
        const kind = GEOMETRY_BY_TYPE[node.type] ?? 'ico';
        const group = this.groups.get(kind);

        if (!group) return;

        const slot = group.indexes.indexOf(index);

        if (slot < 0) return;

        const scale = Math.max(0.0001, node.size * this.scales[index]);
        const hover = this.hovered === index ? 1.35 : 1;

        tmpMatrix.makeScale(scale * hover, scale * hover, scale * hover);
        tmpMatrix.setPosition(
            this.current[index * 3],
            this.current[index * 3 + 1],
            this.current[index * 3 + 2]
        );

        group.mesh.setMatrixAt(slot, tmpMatrix);
        group.mesh.instanceMatrix.needsUpdate = true;

        // three.js caches an InstancedMesh bounding sphere the first time it is
        // raycast. Because instances start at zero scale, that cached sphere
        // would stay empty and picking would never hit anything, so it is
        // invalidated whenever an instance moves.
        group.mesh.boundingSphere = null;
    }

    #animateCamera(delta) {
        if (!this.cameraTween) return;

        this.cameraTween.elapsed += delta * 1000;
        const t = Math.min(1, this.cameraTween.elapsed / this.cameraTween.duration);
        const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

        this.camera.position.lerpVectors(this.cameraTween.fromPosition, this.cameraTween.toPosition, eased);
        this.controls.target.lerpVectors(this.cameraTween.fromTarget, this.cameraTween.toTarget, eased);

        if (t >= 1) this.cameraTween = null;
    }

    #tickFps() {
        this.frames++;

        const now = performance.now();

        if (now - this.lastFps > 700) {
            this.callbacks.onFrame?.(Math.round((this.frames * 1000) / (now - this.lastFps)));
            this.frames = 0;
            this.lastFps = now;
        }
    }

    /* ------------------------------------------------------------- teardown -- */

    disposeGraph() {
        this.groups.forEach(({ mesh }) => {
            mesh.geometry.dispose();
            mesh.material.dispose();
            this.nodeGroup.remove(mesh);
        });
        this.groups.clear();

        if (this.glowPoints) {
            this.glowPoints.geometry.dispose();
            this.glowPoints.material.dispose();
            this.nodeGroup.remove(this.glowPoints);
            this.glowPoints = null;
        }

        if (this.edgeMesh) {
            this.edgeMesh.geometry.dispose();
            this.edgeMesh.material.dispose();
            this.edgeGroup.remove(this.edgeMesh);
            this.edgeMesh = null;
            this.edgeMaterial = null;
        }

        this.edgePositions = null;
        this.edgeColors = null;

        this.deckGroup.clear();

        this.#resetLabels();
    }

    /** Throw away every label sprite so the next pass repaints them. */
    #resetLabels() {
        this.labelSprites.forEach((sprite) => {
            sprite.material.map?.dispose();
            sprite.material.dispose();
        });

        this.labelGroup.clear();
        this.labelSprites.clear();
    }

    dispose() {
        cancelAnimationFrame(this.raf);
        this.disposeGraph();
        this.renderer.dispose();
    }
}
