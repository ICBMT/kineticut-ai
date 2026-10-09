@props(['type' => 'info'])

@php
    $styles = [
        'success' => 'border-emerald-300 bg-emerald-50 text-emerald-800',
        'error' => 'border-rose-300 bg-rose-50 text-rose-800',
        'info' => 'border-sky-300 bg-sky-50 text-sky-800',
    ];
@endphp

<div {{ $attributes->merge(['class' => 'mb-6 rounded-lg border px-4 py-3 '.$styles[$type]]) }} role="alert">
    {{ $slot }}
</div>
