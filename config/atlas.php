<?php

return [
    /*
    |--------------------------------------------------------------------------
    | AtlasScope configuration
    |--------------------------------------------------------------------------
    */

    /*
     * Hard ceiling for an uploaded archive (bytes).
     *
     * 150 MB is the natural limit, and it is written down in exactly one place:
     * bin/limits.env. bin/php gives the dev server the same value, so the
     * ceiling the UI advertises is the ceiling actually enforced.
     */
    'max_archive_bytes' => env('ATLAS_MAX_ARCHIVE_BYTES', App\Support\Ini::devBytes('upload_max')),

    /*
     * Ceiling for the *uncompressed* source tree, enforced while unpacking.
     *
     * Deliberately not the archive ceiling: source compresses roughly three to
     * four times, so a legible 150 MB archive can expand well past 150 MB. This
     * is a zip-bomb guard, not a size policy.
     */
    'max_extracted_bytes' => env('ATLAS_MAX_EXTRACTED_BYTES', 2_147_483_648),

    // Run scans inline instead of on the queue — handy for shared hosting and
    // for this demo environment where no worker is running. Keep this false in
    // production and run `php artisan queue:work` for a perfectly smooth UI.
    // `sync_scans` defaults to whether the queue driver itself is synchronous:
    // with the default driver a scan runs inline, and as soon as a real queue
    // connection (database, redis, …) is configured it is dispatched instead.
    'sync_scans' => env('ATLAS_SYNC_SCANS', env('QUEUE_CONNECTION', 'sync') === 'sync'),

    // Stream every scan step to the console when running from the CLI.
    'verbose_scans' => env('ATLAS_VERBOSE_SCANS', false),

    // How aggressively the 3D renderer may draw before it starts thinning edges.
    'max_render_nodes' => env('ATLAS_MAX_RENDER_NODES', 2500),
    'max_render_edges' => env('ATLAS_MAX_RENDER_EDGES', 6000),

    // Default view filters offered in the explorer.
    'default_layers' => ['entry', 'http', 'application', 'domain', 'data', 'view'],

    'demo_enabled' => env('ATLAS_DEMO_ENABLED', true),

    /*
    |--------------------------------------------------------------------------
    | The local assistant
    |--------------------------------------------------------------------------
    |
    | An optional chat panel that answers questions about the loaded project.
    | The model runs on your own machine — Ollama is the default runtime, and
    | nothing about this is in the cloud, keyed, metered or required: with no
    | runtime listening the panel simply reports that and explains how to start
    | one.
    |
    | The model list is ordered by what runs on an ordinary laptop; the first is
    | the default. Override with ATLAS_AI_MODEL.
    |
    */
    'ai' => [
        'enabled' => env('ATLAS_AI_ENABLED', true),

        // OpenAI-compatible local runtimes work too — LM Studio serves the same
        // shape of API on its own port.
        'base_url' => env('ATLAS_AI_BASE_URL', 'http://127.0.0.1:11434'),

        'model' => env('ATLAS_AI_MODEL', 'qwen3:8b'),

        // What the panel offers when the default is not installed, cheapest
        // first. The first entry that is actually pulled becomes the default.
        'suggested_models' => [
            'qwen3:8b' => '8B · about 5 GB · the balance of speed and quality',
            'phi4:14b' => '14B · about 9 GB · better at longer explanations',
            'qwen2.5-coder:7b' => '7B · about 4.7 GB · the light option',
            'llama3.2:3b' => '3B · about 2 GB · fastest, shallowest',
        ],

        // Generous, because a 14B model thinking on a laptop CPU is not fast.
        'timeout' => env('ATLAS_AI_TIMEOUT', 180),

        // How much retrieved source may be put in front of the model, and how
        // many nodes the retriever is allowed to pull excerpts for.
        'context_chars' => env('ATLAS_AI_CONTEXT_CHARS', 14000),
        'context_nodes' => env('ATLAS_AI_CONTEXT_NODES', 8),
        'excerpt_lines' => env('ATLAS_AI_EXCERPT_LINES', 90),

        'temperature' => env('ATLAS_AI_TEMPERATURE', 0.2),
    ],
];
