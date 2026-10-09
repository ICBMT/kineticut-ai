@extends('layouts.app')

@section('title', 'Dashboard')

@section('content')
    <h1 class="text-2xl font-semibold">Good to see you, {{ auth()->user()->name }}</h1>

    <div class="mt-6 grid grid-cols-4 gap-4">
        @foreach (['open' => 'Open', 'overdue' => 'Overdue', 'completed_this_week' => 'Done this week', 'focus_minutes' => 'Focus minutes'] as $key => $label)
            <div class="rounded-xl border border-slate-200 bg-white p-4">
                <p class="text-xs uppercase tracking-wide text-slate-500">{{ $label }}</p>
                <p class="mt-1 text-2xl font-semibold">{{ $summary[$key] }}</p>
            </div>
        @endforeach
    </div>

    <h2 class="mt-10 text-lg font-semibold">My tasks</h2>
    <div class="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table class="w-full text-sm">
            <thead class="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                    <th class="px-4 py-3">Task</th>
                    <th class="px-4 py-3">Project</th>
                    <th class="px-4 py-3">Assignee</th>
                    <th class="px-4 py-3">Due</th>
                </tr>
            </thead>
            <tbody>
                @forelse ($rows as $row)
                    <tr class="border-t border-slate-100">
                        <td class="px-4 py-3 font-medium">{{ $row['title'] }}</td>
                        <td class="px-4 py-3">{{ $row['project'] }}</td>
                        <td class="px-4 py-3">{{ $row['assignee'] ?? 'Unassigned' }}</td>
                        <td class="px-4 py-3">
                            @if ($row['overdue'])
                                <x-badge color="rose">{{ $row['due'] }}</x-badge>
                            @else
                                {{ $row['due'] }}
                            @endif
                        </td>
                    </tr>
                @empty
                    <tr><td colspan="4" class="px-4 py-6 text-center text-slate-500">Nothing due. Enjoy the quiet.</td></tr>
                @endforelse
            </tbody>
        </table>
    </div>

    <h2 class="mt-10 text-lg font-semibold">Active projects</h2>
    <div class="mt-3 grid grid-cols-3 gap-4">
        @foreach ($projects as $project)
            <a href="{{ route('projects.show', $project) }}" class="rounded-xl border border-slate-200 bg-white p-4 hover:border-slate-300">
                <p class="font-medium">{{ $project->name }}</p>
                <p class="mt-1 text-xs text-slate-500">{{ $project->tasks->count() }} tasks</p>
            </a>
        @endforeach
    </div>
