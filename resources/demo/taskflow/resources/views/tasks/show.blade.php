@extends('layouts.app')

@section('title', $task->title)

@section('content')
    <div class="flex items-start justify-between">
        <div>
            <h1 class="text-2xl font-semibold">{{ $task->title }}</h1>
            <p class="mt-1 text-sm text-slate-500">
                {{ $task->project->name }} · {{ $task->assignee?->name ?? 'Unassigned' }}
            </p>
        </div>

        <div class="flex gap-2">
            <x-badge :color="$task->status->value === 'done' ? 'emerald' : 'amber'">
                {{ $task->status->label() }}
            </x-badge>
            @can('update', $task)
                <a href="{{ route('tasks.edit', $task) }}" class="rounded-lg border px-3 py-1.5 text-sm">Edit</a>
            @endcan
        </div>
    </div>

    <div class="mt-6 rounded-xl border border-slate-200 bg-white p-6">
        <p class="whitespace-pre-line text-sm text-slate-700">{{ $task->description }}</p>
    </div>

    <div class="mt-6 flex gap-2">
        @foreach ($task->tags as $tag)
            <x-badge :color="'sky'">{{ $tag->name }}</x-badge>
        @endforeach
    </div>

    <h2 class="mt-10 text-lg font-semibold">Comments</h2>
    @include('tasks.partials.comments', ['comments' => $task->comments])

    <form method="POST" action="{{ route('tasks.complete', $task) }}" class="mt-8">
        @csrf
        <button class="rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white">Mark complete</button>
    </form>
