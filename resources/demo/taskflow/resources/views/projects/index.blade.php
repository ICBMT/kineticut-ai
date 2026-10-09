@extends('layouts.app')

@section('title', 'Projects')

@section('content')
    <h1 class="text-2xl font-semibold">Projects</h1>

    <div class="mt-6 grid grid-cols-3 gap-4">
        @foreach ($projects as $project)
            <a href="{{ route('projects.show', $project) }}" class="rounded-xl border border-slate-200 bg-white p-5">
                <p class="font-medium">{{ $project->name }}</p>
                <p class="mt-1 text-sm text-slate-500">{{ $project->tasks_count }} tasks</p>
                <p class="mt-3 text-xs text-slate-400">Owned by {{ $project->owner->name }}</p>
            </a>
        @endforeach
    </div>
