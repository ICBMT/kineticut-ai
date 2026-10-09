@extends('layouts.app')

@section('title', 'Sign in')

@section('content')
    <form method="POST" action="{{ route('login') }}" class="mx-auto mt-12 max-w-md rounded-xl border border-slate-200 bg-white p-8">
        @csrf

        <h1 class="text-xl font-semibold">Sign in</h1>

        <div class="mt-6 space-y-4">
            <input name="email" type="email" placeholder="Email" class="w-full rounded-lg border border-slate-300 px-3 py-2">
            <input name="password" type="password" placeholder="Password" class="w-full rounded-lg border border-slate-300 px-3 py-2">
        </div>

        @error('email') <p class="mt-2 text-xs text-rose-600">{{ $message }}</p> @enderror

        <button class="mt-6 w-full rounded-lg bg-slate-900 px-4 py-2 text-sm text-white">Continue</button>
    </form>
