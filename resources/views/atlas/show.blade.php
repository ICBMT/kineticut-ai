@extends('layouts.base')

@section('title', $project->displayName().' — 3D atlas')

@section('body-class', 'atlas-body')

@section('content')
<div
    id="atlas"
    class="atlas"
    data-project="{{ $project->uuid }}"
    data-project-name="{{ $project->displayName() }}"
    data-project-meta="{{ $project->stackLine() }} · {{ $project->sizeForHumans() }}"
    data-graph-url="{{ $endpoints['graph'] }}"
    data-status-url="{{ $endpoints['status'] }}"
    data-events-url="{{ $endpoints['events'] }}"
    data-node-url="{{ $endpoints['node'] }}"
    data-file-url="{{ $endpoints['file'] }}"
    data-export-url="{{ $endpoints['export'] }}"
    data-ai-status-url="{{ $endpoints['ai_status'] }}"
    data-ai-ask-url="{{ $endpoints['ai_ask'] }}"
    data-csrf="{{ csrf_token() }}"
    data-project-url="{{ route('projects.show', $project) }}"
    data-scan-status="{{ optional($scan)->status?->value ?? 'queued' }}"
    data-has-graph="{{ ($hasGraph ?? false) ? '1' : '0' }}"
>
    {{-- ------------------------------------------------------------ top bar --}}
    <header class="atlas__bar">
        <button class="btn btn--sm btn--icon" id="toggle-rail" aria-pressed="true" title="Show or hide the filter rail">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
        </button>

        <a href="{{ route('home') }}" class="brand" style="font-size:0.95rem">
            <span class="brand__mark" style="width:26px;height:26px">
                <svg viewBox="0 0 24 24" fill="none" stroke="#06101f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:15px;height:15px">
                    <path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5"/><path d="M12 12v10"/>
                </svg>
            </span>
            <span class="brand__name" style="font-size:0.92rem">{{ $project->displayName() }}</span>
        </a>

        <div class="spacer"></div>

        {{-- Guide numbers, sitting against the search field where the toolbar has
             its slack. The relationship total is the whole graph's, not the
             filtered view's; the structure column says how the graph is
             organised, which is what the layouts and filters work in. --}}
        <div class="hud-stats" id="graph-summary" role="status" aria-live="polite">
            <span class="hud-stat" title="Every relationship the scanner resolved across the project">
                <b id="stat-relationships">—</b><span class="hud-stat__label">relationships</span>
            </span>
            <span class="hud-stats__sep" aria-hidden="true"></span>
            <span class="hud-stat hud-stat--structure" title="Architectural layers, and the modules those nodes are grouped into">
                <b id="stat-layers">—</b><span class="hud-stat__label">layers</span>
                <em class="hud-stat__dot" aria-hidden="true">·</em>
                <b id="stat-modules">—</b><span class="hud-stat__label">modules</span>
            </span>
        </div>

        <div class="search bar-search" style="width:250px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
            <input class="input" id="search" type="search" placeholder="{{ $project->language === 'php' ? 'Search classes, routes, tables…' : ($project->language === 'csharp' ? 'Search classes, routes, services…' : ($project->language === 'python' ? 'Search classes, routes, models…' : 'Search classes, functions, namespaces…')) }}" autocomplete="off" spellcheck="false">
            {{-- Only visible once there is something to clear — see the CSS. --}}
            <button class="search__clear" id="search-clear" type="button" aria-label="Clear search" title="Clear search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
        </div>

        <label class="hud-pill bar-layout" style="gap:8px">
            Layout
            <select class="select" id="layout-mode" style="width:auto;padding:3px 8px;border:none;background:transparent;font-size:0.78rem">
                <option value="layers">Architecture layers</option>
                <option value="modules">Modules</option>
                <option value="spiral">Spiral</option>
            </select>
        </label>

        <label class="hud-pill bar-quality" style="gap:8px">
            Quality
            <select class="select" id="quality" style="width:auto;padding:3px 8px;border:none;background:transparent;font-size:0.78rem">
                <option value="high">High (bloom)</option>
                <option value="balanced">Balanced</option>
                <option value="performance">Performance</option>
            </select>
        </label>

        <button class="btn btn--sm btn--ghost" id="toggle-rotate" aria-pressed="false" title="Auto rotate camera">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>
        </button>
        <button class="btn btn--sm btn--ghost" id="toggle-focus" aria-pressed="true" title="Dim everything except the selected node and its connections">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
        </button>
        <button class="btn btn--sm btn--ghost" id="toggle-labels" aria-pressed="true" title="Toggle floating labels">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h10M4 17h7"/></svg>
        </button>
        <button class="btn btn--sm btn--ghost" id="fit-view" title="Fit whole atlas on screen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9V4h5M20 15v5h-5M4 15v5h5M20 9V4h-5"/></svg>
        </button>
        <a class="btn btn--sm btn--ghost" href="{{ route('api.atlas.export', $project) }}" title="Export graph JSON">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4v12m0 0 4-4m-4 4-4-4M5 20h14"/></svg>
        </a>
        <button class="btn btn--sm btn--ghost" id="toggle-ai" aria-pressed="false" title="Ask the assistant about this project (a)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="3.4"/></svg>
        </button>
        <button class="btn btn--sm btn--icon" id="toggle-inspector" aria-pressed="true" title="Show or hide the inspector">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4h16v16H4z"/><path d="M15 4v16"/></svg>
        </button>
    </header>

    {{-- ---------------------------------------------------------------- rail --}}
    <aside class="atlas__rail" id="rail">
        <section class="rail-section">
            <div class="panel-title">View presets</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px" id="presets">
                <button class="chip is-active" data-preset="runtime">Runtime</button>
                <button class="chip" data-preset="architecture">Code</button>
                <button class="chip" data-preset="data">Data</button>
                <button class="chip" data-preset="all">Everything</button>
            </div>
            <p class="inset-note" id="preset-note">Runtime view hides scaffolding, tests and packages so the request journey stays legible.</p>
        </section>

        <section class="rail-section">
            <div class="panel-title">Layers <span id="layer-total"></span></div>
            <div class="rail-list" id="layer-list"></div>
        </section>

        <section class="rail-section">
            <div class="panel-title">Node types</div>
            <div class="rail-list" id="type-list"></div>
        </section>

        <section class="rail-section">
            <div class="panel-title">Modules</div>
            <div class="rail-list" id="module-list"></div>
        </section>

        <section class="rail-section">
            <div class="panel-title">Relationships</div>
            <div class="rail-list" id="edge-list"></div>
        </section>

        <section class="rail-section">
            <div class="panel-title">Scan</div>
            <div class="metric-grid" id="metric-grid"></div>
            <div style="display:flex;gap:8px;margin-top:10px">
                <form method="POST" action="{{ route('projects.rescan', $project) }}" style="flex:1">
                    @csrf
                    <button class="btn btn--sm" style="width:100%">Rescan</button>
                </form>
                <a class="btn btn--sm btn--ghost" style="flex:1;justify-content:center" href="{{ route('projects.show', $project) }}">Report</a>
            </div>
        </section>
    </aside>

    {{-- --------------------------------------------------------------- stage --}}
    <main class="atlas__stage" id="stage">
        <canvas id="scene"></canvas>

        <div class="stage-overlay">
            <div class="hud-row">
                <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-start">
                    <div class="hud-pill" id="camera-hint">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18M3 12h18"/></svg>
                        Drag to orbit · scroll to zoom · click a node
                    </div>
                </div>
                <canvas class="minimap" id="minimap" width="380" height="380"></canvas>
            </div>

            <div class="hud-row" style="align-items:flex-end; flex-direction: column; gap: 10px">
                {{-- Rebuilding a layout means relaxing the graph and then animating
                     the nodes into place, so both phases report in from here. It
                     lives at the bottom of the stage, where nothing else sits. --}}
                <div class="layout-progress" id="layout-progress" hidden>
                    <div class="layout-progress__track">
                        <div class="layout-progress__bar" id="layout-progress-bar"></div>
                    </div>
                    <div class="layout-progress__text" id="layout-progress-text">Rebuilding layout…</div>
                </div>

                {{-- The legend sits low, where it never covers the top deck. --}}
                <div class="legend" id="legend"></div>

                <div style="display:flex;align-items:flex-end;gap:10px;width:100%">
                <div class="trace-bar" id="trace-bar" hidden>
                    <span class="hud-pill" style="border:none;background:transparent;padding:0">Journey</span>
                    <div class="trace-steps" id="trace-steps"></div>
                    <button class="btn btn--sm btn--ghost" id="trace-exit">Exit</button>
                </div>
                <div style="display:flex;gap:10px;align-items:center;margin-left:auto">
                    <div class="hud-pill" id="fps-pill">– fps</div>
                </div>
                </div>
            </div>
        </div>

        <div class="tooltip" id="tooltip"></div>
    </main>

    {{-- ----------------------------------------------------------- inspector --}}
    <aside class="atlas__inspector" id="inspector">
        {{-- What the application in front of you is built on. Always visible:
             it is the first thing anyone asks of an unfamiliar codebase. --}}
        <section class="stack" id="stack" style="--stack-tint:{{ $stack['color'] }}">
            <div class="stack__head">
                <span class="stack__badge">{{ $project->language()->short() }}</span>
                <div>
                    <div class="stack__title">{{ $stack['headline'] }}</div>
                    <div class="stack__sub">{{ $project->displayName() }}</div>
                </div>
            </div>

            <div class="stack__grid">
                @foreach ($stack['items'] as $item)
                    <div class="stack__item">
                        <div class="stack__label">{{ $item['label'] }}</div>
                        <div class="stack__value">{{ $item['value'] }}</div>
                        @if (! empty($item['hint']))
                            <div class="stack__hint">{{ $item['hint'] }}</div>
                        @endif
                    </div>
                @endforeach
            </div>

            @if (! empty($stack['packages']))
                <div class="stack__packages">
                    <div class="stack__label">
                        {{ $stack['packages_label'] }}
                        @if ($stack['package_count'] > 0)
                            <span class="stack__count">{{ number_format($stack['package_count']) }}</span>
                        @endif
                    </div>
                    <div class="stack__chips">
                        @foreach ($stack['packages'] as $package)
                            <span class="stack__chip" title="{{ $package['name'] }}{{ $package['version'] ? ' '.$package['version'] : '' }}">
                                {{ $package['name'] }}@if ($package['version'])<b>{{ $package['version'] }}</b>@endif
                            </span>
                        @endforeach
                        @if ($stack['package_count'] > count($stack['packages']))
                            <span class="stack__chip stack__chip--more">+{{ number_format($stack['package_count'] - count($stack['packages'])) }} more</span>
                        @endif
                    </div>
                </div>
            @endif
        </section>

        <div class="tabs">
            <button class="tab is-active" data-tab="details">Details</button>
            <button class="tab" data-tab="links">Connections</button>
            <button class="tab" data-tab="source">Source</button>
            <button class="tab" data-tab="insights">Insights</button>
        </div>

        <div data-panel="details" id="panel-details">
            <div class="empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="9"/><path d="M12 8v5l3 2"/></svg>
                <div>Select a node in the atlas to inspect it.</div>
            </div>
        </div>

        <div data-panel="links" id="panel-links" hidden></div>
        <div data-panel="source" id="panel-source" hidden></div>
        <div data-panel="insights" id="panel-insights" hidden></div>

        {{-- ------------------------------------------------------- assistant --
             The same column as the inspector's tabs: the toolbar toggles
             between reading the graph and asking about it, so the map keeps
             its width. Everything here is filled by resources/js/atlas/ai.js. --}}
        <section class="ai" id="ai-panel" hidden>
            <header class="ai__head">
                <div>
                    <div class="panel-title" style="margin:0;white-space:nowrap">Ask this project</div>
                    <div class="ai__model-label"><span id="ai-model-label"></span></div>
                </div>
                <div class="ai__head-actions">
                    <select class="select select--sm" id="ai-model" hidden title="Model"></select>
                    <button class="btn btn--sm btn--ghost" id="ai-clear" type="button" title="Start a new conversation">Clear</button>
                </div>
            </header>

            <div class="ai__status" id="ai-status" hidden></div>

            <div class="ai__log" id="ai-log"></div>

            <form class="ai__composer" id="ai-form">
                <textarea class="ai__input" id="ai-input" rows="1" placeholder="Ask what this code does…" autocomplete="off"></textarea>
                <div class="ai__composer-row">
                    <span class="ai__hint">Enter to send · Shift + Enter for a new line</span>
                    <button class="btn btn--sm btn--ghost" id="ai-stop" type="button" hidden>Stop</button>
                    <button class="btn btn--sm btn--primary" id="ai-send" type="submit">Ask</button>
                </div>
            </form>
        </section>

        <section class="rail-section" style="margin-top:auto">
            {{-- The options are filled from the graph by the client; this is the empty state. --}}
            {{-- A project with routes is traced by request; one without is traced
                 from where execution starts. That is a property of the graph,
                 so it is asked of the graph rather than guessed from the language. --}}
            <div class="panel-title">{{ $hasRoutes ? 'Trace a request' : 'Trace execution' }}</div>
            {{-- `data-empty-note` is what the panel says when the dropdown has
                 nothing in it at all: no routes *and* no entry point. Without it
                 the note above would keep promising journeys the graph cannot
                 offer. --}}
            <select class="select" id="trace-select" data-language="{{ $project->language }}" data-empty-note="{{ $traceEmptyNote }}">
                <option value="">{{ $hasRoutes ? 'Choose a route…' : 'Choose an entry point…' }}</option>
            </select>
            <p class="inset-note" style="margin-top:10px">
                @if ($project->language === 'php')
                    Highlights the exact chain a request follows: entry route → middleware → controller →
                    services and jobs → database tables.
                @elseif ($project->language === 'csharp')
                    Highlights the exact chain a request follows: ASP.NET route → controller or endpoint →
                    the services it calls → the data it touches.
                @elseif ($project->language === 'python' && $hasRoutes)
                    Django, Flask and FastAPI routes trace like Laravel's: URL → view → service → model →
                    template. This one has a route table, so pick a URL above and the whole chain lights up.
                @elseif ($project->language === 'python')
                    A plain script has no routes, so the journey starts where execution does — from
                    <span class="mono">manage.py</span>, <span class="mono">main.py</span> or the file with
                    the <span class="mono">__main__</span> guard — and lights up every function and class it
                    calls on the way.
                @else
                    A compiled program has no route table, so the journey starts where execution does: from
                    <span class="mono">main()</span> or an executable target, the chain lights up through
                    every function and class it calls.
                @endif
            </p>
        </section>
    </aside>

    {{-- ---------------------------------------------------- scanning overlay --}}
    <div class="scan-overlay" id="scan-overlay" hidden>
        <div class="scan-overlay__card">
            <div class="scan-overlay__head">
                <div style="display:flex;gap:18px;align-items:flex-start">
                    <div class="radar"></div>
                    <div>
                        <h2 style="margin-bottom:4px" id="scan-title">Scanning your application</h2>
                        <p style="margin:0" id="scan-subtitle">{{ $project->displayName() }} · {{ $project->language === 'php' ? ($project->framework_version ? 'Laravel '.$project->framework_version : 'Laravel') : $project->language()->label() }}</p>
                    </div>
                </div>
                <div style="text-align:right">
                    <div style="font-size:1.8rem;font-weight:650" id="scan-percent">0%</div>
                    <div class="stat__label" id="scan-stage-label">Starting…</div>
                </div>
            </div>

            <div class="progress" style="margin-bottom:18px"><div class="progress__bar" id="scan-progress" style="width:0%"></div></div>

            <p class="scan-hint mono" id="scan-hint" hidden></p>

            <div class="two-col">
                <div>
                    <div class="panel-title">Pipeline</div>
                    <div class="pipeline" id="scan-stages"></div>
                </div>
                <div>
                    <div class="panel-title">Live log</div>
                    <div class="log" id="scan-log"></div>
                </div>
            </div>

            <div style="display:flex;gap:10px;margin-top:20px">
                <a class="btn btn--ghost btn--sm" href="{{ route('home') }}">Back to projects</a>
                <span class="spacer"></span>
                <button class="btn btn--primary btn--sm" id="scan-reload" hidden>Open the atlas</button>
            </div>
        </div>
    </div>
</div>
@endsection
