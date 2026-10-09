@extends('layouts.app')

@section('title', 'Edit task')

@section('content')
    <h1 class="text-2xl font-semibold">Edit task</h1>

    <form method="POST" action="{{ route('tasks.update', $task) }}" class="mt-6 max-w-xl rounded-xl border border-slate-200 bg-white p-6">
        @csrf
        @method('PUT')

        @include('tasks.partials.form', ['task' => $task, 'projects' => \App\Models\Project::active()->get()])

        <button class="mt-6 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">Save changes</button>
    </form>
