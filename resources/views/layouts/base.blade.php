<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <meta name="color-scheme" content="dark">
    <title>@yield('title', 'AtlasScope — see your application in 3D')</title>
    <meta name="description" content="AtlasScope scans a Laravel, C++, C# or Python project and turns it into an explorable 3D map of routes, controllers, models, classes, namespaces, build targets and database tables.">
    <link rel="icon" href="{{ asset('favicon.svg') }}" type="image/svg+xml">
    @vite(['resources/css/app.css', 'resources/js/app.js'])
    @stack('head')
</head>
<body class="@yield('body-class')">
    @yield('content')
    @stack('scripts')
</body>
</html>
