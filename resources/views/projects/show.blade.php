@extends('layouts.base')

@section('title', $project->displayName().' — AtlasScope')

@section('content')
<div class="topbar">
    <a href="{{ route('home') }}" class="brand">
        <span class="brand__mark">
            <svg viewBox="0 0 24 24" fill="none" stroke="#06101f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5"/><path d="M12 12v10"/>
            </svg>
        </span>
        <span>AtlasScope<small>Project report</small></span>
    </a>
    <div class="spacer"></div>
    <a href="{{ route('projects.atlas', $project) }}" class="btn btn--sm btn--primary">Open 3D atlas</a>
</div>

<div class="shell">
    @php($scan = $project->scans->first())

    <div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:24px">
        <div>
            <h1 style="font-size:1.9rem;margin-bottom:6px">{{ $project->displayName() }}</h1>
            <p style="margin:0">
                @if ($project->language === 'php')
                    {{ $project->composer_name ?: 'Laravel project' }}
                    @if ($project->framework_version) · Laravel {{ $project->framework_version }} @endif
                @else
                    {{ $project->stackLine() }}
                @endif
                · {{ $project->sizeForHumans() }} · scanned {{ optional($project->last_scanned_at)->diffForHumans() ?? 'never' }}
            </p>
        </div>
        <div class="spacer"></div>
        <form method="POST" action="{{ route('projects.rescan', $project) }}">
            @csrf
            <button class="btn btn--sm">Rescan project</button>
        </form>
        <a class="btn btn--sm" href="{{ route('api.atlas.export', $project) }}">Export JSON</a>
        <form method="POST" action="{{ route('projects.destroy', $project) }}" onsubmit="return confirm('Delete this project and its scanned sources?')">
            @csrf @method('DELETE')
            <button class="btn btn--sm btn--danger">Delete</button>
        </form>
    </div>

    <div class="grid grid--4" style="margin-bottom:26px">
        <div class="card card--tight"><div class="metric"><div class="metric__value">{{ number_format($scan->file_count ?? 0) }}</div><div class="metric__label">Files indexed</div></div></div>
        <div class="card card--tight"><div class="metric"><div class="metric__value">{{ number_format($project->loc) }}</div><div class="metric__label">Lines of code</div></div></div>
        <div class="card card--tight"><div class="metric"><div class="metric__value">{{ number_format($scan->node_count ?? 0) }}</div><div class="metric__label">Graph nodes</div></div></div>
        <div class="card card--tight"><div class="metric"><div class="metric__value">{{ number_format($scan->edge_count ?? 0) }}</div><div class="metric__label">Relationships</div></div></div>
    </div>

    <div class="two-col">
        <div class="card">
            <div class="panel-title">Scan history</div>
            <div class="table-scroll"><table class="table-simple">
                <thead>
                    <tr><th>#</th><th>Status</th><th>Nodes</th><th>Edges</th><th>Duration</th><th>When</th></tr>
                </thead>
                <tbody>
                    @forelse ($project->scans as $run)
                        <tr>
                            <td class="mono">{{ $run->id }}</td>
                            <td><span class="badge badge--status-{{ $run->status->value }}">{{ $run->status->label() }}</span></td>
                            <td class="mono">{{ number_format($run->node_count) }}</td>
                            <td class="mono">{{ number_format($run->edge_count) }}</td>
                            <td class="mono">{{ number_format($run->duration_ms) }} ms</td>
                            <td>{{ optional($run->created_at)->diffForHumans() }}</td>
                        </tr>
                    @empty
                        <tr><td colspan="6">No scans yet.</td></tr>
                    @endforelse
                </tbody>
            </table></div>
        </div>

        <div class="card">
            <div class="panel-title">Composition</div>
            @php($byType = $scan->metrics['class_types'] ?? [])

            {{-- The names are spoken in the project's own language: a Django
                 model is a Model, not an Eloquent Model. --}}
            @if ($byType)
                <div class="table-scroll"><table class="table-simple">
                    <tbody>
                        @foreach ($byType as $type => $count)
                            <tr>
                                <td>{{ \App\Enums\NodeType::tryFrom($type)?->label($project->language()) ?? ucfirst(str_replace('_', ' ', $type)) }}</td>
                                <td class="mono" style="text-align:right">{{ number_format($count) }}</td>
                            </tr>
                        @endforeach
                    </tbody>
                </table></div>
            @else
                <p class="inset-note">
                    @if ($scan === null)
                        Run a scan to see how the application is composed.
                    @else
                        This project declares no classes, so there is nothing to break down yet.
                    @endif
                </p>
            @endif
        </div>
    </div>

    @if (($scan->metrics['insights']['total'] ?? 0) > 0)
        <div class="card" style="margin-top:18px">
            <div class="panel-title">
                <span>Architectural insights</span>
                <span>{{ $scan->metrics['insights']['total'] }} findings</span>
            </div>
            <div class="grid grid--2">
                @foreach (($scan->metrics['insights']['by_severity'] ?? []) as $severity => $count)
                    <div class="insight insight--{{ $severity }}">
                        <div class="insight__cat">{{ $severity }} priority</div>
                        <div class="insight__title">{{ $count }} finding{{ $count === 1 ? '' : 's' }}</div>
                    </div>
                @endforeach
            </div>
            <p class="inset-note" style="margin-top:14px">Open the atlas to see each finding highlighted in the graph.</p>
        </div>
    @endif
</div>
@endsection
