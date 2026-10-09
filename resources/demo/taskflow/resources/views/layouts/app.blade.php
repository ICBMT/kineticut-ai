<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{{ config('app.name') }} — @yield('title', 'Dashboard')</title>
    @vite(['resources/css/app.css', 'resources/js/app.js'])
</head>
<body class="bg-slate-50 text-slate-900">
    @include('layouts.navigation')

    <main class="mx-auto max-w-6xl px-6 py-10">
        @if (session('status'))
            <x-alert type="success">{{ session('status') }}</x-alert>
        @endif

        @yield('content')
    </main>
</body>
</html>
