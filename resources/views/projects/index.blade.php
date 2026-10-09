@extends('layouts.base')

@section('title', 'AtlasScope — map any codebase in 3D')

@section('content')
<div class="topbar">
    <a href="{{ route('home') }}" class="brand">
        <span class="brand__mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="#06101f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5"/><path d="M12 12v10"/>
            </svg>
        </span>
        <span>
            AtlasScope
            <small>Architecture observatory</small>
        </span>
    </a>
    <div class="spacer"></div>
    <span class="hud-pill">{{ number_format($totals['projects']) }} {{ Str::plural('project', $totals['projects']) }} · {{ number_format($totals['nodes']) }} nodes mapped</span>
</div>

<div class="shell">
    @if ($errors->any())
        <div class="flash flash--error">
            @foreach ($errors->all() as $error)
                <div>{{ $error }}</div>
            @endforeach
        </div>
    @endif

    @if (session('status'))
        <div class="flash">{{ session('status') }}</div>
    @endif

    @if ($errors->any())
        <div class="errors">
            @foreach ($errors->all() as $error)
                <div>{{ $error }}</div>
            @endforeach
        </div>
    @endif

    <section class="hero">
        <div>
            <span class="eyebrow">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M13 2 3 14h7l-1 8 10-12h-7z"/></svg>
                Laravel · C++ · C# · Python · AST powered · 3D
            </span>
            <h1>See your whole codebase as one explorable 3D map.</h1>
            <p class="lede">
                Point AtlasScope at a project archive — a Laravel app, a CMake or Visual Studio C++
                project, a .NET solution, or a Django, Flask or FastAPI one — and it parses every
                route, controller, model, class, function and build target, then draws the whole thing
                as a living, colour-coded structure you can fly through. No configuration, no
                instrumentation, no database connection needed.
            </p>

            <div class="hero-actions">
                <form method="POST" action="{{ route('projects.demo') }}">
                    @csrf
                    <button type="submit" class="btn btn--primary">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 3l14 9-14 9V3z"/></svg>
                        Explore the sample project
                    </button>
                </form>
                <a href="#upload" class="btn btn--ghost">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 16V4m0 0L7 9m5-5 5 5M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
                    Upload my project
                </a>
            </div>

            <ul class="hero-points">
                <li>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>
                    <span><b>Real route table.</b> Group prefixes, middleware stacks, resource routes and controller actions are reconstructed the way the framework resolves them.</span>
                </li>
                <li>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>
                    <span><b>Trace any request journey.</b> Pick a route and watch the flow run through middleware, controller, service, job and finally the table it writes to.</span>
                </li>
                <li>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>
                    <span><b>Readability first.</b> Layers float as separate decks, related files cluster together, and every node opens with its methods, columns and neighbours.</span>
                </li>
            </ul>

            <div class="stat-strip">
                <div class="stat">
                    <div class="stat__value">{{ number_format($totals['nodes']) }}</div>
                    <div class="stat__label">Nodes mapped</div>
                </div>
                <div class="stat">
                    <div class="stat__value">{{ number_format($totals['edges']) }}</div>
                    <div class="stat__label">Relationships</div>
                </div>
                <div class="stat">
                    <div class="stat__value">{{ $demoFiles }}</div>
                    <div class="stat__label">Demo files ready</div>
                </div>
            </div>
        </div>

        <div class="orb-card">
            <div class="orb-card__grid"></div>
            <div class="orb-card__content">
                <div class="panel-title">Scanning pipeline</div>
                @foreach (\App\Enums\ScanStage::pipeline() as $index => $stage)
                    <div class="stage {{ $index < 3 ? 'is-done' : 'is-pending' }}">
                        <span class="stage__dot">{{ str_pad((string) ($index + 1), 2, '0', STR_PAD_LEFT) }}</span>
                        <span>{{ $stage->label() }}</span>
                        <span class="stage__ms">{{ $index < 3 ? 'done' : '' }}</span>
                    </div>
                @endforeach
                <p class="inset-note" style="margin-top:16px">
                    Eleven stages run in order. Each one writes an artefact to disk, so you can inspect
                    exactly what the scanner understood about your code.
                </p>
            </div>
        </div>
    </section>

    <section id="upload" class="two-col" style="margin-bottom:34px">
        <div class="card">
            <div class="panel-title">Upload a project archive</div>
            <form method="POST" action="{{ route('projects.store') }}" enctype="multipart/form-data"
                  id="upload-form"
                  data-max-bytes="{{ $upload['ceiling'] }}"
                  data-php-max-bytes="{{ $upload['max_bytes'] }}"
                  data-capacity-url="{{ $upload['capacity_url'] }}"
                  data-uploads-url="{{ url('/uploads') }}">
                @csrf
                <label class="dropzone" id="dropzone">
                    <input type="file" name="archive" id="archive-input" accept=".zip" required>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
                    <div style="font-weight:600">Drop your project .zip here</div>
                    <div class="dropzone__hint" id="dropzone-hint">or click to choose a file — the folder with composer.json / artisan, CMakeLists.txt, or a .sln / .csproj</div>
                    <div class="dropzone__limit" id="dropzone-limit">
                        Up to <b>{{ $upload['ceiling_human'] }}</b> per archive
                        @if ($upload['constrained_by_php'])
                            · set by PHP here (<span class="mono">upload_max_filesize&nbsp;=&nbsp;{{ $upload['upload_max_filesize'] }}</span>,
                            <span class="mono">post_max_size&nbsp;=&nbsp;{{ $upload['post_max_size'] }}</span>)
                        @endif
                    </div>
                </label>

                @if ($upload['constrained_by_php'])
                    <p class="inset-note inset-note--warn" style="margin-top:12px">
                        <strong>Zip your project without <span class="mono">vendor/</span> and
                        <span class="mono">node_modules/</span></strong> — the scanner reads your source and
                        <span class="mono">composer.json</span>, and never needs installed dependencies. That usually
                        takes a 60 MB archive down to a couple of MB:
                        <br><span class="mono" style="display:inline-block;margin-top:6px">zip -r project.zip . -x "vendor/*" -x "node_modules/*" -x ".git/*"</span>
                        <br><br>
                        Archives bigger than the PHP limit shown above are
                        <strong>streamed to the server in pieces</strong>, which sidesteps
                        <span class="mono">upload_max_filesize</span> and
                        <span class="mono">post_max_size</span> entirely — a stock PHP install takes a
                        full {{ $upload['app_max_human'] }} archive this way, so you never have to touch
                        <span class="mono">php.ini</span> or restart anything. Prefer the limits themselves
                        raised too? <span class="mono">{{ $upload['raise_command'] }}</span> does that.
                    </p>
                @endif

                <div class="field" style="margin-top:16px">
                    <label for="name">Display name (optional)</label>
                    <input class="input" type="text" name="name" id="name" placeholder="e.g. Acme Billing API" value="{{ old('name') }}">
                </div>

                <div class="upload-progress" id="upload-progress" hidden>
                    <div class="upload-progress__track">
                        <div class="upload-progress__bar" id="upload-progress-bar"></div>
                    </div>
                    <div class="upload-progress__text" id="upload-progress-text">Preparing…</div>
                </div>

                <p class="flash flash--error" id="upload-error" hidden></p>

                <button type="submit" class="btn btn--primary" id="upload-submit">Scan this project</button>
                <p class="inset-note" style="margin-top:14px">
                    Archives are unpacked into private storage and only ever statically analysed — no code is executed.
                </p>
            </form>
        </div>

        <div class="card">
            <div class="panel-title">What you get</div>
            <div class="grid grid--2">
                <div class="metric"><div class="metric__value">3D</div><div class="metric__label">Layered atlas</div></div>
                <div class="metric"><div class="metric__value">ERD</div><div class="metric__label">Schema from migrations</div></div>
                <div class="metric"><div class="metric__value">Flow</div><div class="metric__label">Request tracer</div></div>
                <div class="metric"><div class="metric__value">Review</div><div class="metric__label">Architecture insights</div></div>
            </div>
            <p style="margin-top:16px" class="inset-note">
                Laravel projects contribute routes, controllers, middleware, form requests, API resources,
                policies, models, services, jobs, events, Blade views, migrations, tables and composer
                packages. C++ and C# projects contribute namespaces, classes, interfaces, structs, records,
                enums, free functions, executables, libraries, NuGet packages, CMake targets and — for
                ASP.NET — controllers, endpoints and routes, so the same journey tracing works there too.
                Python projects contribute modules, classes, functions, protocols, Django models and
                migrations, urlpatterns, Flask and FastAPI decorators, DRF viewsets and serializers,
                templates and Poetry or pip dependencies — a Django app traces its request journeys the
                same way a Laravel one does, and a plain script trades the route table for its entry
                points.
            </p>
        </div>
    </section>

    <section>
        <div class="panel-title" style="font-size:0.8rem">
            <span>Projects</span>
            <span>{{ $projects->count() }} mapped</span>
        </div>

        @if ($projects->isEmpty())
            <div class="card empty">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/></svg>
                <div>No projects yet — upload an archive or open the bundled sample.</div>
            </div>
        @else
            <div class="grid grid--3">
                @foreach ($projects as $project)
                    @php($scan = $project->latestScan)
                    <article class="card project-card fade-in">
                        <div class="project-card__head">
                            <div>
                                <h3 style="margin-bottom:2px">{{ $project->displayName() }}</h3>
                                <div style="font-size:0.76rem;color:var(--text-faint)">
                                    {{-- "Python · Django 5.0.6" for a Django app, plain
                                         "Python 3.11" for a script — never "Python · Python". --}}
                                    {{ $project->stackLine() }}
                                    · {{ $project->sizeForHumans() }}
                                    · {{ number_format($project->file_count) }} files
                                </div>
                            </div>
                            <span class="badge badge--status-{{ optional($scan)->status?->value ?? 'queued' }}">
                                {{ optional($scan)->status?->label() ?? 'Queued' }}
                            </span>
                        </div>

                        <div class="project-card__meta">
                            <span class="badge badge--language" style="--badge-tint:{{ $project->language()->color() }}">{{ $project->language()->short() }}</span>
                            @if ($project->source_type === 'demo')
                                <span class="badge badge--demo">Sample</span>
                            @endif
                            @if ($project->loc)
                                <span class="badge badge--layer">{{ number_format($project->loc) }} LOC</span>
                            @endif
                            @if ($project->package_count)
                                <span class="badge badge--layer">{{ $project->package_count }} packages</span>
                            @endif
                            @if ($scan)
                                <span class="badge badge--layer">{{ number_format($scan->node_count) }} nodes</span>
                                <span class="badge badge--layer">{{ number_format($scan->edge_count) }} edges</span>
                            @endif
                        </div>

                        @if ($scan && $scan->status->value === 'running')
                            <div class="progress"><div class="progress__bar" style="width: {{ $scan->progress }}%"></div></div>
                            <div style="font-size:0.78rem;color:var(--text-faint)">
                                {{ $scan->stageEnum()->label() }} — {{ $scan->progress }}%
                            </div>
                        @endif

                        <div style="display:flex;gap:8px;margin-top:auto;flex-wrap:wrap">
                            <a href="{{ route('projects.atlas', $project) }}" class="btn btn--sm btn--primary">
                                {{ $scan && $scan->status->value === 'completed' ? 'Open atlas' : 'View scan' }}
                            </a>
                            <a href="{{ route('projects.show', $project) }}" class="btn btn--sm btn--ghost">Details</a>
                            <form method="POST" action="{{ route('projects.rescan', $project) }}" style="margin-left:auto">
                                @csrf
                                <button class="btn btn--sm btn--ghost" title="Scan again">Rescan</button>
                            </form>
                        </div>
                    </article>
                @endforeach
            </div>
        @endif
    </section>
</div>
@endsection
