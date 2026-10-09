@extends('layouts.app')

@section('title', 'New task')

@section('content')
    <h1 class="text-2xl font-semibold">New task</h1>

    <form method="POST" action="{{ route('tasks.store') }}" class="mt-6 max-w-xl rounded-xl border border-slate-200 bg-white p-6">
        @csrf
        @include('tasks.partials.form', ['task' => null, 'projects' => \App\Models\Project::active()->get()])

        <button class="mt-6 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">Create task</button>
    </form>
