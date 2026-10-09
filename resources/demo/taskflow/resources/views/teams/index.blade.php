@extends('layouts.app')

@section('title', 'Teams')

@section('content')
    <h1 class="text-2xl font-semibold">Teams</h1>

    <div class="mt-6 space-y-3">
        @foreach ($teams as $team)
            <div class="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-4">
                <div>
                    <p class="font-medium">{{ $team->name }}</p>
                    <p class="text-xs text-slate-500">{{ $team->members->count() }} members · {{ $team->plan }}</p>
                </div>
                <x-badge :color="$team->isOnPaidPlan() ? 'emerald' : 'slate'">{{ $team->plan }}</x-badge>
            </div>
        @endforeach
    </div>
