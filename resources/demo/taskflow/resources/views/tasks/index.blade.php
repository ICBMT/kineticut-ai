@extends('layouts.app')

@section('title', 'Tasks')

@section('content')
    <div class="flex items-center justify-between">
        <h1 class="text-2xl font-semibold">Tasks</h1>
        <a href="{{ route('tasks.create') }}" class="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">New task</a>
    </div>

    <livewire:task-table />

    <div class="mt-6">
        {{ $tasks->links() }}
    </div>
